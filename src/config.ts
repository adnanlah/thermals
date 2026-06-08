import { CharacterSet, PrinterTypes } from "node-thermal-printer";

export type UsbPrinterConfig = {
  vendorId: number;
  productId: number;
  configurationValue?: number;
  interfaceNumber?: number;
  alternateSetting?: number;
  endpointNumber?: number;
  chunkSizeBytes: number;
  interChunkDelayMs: number;
  postWriteDelayMs: number;
  softResetPrinterClassInterface: boolean;
};

export type ReceiptPrinterConfig = {
  type: PrinterTypes;
  width: number;
  arabicCharacterSet: CharacterSet;
  reverseArabicOutput: boolean;
};

export type SystemPrinterConfig = {
  printerName: string;
  docName: string;
};

export type ArabicBitmapPrinterConfig = {
  widthDots: number;
  printerDpi: number;
  renderScale: number;
  monochromeThreshold: number;
  fontFamily: string;
  feedAfterReceiptLines: number;
  cutAfterPrint: boolean;
};

export const usbPrinterConfig: UsbPrinterConfig = {
  // Replace these with the VID/PID values from Zadig, for example 0x04b8.
  vendorId: 0x1FC9,
  productId: 0x2016,

  // Leave these unset to auto-discover the first writable OUT endpoint.
  configurationValue: undefined,
  interfaceNumber: undefined,
  alternateSetting: undefined,
  endpointNumber: undefined,

  // Many low-cost ESC/POS printers behave better with packet-sized writes.
  chunkSizeBytes: 64,
  interChunkDelayMs: 5,
  postWriteDelayMs: 1000,
  softResetPrinterClassInterface: true
};

export const receiptPrinterConfig: ReceiptPrinterConfig = {
  type: PrinterTypes.EPSON,
  width: 48,
  arabicCharacterSet: CharacterSet.WPC1256_ARABIC,
  // Set to false if your printer firmware already handles Arabic RTL ordering.
  reverseArabicOutput: true
};

export const systemPrinterConfig: SystemPrinterConfig = {
  printerName: "POSPrinter POS80",
  docName: "Thermal Receipt"
};

export const arabicBitmapPrinterConfig: ArabicBitmapPrinterConfig = {
  // 80 mm thermal printers are commonly 576 dots wide. Use 384 for 58 mm.
  widthDots: 576,
  // Most ESC/POS thermal heads are 203 DPI. This is used for PNG preview metadata.
  printerDpi: 203,
  // Render text larger, then downsample to printer dots before 1-bit conversion.
  renderScale: 3,
  // Balanced for Noto Arabic bitmap receipts: dark enough without filling counters.
  monochromeThreshold: 240,
  // Use "Arial" if you want to compare against the bundled Noto Naskh Arabic font.
  fontFamily: "Noto Naskh Arabic",
  // Extra paper feed after the final thank-you message.
  feedAfterReceiptLines: 5,
  // Enable only for printers with a supported cutter.
  cutAfterPrint: true
};

export function hasConfiguredUsbPrinterIds(
  config: UsbPrinterConfig = usbPrinterConfig
): boolean {
  return config.vendorId !== 0x0000 && config.productId !== 0x0000;
}
