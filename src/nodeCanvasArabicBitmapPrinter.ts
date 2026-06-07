import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CanvasRenderingContext2D,
  createCanvas
} from "canvas";
import { ArabicReceipt } from "./arabicReceipt";
import {
  ArabicBitmapPrinterConfig,
  arabicBitmapPrinterConfig,
  SystemPrinterConfig,
  systemPrinterConfig
} from "./config";
import {
  createEscposBitmapPrintBuffer,
  createMonochromePreviewRgba
} from "./escposRaster";
import { printBufferWithSystemPrinter } from "./systemPrinter";
import {
  BitmapReceiptLine,
  createArabicBitmapReceiptPayload
} from "./windowsArabicBitmapPrinter";

type BitmapTextLine = Extract<BitmapReceiptLine, { kind: "text" }>;

type NormalizedCanvasBitmapConfig = ArabicBitmapPrinterConfig & {
  widthDots: number;
  printerDpi: number;
  renderScale: number;
  monochromeThreshold: number;
  fontFamily: string;
};

type TextDrawOperation = {
  kind: "text";
  line: BitmapTextLine;
  text: string;
  x: number;
  baseline: number;
  font: string;
};

type SeparatorDrawOperation = {
  kind: "separator";
  y: number;
};

type DrawOperation = TextDrawOperation | SeparatorDrawOperation;

type CanvasReceiptLayout = {
  operations: DrawOperation[];
  heightDots: number;
};

export type NodeCanvasArabicBitmapReceipt = {
  escposBuffer: Buffer;
  pngBuffer: Buffer;
  widthDots: number;
  heightDots: number;
  printerDpi: number;
  renderScale: number;
  monochromeThreshold: number;
};

const HORIZONTAL_PADDING_DOTS = 8;
const DEFAULT_LINE_HEIGHT_MULTIPLIER = 1.25;

export function createArabicBitmapReceiptWithNodeCanvas(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): NodeCanvasArabicBitmapReceipt {
  const config = normalizeBitmapConfig(bitmapConfig);
  const payload = createArabicBitmapReceiptPayload(receipt);
  const measuringCanvas = createCanvas(config.widthDots, 1);
  const measuringContext = configureCanvasContext(
    measuringCanvas.getContext("2d", {
      alpha: false,
      pixelFormat: "RGB24"
    })
  );
  const layout = createReceiptLayout(payload.lines, measuringContext, config);
  const canvas = createCanvas(
    config.widthDots * config.renderScale,
    layout.heightDots * config.renderScale
  );
  const context = configureCanvasContext(
    canvas.getContext("2d", {
      alpha: false,
      pixelFormat: "RGB24"
    })
  );

  context.scale(config.renderScale, config.renderScale);
  renderReceiptLayout(context, layout, config);

  const imageData = context.getImageData(
    0,
    0,
    config.widthDots * config.renderScale,
    layout.heightDots * config.renderScale
  );
  const rasterSource = {
    data: imageData.data,
    sourceWidth: imageData.width,
    sourceHeight: imageData.height,
    targetWidth: config.widthDots,
    targetHeight: layout.heightDots,
    monochromeThreshold: config.monochromeThreshold
  };
  const escposBuffer = createEscposBitmapPrintBuffer({
    ...rasterSource,
    feedAfterReceiptLines: config.feedAfterReceiptLines,
    cutAfterPrint: config.cutAfterPrint
  });
  const previewCanvas = createMonochromePreviewCanvas(rasterSource);

  return {
    escposBuffer,
    pngBuffer: previewCanvas.toBuffer("image/png", {
      resolution: config.printerDpi
    }),
    widthDots: config.widthDots,
    heightDots: layout.heightDots,
    printerDpi: config.printerDpi,
    renderScale: config.renderScale,
    monochromeThreshold: config.monochromeThreshold
  };
}

function createMonochromePreviewCanvas(
  rasterSource: {
    data: Uint8ClampedArray;
    sourceWidth: number;
    sourceHeight: number;
    targetWidth: number;
    targetHeight: number;
    monochromeThreshold: number;
  }
) {
  const previewCanvas = createCanvas(
    rasterSource.targetWidth,
    rasterSource.targetHeight
  );
  const previewContext = previewCanvas.getContext("2d", {
    alpha: false,
    pixelFormat: "RGB24"
  });
  const previewImage = previewContext.createImageData(
    rasterSource.targetWidth,
    rasterSource.targetHeight
  );

  previewImage.data.set(createMonochromePreviewRgba(rasterSource));
  previewContext.putImageData(previewImage, 0, 0);

  return previewCanvas;
}

