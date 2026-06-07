import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ArabicReceipt } from "./arabicReceipt";
import {
  ArabicBitmapPrinterConfig,
  arabicBitmapPrinterConfig,
  SystemPrinterConfig,
  systemPrinterConfig
} from "./config";

type BitmapReceiptLine =
  | {
      kind: "text";
      text: string;
      size: number;
      bold: boolean;
      align: "center" | "right";
      top: number;
      bottom: number;
    }
  | {
      kind: "separator" | "blank";
      height: number;
    };

type BitmapReceiptPayload = {
  lines: BitmapReceiptLine[];
};

export async function printArabicBitmapReceiptWithWindows(
  receipt: ArabicReceipt,
  printerConfig: SystemPrinterConfig = systemPrinterConfig,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<string> {
  ensureWindows();

  const directory = await mkdtemp(join(tmpdir(), "thermal-arabic-bitmap-"));
  const scriptPath = join(directory, `${randomUUID()}.ps1`);
  const payload = Buffer.from(
    JSON.stringify(createBitmapReceiptPayload(receipt)),
    "utf8"
  ).toString("base64");

  try {
    await writeFile(scriptPath, getArabicBitmapPrintScript(), "utf8");

    return await runPowerShellFile(scriptPath, [
      "-PrinterName",
      printerConfig.printerName,
      "-ReceiptJsonBase64",
      payload,
      "-DocumentName",
      "Arabic Bitmap Thermal Receipt",
      "-PaperWidthDots",
      String(bitmapConfig.widthDots),
      "-FeedAfterReceiptLines",
      String(bitmapConfig.feedAfterReceiptLines),
      "-CutAfterPrint",
      bitmapConfig.cutAfterPrint ? "1" : "0"
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createBitmapReceiptPayload(receipt: ArabicReceipt): BitmapReceiptPayload {
  const subtotal = receipt.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );
  const tax = roundMoney(subtotal * receipt.taxRate);
  const total = roundMoney(subtotal + tax);
  const lines: BitmapReceiptLine[] = [
    textLine(receipt.storeName, 32, true, "center", 8, 8),
    textLine(receipt.storeAddress, 24, false, "center", 0, 4),
    textLine(formatArabicDate(new Date()), 22, false, "center", 0, 10),
    { kind: "blank", height: 8 },
    textLine(`رقم الطلب: ${receipt.orderNumber}`, 24, false, "right", 0, 4),
    textLine(`الكاشير: ${receipt.cashier}`, 24, false, "right", 0, 8),
    { kind: "separator", height: 14 }
  ];

  for (const item of receipt.items) {
    lines.push(textLine(item.name, 24, false, "right", 0, 2));
    lines.push(
      textLine(
        formatLineItemCalculation(item),
        22,
        false,
        "right",
        0,
        6
      )
    );
  }

  lines.push(
    { kind: "separator", height: 14 },
    textLine(`المجموع الفرعي: ${formatArabicMoney(subtotal)}`, 24, false, "right", 0, 4),
    textLine(
      `الضريبة ${Math.round(receipt.taxRate * 100)}%: ${formatArabicMoney(tax)}`,
      24,
      false,
      "right",
      0,
      4
    ),
    textLine(`الإجمالي: ${formatArabicMoney(total)}`, 28, true, "right", 2, 6),
    textLine(`طريقة الدفع: ${receipt.paidWith}`, 24, false, "right", 0, 10),
    { kind: "blank", height: 8 },
    textLine("شكرا لزيارتكم", 26, true, "center", 0, 10)
  );

  return { lines };
}

function formatLineItemCalculation(item: ArabicReceipt["items"][number]): string {
  return `${item.quantity} * ${formatArabicMoney(
    item.unitPrice
  )} = ${formatArabicMoney(item.quantity * item.unitPrice)}`;
}

function textLine(
  text: string,
  size: number,
  bold: boolean,
  align: "center" | "right",
  top: number,
  bottom: number
): BitmapReceiptLine {
  return { kind: "text", text, size, bold, align, top, bottom };
}

function runPowerShellFile(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true }
    );

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
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

function formatArabicMoney(value: number): string {
  return `${roundMoney(value).toFixed(2)} دج`;
}

function formatArabicDate(date: Date): string {
  return date.toLocaleString("ar-DZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ensureWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Arabic bitmap printing currently uses Windows PowerShell.");
  }
}

function getArabicBitmapPrintScript(): string {
  return String.raw`
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$ReceiptJsonBase64,
  [string]$DocumentName = "Arabic Bitmap Thermal Receipt",
  [int]$PaperWidthDots = 576,
  [int]$FeedAfterReceiptLines = 5,
  [int]$CutAfterPrint = 0
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RawPrinterBitmapHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, DOC_INFO_1 di);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  public static int SendBytes(string printerName, byte[] bytes, string documentName) {
    IntPtr printerHandle;
    if (!OpenPrinter(printerName, out printerHandle, IntPtr.Zero)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    }

    try {
      DOC_INFO_1 docInfo = new DOC_INFO_1();
      docInfo.pDocName = documentName;
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

function Add-Bytes([System.Collections.Generic.List[byte]]$List, [byte[]]$Bytes) {
  foreach ($byte in $Bytes) {
    [void]$List.Add($byte)
  }
}

function Add-LineFeeds([System.Collections.Generic.List[byte]]$List, [int]$Count) {
  for ($i = 0; $i -lt $Count; $i++) {
    [void]$List.Add([byte]0x0A)
  }
}

function New-StringFormat([string]$Alignment) {
  $format = New-Object System.Drawing.StringFormat
  $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::DirectionRightToLeft
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near

  if ($Alignment -eq "center") {
    $format.Alignment = [System.Drawing.StringAlignment]::Center
  } else {
    # With DirectionRightToLeft enabled, Near is the right edge.
    $format.Alignment = [System.Drawing.StringAlignment]::Near
  }

  return $format
}

function New-FontForLine($Line) {
  $style = [System.Drawing.FontStyle]::Regular
  if ($Line.bold) {
    $style = [System.Drawing.FontStyle]::Bold
  }

  return New-Object System.Drawing.Font("Tahoma", [single]$Line.size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Measure-ReceiptHeight($Lines, [int]$Width) {
  $bitmap = New-Object System.Drawing.Bitmap(1, 1)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $height = 0

  try {
    foreach ($line in $Lines) {
      if ($line.kind -eq "blank" -or $line.kind -eq "separator") {
        $height += [int]$line.height
        continue
      }

      $font = New-FontForLine $line
      $format = New-StringFormat $line.align
      try {
        $size = $graphics.MeasureString([string]$line.text, $font, $Width, $format)
        $height += [int]$line.top + [Math]::Ceiling($size.Height) + [int]$line.bottom
      } finally {
        $font.Dispose()
        $format.Dispose()
      }
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  return [Math]::Max(1, $height + 12)
}

function Render-ReceiptBitmap($Lines, [int]$Width) {
  $height = Measure-ReceiptHeight $Lines $Width
  $bitmap = New-Object System.Drawing.Bitmap($Width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit

  $y = 0
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 1)

  try {
    foreach ($line in $Lines) {
      if ($line.kind -eq "blank") {
        $y += [int]$line.height
        continue
      }

      if ($line.kind -eq "separator") {
        $middle = $y + ([int]$line.height / 2)
        $graphics.DrawLine($pen, 0, $middle, $Width, $middle)
        $y += [int]$line.height
        continue
      }

      $font = New-FontForLine $line
      $format = New-StringFormat $line.align
      try {
        $measure = $graphics.MeasureString([string]$line.text, $font, $Width, $format)
        $lineHeight = [Math]::Ceiling($measure.Height)
        $y += [int]$line.top
        $rect = New-Object System.Drawing.RectangleF(0, $y, $Width, $lineHeight)
        $graphics.DrawString([string]$line.text, $font, [System.Drawing.Brushes]::Black, $rect, $format)
        $y += $lineHeight + [int]$line.bottom
      } finally {
        $font.Dispose()
        $format.Dispose()
      }
    }
  } finally {
    $pen.Dispose()
    $graphics.Dispose()
  }

  return $bitmap
}

function Convert-BitmapToEscposRaster([System.Drawing.Bitmap]$Bitmap) {
  $width = $Bitmap.Width
  $height = $Bitmap.Height
  $widthBytes = [int][Math]::Ceiling($width / 8)
  $bytes = [System.Collections.Generic.List[byte]]::new()

  Add-Bytes $bytes ([byte[]](0x1D, 0x76, 0x30, 0x00, ($widthBytes -band 0xFF), (($widthBytes -shr 8) -band 0xFF), ($height -band 0xFF), (($height -shr 8) -band 0xFF)))

  for ($y = 0; $y -lt $height; $y++) {
    for ($xByte = 0; $xByte -lt $widthBytes; $xByte++) {
      $value = 0
      for ($bit = 0; $bit -lt 8; $bit++) {
        $x = $xByte * 8 + $bit
        if ($x -lt $width) {
          $pixel = $Bitmap.GetPixel($x, $y)
          $luma = (0.299 * $pixel.R) + (0.587 * $pixel.G) + (0.114 * $pixel.B)
          if ($luma -lt 230) {
            $value = $value -bor (0x80 -shr $bit)
          }
        }
      }
      [void]$bytes.Add([byte]$value)
    }
  }

  return $bytes.ToArray()
}

$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ReceiptJsonBase64))
$receipt = $json | ConvertFrom-Json
$lines = @($receipt.lines)
$bitmap = Render-ReceiptBitmap $lines $PaperWidthDots
$payload = [System.Collections.Generic.List[byte]]::new()

try {
  Add-Bytes $payload ([byte[]](0x1B, 0x40, 0x1B, 0x3D, 0x01, 0x1C, 0x2E))
  Add-Bytes $payload (Convert-BitmapToEscposRaster $bitmap)
  Add-LineFeeds $payload $FeedAfterReceiptLines

  if ($CutAfterPrint -ne 0) {
    Add-Bytes $payload ([byte[]](0x1D, 0x56, 0x00))
  }
} finally {
  $bitmap.Dispose()
}

$jobId = [RawPrinterBitmapHelper]::SendBytes($PrinterName, $payload.ToArray(), $DocumentName)
"Printed Arabic bitmap with job id: $jobId"
`;
}
