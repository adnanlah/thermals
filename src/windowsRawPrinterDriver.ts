import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SystemPrinterDriver,
  SystemPrinterInfo
} from "./systemPrinterTypes";

type WindowsPrinterJson = {
  name?: string;
  status?: string;
  driverName?: string;
  portName?: string;
};

export function createWindowsRawPrinterDriver(): SystemPrinterDriver {
  return {
    getPrinters,
    getPrinter(printerName: string): SystemPrinterInfo | undefined {
      return getPrinters().find(
        (printer) =>
          printer.name?.toLocaleLowerCase() === printerName.toLocaleLowerCase()
      );
    },
    printDirect(options): void {
      printRaw(options).catch(options.error);
    }
  };
}

function getPrinters(): SystemPrinterInfo[] {
  ensureWindows();

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    getListPrintersScript()
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "PowerShell printer list failed.");
  }

  const stdout = result.stdout.trim();

  if (!stdout) {
    return [];
  }

  const printers = JSON.parse(stdout) as WindowsPrinterJson[];

  return printers.map((printer) => ({
    name: printer.name,
    status: printer.status,
    attributes: [
      "RAW-ONLY",
      printer.driverName ? `DRIVER:${printer.driverName}` : "",
      printer.portName ? `PORT:${printer.portName}` : ""
    ].filter(Boolean)
  }));
}

async function printRaw(options: {
  data: Buffer;
  printer: string;
  docname?: string | false;
  success(jobId: string | number): void;
  error(error: unknown): void;
}): Promise<void> {
  ensureWindows();

  const directory = await mkdtemp(join(tmpdir(), "thermal-raw-"));
  const dataPath = join(directory, `${randomUUID()}.bin`);

  try {
    await writeFile(dataPath, options.data);

    const result = await runPowerShell(getRawPrintScript({
      printerName: options.printer,
      dataPath,
      documentName: options.docname || "Thermal Receipt"
    }));

    options.success(result.trim() || "RAW print job submitted");
  } catch (error) {
    options.error(error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

function getListPrintersScript(): string {
  return String.raw`
$ErrorActionPreference = "Stop"
try {
  if (Get-Command Get-Printer -ErrorAction SilentlyContinue) {
    $printers = Get-Printer | Select-Object Name, PrinterStatus, DriverName, PortName
  }
} catch {
  $printers = $null
}

if ($null -eq $printers) {
  try {
    $printers = Get-CimInstance Win32_Printer | Select-Object Name, PrinterStatus, DriverName, PortName
  } catch {
    $printers = $null
  }
}

if ($null -eq $printers) {
  $registryPrinters = @()

  try {
    $devicesKey = Get-Item "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Devices" -ErrorAction Stop
    foreach ($name in $devicesKey.GetValueNames()) {
      $registryPrinters += [PSCustomObject]@{
        Name = $name
        PrinterStatus = "Registry"
        DriverName = ""
        PortName = "$($devicesKey.GetValue($name))"
      }
    }
  } catch {}

  try {
    foreach ($key in Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers" -ErrorAction Stop) {
      if ($registryPrinters.Name -notcontains $key.PSChildName) {
        $registryPrinters += [PSCustomObject]@{
          Name = $key.PSChildName
          PrinterStatus = "Registry"
          DriverName = ""
          PortName = ""
        }
      }
    }
  } catch {}

  $printers = $registryPrinters
}

@($printers | ForEach-Object {
  [PSCustomObject]@{
    name = $_.Name
    status = "$($_.PrinterStatus)"
    driverName = "$($_.DriverName)"
    portName = "$($_.PortName)"
  }
}) | ConvertTo-Json -Depth 4 -Compress
`;
}

function getRawPrintScript(options: {
  printerName: string;
  dataPath: string;
  documentName: string;
}): string {
  // The C# helper calls the Windows spooler directly with datatype RAW,
  // matching the driver contract expected by node-thermal-printer.
  return String.raw`
$ErrorActionPreference = "Stop"
$PrinterName = ${toPowerShellString(options.printerName)}
$DataPath = ${toPowerShellString(options.dataPath)}
$DocumentName = ${toPowerShellString(options.documentName)}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDataType;
  }

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOC_INFO_1 di);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  public static int SendBytes(string printerName, string dataPath, string documentName) {
    IntPtr printerHandle;
    if (!OpenPrinter(printerName, out printerHandle, IntPtr.Zero)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    }

    try {
      DOC_INFO_1 docInfo = new DOC_INFO_1();
      docInfo.pDocName = documentName;
      docInfo.pOutputFile = null;
      docInfo.pDataType = "RAW";

      int jobId = StartDocPrinter(printerHandle, 1, docInfo);
      if (jobId == 0) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      }

      try {
        if (!StartPagePrinter(printerHandle)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
        }

        try {
          byte[] bytes = File.ReadAllBytes(dataPath);
          int written;
          if (!WritePrinter(printerHandle, bytes, bytes.Length, out written)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed");
          }
          if (written != bytes.Length) {
            throw new Exception("WritePrinter wrote " + written + " of " + bytes.Length + " bytes.");
          }
        } finally {
          EndPagePrinter(printerHandle);
        }
      } finally {
        EndDocPrinter(printerHandle);
      }

      return jobId;
    } finally {
      ClosePrinter(printerHandle);
    }
  }
}
"@

[RawPrinterHelper]::SendBytes($PrinterName, $DataPath, $DocumentName)
`;
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ensureWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("The built-in raw system-printer driver only works on Windows.");
  }
}
