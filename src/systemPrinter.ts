import { ThermalPrinter } from "node-thermal-printer";
import {
  receiptPrinterConfig,
  SystemPrinterConfig,
  systemPrinterConfig
} from "./config";
import { SystemPrinterDriver } from "./systemPrinterTypes";
import { createWindowsRawPrinterDriver } from "./windowsRawPrinterDriver";

export function listSystemPrinters(
  config: SystemPrinterConfig = systemPrinterConfig
): string[] {
  const driver = loadSystemPrinterDriver(config);

  return driver.getPrinters().map((printer) => {
    const name = printer.name ?? "(unnamed printer)";
    const status = printer.status ? ` status=${printer.status}` : "";
    const attributes = printer.attributes?.length
      ? ` attributes=${printer.attributes.join(",")}`
      : "";

    return `${name}${status}${attributes}`;
  });
}

export async function printBufferWithSystemPrinter(
  buffer: Buffer,
  config: SystemPrinterConfig = systemPrinterConfig
): Promise<string> {
  const driver = loadSystemPrinterDriver(config);
  const printer = new ThermalPrinter({
    type: receiptPrinterConfig.type,
    width: receiptPrinterConfig.width,
    interface: getSystemPrinterInterface(config),
    driver
  });

  printer.setBuffer(buffer);

  return String(await printer.execute({ docname: config.docName }));
}

export function getSystemPrinterInterface(
  config: SystemPrinterConfig = systemPrinterConfig
): string {
  return `printer:${config.printerName}`;
}

function loadSystemPrinterDriver(
  _config: SystemPrinterConfig
): SystemPrinterDriver {
  return createWindowsRawPrinterDriver();
}
