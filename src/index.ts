import { buildSampleReceipt, createReceiptBuffer } from "./receipt";
import { hasConfiguredUsbPrinterIds, usbPrinterConfig } from "./config";
import {
  describeConfiguredUsbPrinter,
  listUsbDevices,
  printBufferOverWebUsb
} from "./webusbPrinter";

const command = process.argv[2] ?? "print";

main(command).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main(selectedCommand: string): Promise<void> {
  switch (selectedCommand) {
    case "print":
      await printSampleReceipt();
      return;
    case "list-usb":
      listConnectedUsbDevices();
      return;
    case "inspect-printer":
      await inspectConfiguredPrinter();
      return;
    case "test-print":
      await printRawTestReceipt();
      return;
    default:
      printUsage();
  }
}

async function printSampleReceipt(): Promise<void> {
  if (!hasConfiguredUsbPrinterIds()) {
    throw new Error(
      "Set usbPrinterConfig.vendorId and usbPrinterConfig.productId in src/config.ts before printing."
    );
  }

  const receipt = buildSampleReceipt();
  const buffer = createReceiptBuffer(receipt);

  console.log(`Sending ${buffer.length} receipt bytes over WebUSB...`);
  const result = await printBufferOverWebUsb(usbPrinterConfig, buffer);
  console.log(
    `Receipt sent: ${result.bytesWritten} bytes in ${result.chunksWritten} chunks via interface ${result.pipe.interfaceNumber}, endpoint ${result.pipe.endpointNumber}.`
  );
}

async function printRawTestReceipt(): Promise<void> {
  if (!hasConfiguredUsbPrinterIds()) {
    throw new Error(
      "Set usbPrinterConfig.vendorId and usbPrinterConfig.productId in src/config.ts before printing."
    );
  }

  const buffer = Buffer.from([
    0x1b, 0x40, // ESC @: initialize printer
    0x1b, 0x3d, 0x01, // ESC = 1: select printer
    ...Buffer.from("WEBUSB RAW TEST\r\n", "ascii"),
    ...Buffer.from(new Date().toLocaleString(), "ascii"),
    0x0d, 0x0a,
    0x0d, 0x0a,
    0x0d, 0x0a,
    0x1d, 0x56, 0x00 // GS V 0: full cut, ignored by printers without cutters
  ]);

  console.log(`Sending ${buffer.length} raw test bytes over WebUSB...`);
  const result = await printBufferOverWebUsb(usbPrinterConfig, buffer);
  console.log(
    `Raw test sent: ${result.bytesWritten} bytes in ${result.chunksWritten} chunks via interface ${result.pipe.interfaceNumber}, endpoint ${result.pipe.endpointNumber}.`
  );
}

async function inspectConfiguredPrinter(): Promise<void> {
  const lines = await describeConfiguredUsbPrinter(usbPrinterConfig);

  for (const line of lines) {
    console.log(line);
  }
}

function listConnectedUsbDevices(): void {
  const devices = listUsbDevices();

  if (devices.length === 0) {
    console.log("No USB devices found.");
    return;
  }

  for (const device of devices) {
    console.log(device);
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npm run print");
  console.log("  npm run list-usb");
  console.log("  npm run inspect-printer");
  console.log("  npm run test-print");
}