export function createArabicBitmapReceiptBufferWithNodeCanvas(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Buffer {
  return createArabicBitmapReceiptWithNodeCanvas(receipt, bitmapConfig).escposBuffer;
}

export async function saveArabicBitmapReceiptPreviewWithNodeCanvas(
  outputPath: string,
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<NodeCanvasArabicBitmapReceipt> {
  const rendered = createArabicBitmapReceiptWithNodeCanvas(receipt, bitmapConfig);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered.pngBuffer);

  return rendered;
}

export async function printArabicBitmapReceiptWithNodeCanvas(
  receipt: ArabicReceipt,
  printerConfig: SystemPrinterConfig = systemPrinterConfig,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<string> {
  const buffer = createArabicBitmapReceiptBufferWithNodeCanvas(
    receipt,
    bitmapConfig
  );

  return printBufferWithSystemPrinter(buffer, {
    ...printerConfig,
    docName: "Arabic Node Canvas Bitmap Thermal Receipt"
  });
}

function createReceiptLayout(
  lines: BitmapReceiptLine[],
  context: CanvasRenderingContext2D,
  config: NormalizedCanvasBitmapConfig
): CanvasReceiptLayout {
  const operations: DrawOperation[] = [];
  const textWidth = config.widthDots - HORIZONTAL_PADDING_DOTS * 2;
  let y = 0;

  for (const line of lines) {
    if (!isBitmapTextLine(line)) {
      if (line.kind === "separator") {
        operations.push({
          kind: "separator",
          y: y + Math.floor(line.height / 2)
        });
      }

      y += line.height;
      continue;
    }

    const font = createFont(line, config);
    context.font = font;
    const wrappedLines = wrapText(line.text, context, textWidth);
    const lineHeight = measureLineHeight(line, context);
    const x =
      line.align === "center"
        ? config.widthDots / 2
        : config.widthDots - HORIZONTAL_PADDING_DOTS;

    y += line.top;

    for (const text of wrappedLines) {
      const metrics = context.measureText(text);
      const ascent =
        metrics.actualBoundingBoxAscent ||
        metrics.fontBoundingBoxAscent ||
        line.size * 0.9;
      const descent =
        metrics.actualBoundingBoxDescent ||
        metrics.fontBoundingBoxDescent ||
        line.size * 0.25;
      const baseline = y + (lineHeight - ascent - descent) / 2 + ascent;

      operations.push({
        kind: "text",
        line,
        text,
        x,
        baseline,
        font
      });
      y += lineHeight;
    }

    y += line.bottom;
  }

  return {
    operations,
    heightDots: Math.max(1, Math.ceil(y + 12))
  };
}

function isBitmapTextLine(line: BitmapReceiptLine): line is BitmapTextLine {
  return line.kind === "text";
}

function renderReceiptLayout(
  context: CanvasRenderingContext2D,
  layout: CanvasReceiptLayout,
  config: NormalizedCanvasBitmapConfig
): void {
  context.fillStyle = "white";
  context.fillRect(0, 0, config.widthDots, layout.heightDots);

  for (const operation of layout.operations) {
    if (operation.kind === "separator") {
      context.fillStyle = "black";
      context.fillRect(0, operation.y, config.widthDots, 1);
      continue;
    }

    context.font = operation.font;
    context.textAlign = operation.line.align === "center" ? "center" : "right";
    context.direction = "rtl";
    context.lang = "ar-DZ";
    context.textBaseline = "alphabetic";
    context.fillStyle = "black";
    context.fillText(operation.text, operation.x, operation.baseline);
  }
}

function configureCanvasContext(
  context: CanvasRenderingContext2D
): CanvasRenderingContext2D {
  context.antialias = "gray";
  context.quality = "best";
  context.patternQuality = "best";
  context.textDrawingMode = "path";
  context.imageSmoothingEnabled = false;
  context.fillStyle = "white";

  return context;
}

function wrapText(
  text: string,
  context: CanvasRenderingContext2D,
  maxWidth: number
): string[] {
  const words = text.trim().split(/\s+/u);
  const wrappedLines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (!currentLine || context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    wrappedLines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    wrappedLines.push(currentLine);
  }

  return wrappedLines.length > 0 ? wrappedLines : [text];
}

function measureLineHeight(
  line: BitmapTextLine,
  context: CanvasRenderingContext2D
): number {
  const metrics = context.measureText(line.text || " ");
  const measuredHeight =
    (metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || 0) +
    (metrics.actualBoundingBoxDescent || metrics.fontBoundingBoxDescent || 0);

  return Math.ceil(
    Math.max(line.size * DEFAULT_LINE_HEIGHT_MULTIPLIER, measuredHeight + 4)
  );
}

function createFont(
  line: BitmapTextLine,
  config: NormalizedCanvasBitmapConfig
): string {
  const weight = line.bold ? "700" : "400";
  const fontFamily = quoteFontFamily(config.fontFamily);

  return `${weight} ${line.size}px ${fontFamily}, "Arial", sans-serif`;
}

function quoteFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/"/g, "")}"`;
}

function normalizeBitmapConfig(
  config: ArabicBitmapPrinterConfig
): NormalizedCanvasBitmapConfig {
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
