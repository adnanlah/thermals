import { ArabicBitmapPrinterConfig } from "./config";

export type NormalizedArabicBitmapPrinterConfig = ArabicBitmapPrinterConfig & {
  widthDots: number;
  printerDpi: number;
  renderScale: number;
  monochromeThreshold: number;
  fontFamily: string;
};

export function normalizeArabicBitmapPrinterConfig(
  config: ArabicBitmapPrinterConfig
): NormalizedArabicBitmapPrinterConfig {
  return {
    ...config,
    widthDots: Math.max(1, Math.floor(config.widthDots)),
    printerDpi: Math.max(72, Math.floor(config.printerDpi)),
    renderScale: clampInteger(config.renderScale, 1, 4),
    monochromeThreshold: clampInteger(config.monochromeThreshold, 1, 255),
    fontFamily: config.fontFamily.trim() || "Tahoma",
    feedAfterReceiptLines: Math.max(0, Math.floor(config.feedAfterReceiptLines))
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}
