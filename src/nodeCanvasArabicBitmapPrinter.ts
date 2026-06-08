import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CanvasRenderingContext2D,
  createCanvas,
  registerFont
} from "canvas";
import { ArabicReceipt } from "./arabicReceipt";
import {
  NormalizedArabicBitmapPrinterConfig,
  normalizeArabicBitmapPrinterConfig
} from "./arabicBitmapConfig";
import { createMonochromePreviewPngBuffer } from "./bitmapPreview";
import {
  ArabicBitmapPrinterConfig,
  arabicBitmapPrinterConfig,
  SystemPrinterConfig,
  systemPrinterConfig
} from "./config";
import { createEscposBitmapPrintBuffer } from "./escposRaster";
import {
  calculateReceiptTotals,
  formatDiscountValue,
  ReceiptDiscount,
  roundMoney
} from "./receiptTotals";
import { printBufferWithSystemPrinter } from "./systemPrinter";

type TextAlign = "left" | "center" | "right";

type TextStyle = {
  size: number;
  weight: number;
  align: TextAlign;
  direction?: "ltr" | "rtl";
  fontFamily: string;
};

type TableColumn = {
  title: string;
  widthRatio: number;
  align: TextAlign;
};

type TableCell = {
  text: string;
  align?: TextAlign;
  direction?: "ltr" | "rtl";
  weight?: number;
};

type TableRow = {
  cells: TableCell[];
  size: number;
  topPadding: number;
  bottomPadding: number;
};

type SummaryRow = {
  label: string;
  value: string;
  bold?: boolean;
};

type MoneyTextParts = {
  amount: string;
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

const NOTO_NASKH_FONT_FAMILY = "Noto Naskh Arabic";
const NOTO_NASKH_FONT_PATH = join(
  process.cwd(),
  "src",
  "assets",
  "NotoNaskhArabic-VariableFont_wght.ttf"
);
const PAGE_PADDING_DOTS = 8;
const CELL_PADDING_X_DOTS = 4;
const CELL_PADDING_Y_DOTS = 2;
const LINE_HEIGHT_MULTIPLIER = 1.22;
const BARCODE_BAR_HEIGHT_DOTS = 54;
const BARCODE_LABEL_GAP_DOTS = 4;
const BARCODE_MAX_WIDTH_DOTS = 420;
const BARCODE_QUIET_ZONE_DOTS = 16;
const CURRENCY_LABEL = "\u062f.\u062c";
const CURRENCY_GLYPHS_IN_RTL_VISUAL_ORDER = ["\u062c", ".", "\u062f"] as const;
const MONEY_TEXT_PATTERN = new RegExp(
  `^(-?\\d+(?:\\.\\d+)?)\\s+${escapeRegExp(CURRENCY_LABEL)}$`,
  "u"
);
let isNotoNaskhRegistered = false;

const itemTableColumns: TableColumn[] = [
  { title: "الصنف", widthRatio: 0.34, align: "right" },
  { title: "الكمية", widthRatio: 0.2, align: "right" },
  { title: "السعر", widthRatio: 0.23, align: "left" },
  { title: "الإجمالي", widthRatio: 0.23, align: "left" }
];

export function createArabicBitmapReceiptWithNodeCanvas(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): NodeCanvasArabicBitmapReceipt {
  const startedAt = new Date();
  const config = normalizeArabicBitmapPrinterConfig(bitmapConfig);
  const layout = createNodeCanvasReceiptLayout(receipt);
  const measuringContext = configureCanvasContext(
    createCanvas(config.widthDots, 1).getContext("2d", {
      alpha: false,
      pixelFormat: "RGB24"
    }),
    config
  );
  const heightDots = measureReceiptHeight(measuringContext, layout, config);
  const canvas = createCanvas(
    config.widthDots * config.renderScale,
    heightDots * config.renderScale
  );
  const context = configureCanvasContext(
    canvas.getContext("2d", {
      alpha: false,
      pixelFormat: "RGB24"
    }),
    config
  );

  context.scale(config.renderScale, config.renderScale);
  renderReceipt(context, layout, config, heightDots);

  const imageData = context.getImageData(
    0,
    0,
    config.widthDots * config.renderScale,
    heightDots * config.renderScale
  );
  const rasterSource = {
    data: imageData.data,
    sourceWidth: imageData.width,
    sourceHeight: imageData.height,
    targetWidth: config.widthDots,
    targetHeight: heightDots,
    monochromeThreshold: config.monochromeThreshold
  };
  const escposBuffer = createEscposBitmapPrintBuffer({
    ...rasterSource,
    feedAfterReceiptLines: config.feedAfterReceiptLines,
    cutAfterPrint: config.cutAfterPrint
  });

  const pngBuffer = createMonochromePreviewPngBuffer(
    rasterSource,
    config.printerDpi
  );
  const elapsedMs = new Date().getTime() - startedAt.getTime();

  console.log(
    `Generated node-canvas Arabic bitmap in ${elapsedMs}ms (${config.widthDots}x${heightDots}, scale=${config.renderScale}, threshold=${config.monochromeThreshold}, font="${config.fontFamily}").`
  );

  return {
    escposBuffer,
    pngBuffer,
    widthDots: config.widthDots,
    heightDots,
    printerDpi: config.printerDpi,
    renderScale: config.renderScale,
    monochromeThreshold: config.monochromeThreshold
  };
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

function createNodeCanvasReceiptLayout(receipt: ArabicReceipt): {
  receipt: ArabicReceipt;
  itemRows: TableRow[];
  summaryRows: SummaryRow[];
} {
  const totals = calculateReceiptTotals(
    receipt.items,
    receipt.taxRate,
    receipt.globalDiscount
  );
  const itemRows = totals.lines.flatMap((line): TableRow[] => {
    const item = line.item;
    const rows: TableRow[] = [
      {
        size: 19,
        topPadding: 2,
        bottomPadding: line.discountAmount > 0 ? 0 : 4,
        cells: [
          { text: item.name, align: "right" },
          { text: `${item.quantity} ${item.unitName}`, align: "right" },
          { text: formatArabicMoney(item.unitPrice), align: "left", direction: "ltr" },
          { text: formatArabicMoney(line.grossTotal), align: "left", direction: "ltr" }
        ]
      }
    ];

    if (line.discountAmount > 0 && item.discount) {
      rows.push(
        {
          size: 17,
          topPadding: 0,
          bottomPadding: 0,
          cells: [
            {
              text: `خصم ${formatDiscountLabel(item.discount)}`,
              align: "right"
            },
            { text: "", align: "right" },
            { text: "", align: "left" },
            {
              text: `-${formatArabicMoney(line.discountAmount)}`,
              align: "left",
              direction: "ltr"
            }
          ]
        },
        {
          size: 17,
          topPadding: 0,
          bottomPadding: 4,
          cells: [
            { text: "بعد الخصم", align: "right" },
            { text: "", align: "right" },
            { text: "", align: "left" },
            { text: formatArabicMoney(line.netTotal), align: "left", direction: "ltr" }
          ]
        }
      );
    }

    return rows;
  });
  const summaryRows: SummaryRow[] = [
    {
      label: "المجموع قبل الخصم:",
      value: formatArabicMoney(totals.subtotalBeforeDiscounts)
    }
  ];

  if (totals.lineDiscountTotal > 0) {
    summaryRows.push({
      label: "خصم السطور:",
      value: `-${formatArabicMoney(totals.lineDiscountTotal)}`
    });
  }

  if (totals.globalDiscountAmount > 0 && receipt.globalDiscount) {
    summaryRows.push({
      label: `الخصم العام ${formatDiscountLabel(receipt.globalDiscount)}:`,
      value: `-${formatArabicMoney(totals.globalDiscountAmount)}`
    });
  }

  summaryRows.push(
    {
      label: "المبلغ الخاضع للضريبة:",
      value: formatArabicMoney(totals.taxableSubtotal)
    },
    {
      label: `الضريبة ${Math.round(receipt.taxRate * 100)}%:`,
      value: formatArabicMoney(totals.tax)
    },
    {
      label: "الإجمالي:",
      value: formatArabicMoney(totals.total),
      bold: true
    }
  );

  return { receipt, itemRows, summaryRows };
}

function measureReceiptHeight(
  context: CanvasRenderingContext2D,
  layout: ReturnType<typeof createNodeCanvasReceiptLayout>,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const contentWidth = getContentWidth(config);
  let y = 0;

  y += measureTextBlock(context, layout.receipt.storeName, titleStyle(config), contentWidth) + 8;
  y += measureTextBlock(context, layout.receipt.storeAddress, centeredStyle(23, config), contentWidth) + 4;
  y += measureTextBlock(context, formatArabicDate(new Date()), centeredStyle(22, config), contentWidth) + 18;
  y += measureOrderRow(context, layout.receipt, config) + 10;
  y += 10;
  y += measureTable(context, layout.itemRows, itemTableColumns, config, true);
  y += 12;
  y += measureSummaryTable(context, layout.summaryRows, config);
  y += measureTextBlock(
    context,
    `طريقة الدفع: ${layout.receipt.paidWith}`,
    rightStyle(24, 400, config),
    contentWidth
  ) + 18;
  y += measureBarcodeBlock(context, layout.receipt.orderNumber, config) + 18;
  y += measureTextBlock(context, "شكرا لزيارتكم", centeredStyle(26, config, 700), contentWidth) + 12;

  return Math.max(1, Math.ceil(y + 12));
}

function renderReceipt(
  context: CanvasRenderingContext2D,
  layout: ReturnType<typeof createNodeCanvasReceiptLayout>,
  config: NormalizedArabicBitmapPrinterConfig,
  heightDots: number
): void {
  const contentWidth = getContentWidth(config);
  let y = 0;

  context.fillStyle = "white";
  context.fillRect(0, 0, config.widthDots, heightDots);

  y = drawTextBlock(context, layout.receipt.storeName, titleStyle(config), PAGE_PADDING_DOTS, y + 8, contentWidth) + 8;
  y = drawTextBlock(context, layout.receipt.storeAddress, centeredStyle(23, config), PAGE_PADDING_DOTS, y, contentWidth) + 4;
  y = drawTextBlock(context, formatArabicDate(new Date()), centeredStyle(22, config), PAGE_PADDING_DOTS, y, contentWidth) + 18;
  y = drawOrderRow(context, layout.receipt, config, y) + 10;
  y = drawRule(context, config, y) + 8;
  y = drawTable(context, layout.itemRows, itemTableColumns, config, y, true);
  y = drawRule(context, config, y + 4) + 8;
  y = drawSummaryTable(context, layout.summaryRows, config, y) + 8;
  y = drawTextBlock(
    context,
    `طريقة الدفع: ${layout.receipt.paidWith}`,
    rightStyle(24, 400, config),
    PAGE_PADDING_DOTS,
    y,
    contentWidth
  ) + 18;
  y = drawBarcodeBlock(context, layout.receipt.orderNumber, config, y) + 18;
  drawTextBlock(
    context,
    "شكرا لزيارتكم",
    centeredStyle(26, config, 700),
    PAGE_PADDING_DOTS,
    y,
    contentWidth
  );
}

function drawOrderRow(
  context: CanvasRenderingContext2D,
  receipt: ArabicReceipt,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const style = rightStyle(22, 400, config);
  const rowHeight = Math.max(
    measureTextBlock(context, `رقم الطلب: ${receipt.orderNumber}`, style, getContentWidth(config) / 2),
    measureTextBlock(context, `الكاشير: ${receipt.cashier}`, style, getContentWidth(config) / 2)
  );

  drawSingleLine(
    context,
    `رقم الطلب: ${receipt.orderNumber}`,
    style,
    config.widthDots - PAGE_PADDING_DOTS,
    y
  );
  drawSingleLine(
    context,
    `الكاشير: ${receipt.cashier}`,
    { ...style, align: "left" },
    PAGE_PADDING_DOTS,
    y
  );

  return y + rowHeight;
}

function measureOrderRow(
  context: CanvasRenderingContext2D,
  receipt: ArabicReceipt,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const style = rightStyle(22, 400, config);
  const halfWidth = getContentWidth(config) / 2;

  return Math.max(
    measureTextBlock(context, `رقم الطلب: ${receipt.orderNumber}`, style, halfWidth),
    measureTextBlock(context, `الكاشير: ${receipt.cashier}`, style, halfWidth)
  );
}

function drawBarcodeBlock(
  context: CanvasRenderingContext2D,
  value: string,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const modules = createCode128BModules(value);
  const moduleWidth = getBarcodeModuleWidth(modules.length, config);
  const barcodeWidth = modules.length * moduleWidth;
  const startX = Math.round((config.widthDots - barcodeWidth) / 2);

  context.fillStyle = "black";

  for (let index = 0; index < modules.length; index++) {
    if (modules[index] === "1") {
      context.fillRect(
        startX + index * moduleWidth,
        y,
        moduleWidth,
        BARCODE_BAR_HEIGHT_DOTS
      );
    }
  }

  drawTextBlock(
    context,
    value,
    { ...moneyStyle(18, 400, config), align: "center" },
    PAGE_PADDING_DOTS,
    y + BARCODE_BAR_HEIGHT_DOTS + BARCODE_LABEL_GAP_DOTS,
    getContentWidth(config)
  );

  return y + measureBarcodeBlock(context, value, config);
}

function measureBarcodeBlock(
  context: CanvasRenderingContext2D,
  value: string,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  return (
    BARCODE_BAR_HEIGHT_DOTS +
    BARCODE_LABEL_GAP_DOTS +
    measureTextBlock(context, value, moneyStyle(18, 400, config), getContentWidth(config))
  );
}

function getBarcodeModuleWidth(
  moduleCount: number,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const availableWidth = Math.min(
    BARCODE_MAX_WIDTH_DOTS,
    getContentWidth(config) - BARCODE_QUIET_ZONE_DOTS * 2
  );

  return Math.max(1, Math.floor(availableWidth / moduleCount));
}

function drawTable(
  context: CanvasRenderingContext2D,
  rows: TableRow[],
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number,
  drawHeader: boolean
): number {
  let cursorY = y;

  if (drawHeader) {
    cursorY = drawTableHeader(context, columns, config, cursorY);
  }

  for (const row of rows) {
    cursorY = drawTableRow(context, row, columns, config, cursorY);
  }

  return cursorY;
}

function measureTable(
  context: CanvasRenderingContext2D,
  rows: TableRow[],
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig,
  includeHeader: boolean
): number {
  let height = includeHeader
    ? measureTableRow(context, headerRow(columns), columns, config)
    : 0;

  for (const row of rows) {
    height += measureTableRow(context, row, columns, config);
  }

  return height;
}

function drawTableHeader(
  context: CanvasRenderingContext2D,
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const row = headerRow(columns);
  const rowHeight = measureTableRow(context, row, columns, config);
  const nextY = drawTableRow(context, row, columns, config, y);

  drawHorizontalLine(context, PAGE_PADDING_DOTS, y + rowHeight - 1, getContentWidth(config));

  return nextY;
}

function drawTableRow(
  context: CanvasRenderingContext2D,
  row: TableRow,
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const cells = getTableCellRects(columns, config);
  const rowHeight = measureTableRow(context, row, columns, config);

  row.cells.forEach((cell, index) => {
    const rect = cells[index];
    if (!rect || !cell.text) {
      return;
    }

    const style = {
      size: row.size,
      weight: cell.weight ?? 400,
      align: cell.align ?? columns[index].align,
      direction: cell.direction,
      fontFamily: config.fontFamily
    };

    drawTextBlock(
      context,
      cell.text,
      style,
      rect.x + CELL_PADDING_X_DOTS,
      y + row.topPadding + CELL_PADDING_Y_DOTS,
      rect.width - CELL_PADDING_X_DOTS * 2
    );
  });

  return y + rowHeight;
}

function measureTableRow(
  context: CanvasRenderingContext2D,
  row: TableRow,
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const cells = getTableCellRects(columns, config);
  const maxCellHeight = row.cells.reduce((height, cell, index) => {
    const rect = cells[index];

    if (!rect || !cell.text) {
      return height;
    }

    return Math.max(
      height,
      measureTextBlock(
        context,
        cell.text,
        {
          size: row.size,
          weight: cell.weight ?? 400,
          align: cell.align ?? columns[index].align,
          direction: cell.direction,
          fontFamily: config.fontFamily
        },
        rect.width - CELL_PADDING_X_DOTS * 2
      )
    );
  }, 0);

  return Math.ceil(
    row.topPadding + CELL_PADDING_Y_DOTS * 2 + maxCellHeight + row.bottomPadding
  );
}

function drawSummaryTable(
  context: CanvasRenderingContext2D,
  rows: SummaryRow[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  let cursorY = y;
  const labelWidth = getContentWidth(config) * 0.64;
  const valueWidth = getContentWidth(config) - labelWidth;

  for (const row of rows) {
    const size = row.bold ? 28 : 23;
    const weight = row.bold ? 700 : 400;
    const labelHeight = measureTextBlock(context, row.label, rightStyle(size, weight, config), labelWidth);
    const valueHeight = measureTextBlock(context, row.value, moneyStyle(size, weight, config), valueWidth);
    const rowHeight = Math.max(labelHeight, valueHeight) + 3;

    drawTextBlock(
      context,
      row.label,
      rightStyle(size, weight, config),
      config.widthDots - PAGE_PADDING_DOTS - labelWidth,
      cursorY,
      labelWidth
    );
    drawTextBlock(
      context,
      row.value,
      moneyStyle(size, weight, config),
      PAGE_PADDING_DOTS,
      cursorY,
      valueWidth
    );
    cursorY += rowHeight;
  }

  return cursorY;
}

function measureSummaryTable(
  context: CanvasRenderingContext2D,
  rows: SummaryRow[],
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const labelWidth = getContentWidth(config) * 0.64;
  const valueWidth = getContentWidth(config) - labelWidth;

  return rows.reduce((height, row) => {
    const size = row.bold ? 28 : 23;
    const weight = row.bold ? 700 : 400;

    return (
      height +
      Math.max(
        measureTextBlock(context, row.label, rightStyle(size, weight, config), labelWidth),
        measureTextBlock(context, row.value, moneyStyle(size, weight, config), valueWidth)
      ) +
      3
    );
  }, 0);
}

function drawTextBlock(
  context: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  x: number,
  y: number,
  width: number
): number {
  const moneyParts = parseMoneyText(text);

  if (moneyParts) {
    drawMoneyLine(context, moneyParts, style, x, y, width);
    return y + getLineHeight(style.size);
  }

  const lines = wrapText(text, context, style, width);
  const lineHeight = getLineHeight(style.size);
  let cursorY = y;

  for (const line of lines) {
    const drawX = getAlignedX(style.align, x, width);

    drawSingleLine(context, line, style, drawX, cursorY);
    cursorY += lineHeight;
  }

  return cursorY;
}

function measureTextBlock(
  context: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  width: number
): number {
  if (parseMoneyText(text)) {
    return getLineHeight(style.size);
  }

  return wrapText(text, context, style, width).length * getLineHeight(style.size);
}

function drawSingleLine(
  context: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  x: number,
  y: number
): void {
  context.font = createFont(style);
  context.textAlign = style.align;
  context.direction = style.direction ?? (isMostlyArabic(text) ? "rtl" : "ltr");
  context.lang = "ar-DZ";
  context.textBaseline = "top";
  context.fillStyle = "black";
  context.fillText(text, x, y);
}

function drawMoneyLine(
  context: CanvasRenderingContext2D,
  money: MoneyTextParts,
  style: TextStyle,
  x: number,
  y: number,
  width: number
): void {
  context.font = createFont(style);
  context.textAlign = "left";
  context.direction = "ltr";
  context.lang = "ar-DZ";
  context.textBaseline = "top";
  context.fillStyle = "black";

  // Money mixes ASCII digits with Arabic letters. Drawing the runs separately
  // gives us RTL reading order: amount first on the right, currency after it
  // on the left, without Canvas moving the Arabic abbreviation around.
  const amountWidth = context.measureText(money.amount).width;
  const gapWidth = getMoneyGapWidth(style);
  const currencyWidth = measureCurrencyLabel(context);
  const lineWidth = amountWidth + gapWidth + currencyWidth;
  const startX = getAlignedInlineStartX(style.align, x, width, lineWidth);

  drawCurrencyLabel(context, startX, y);
  context.fillText(money.amount, startX + currencyWidth + gapWidth, y);
}

function drawCurrencyLabel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number
): void {
  let cursorX = x;

  // The whole money value is read RTL: amount first, then currency to its left.
  // Drawing these glyphs left-to-right as ج.د makes the RTL reading order د.ج.
  for (const glyph of CURRENCY_GLYPHS_IN_RTL_VISUAL_ORDER) {
    context.fillText(glyph, cursorX, y);
    cursorX += context.measureText(glyph).width;
  }
}

function measureCurrencyLabel(context: CanvasRenderingContext2D): number {
  return CURRENCY_GLYPHS_IN_RTL_VISUAL_ORDER.reduce(
    (width, glyph) => width + context.measureText(glyph).width,
    0
  );
}

function getMoneyGapWidth(style: TextStyle): number {
  return Math.max(6, Math.round(style.size * 0.35));
}

function getAlignedInlineStartX(
  align: TextAlign,
  x: number,
  width: number,
  lineWidth: number
): number {
  if (align === "right") {
    return x + width - lineWidth;
  }

  if (align === "center") {
    return x + (width - lineWidth) / 2;
  }

  return x;
}

function parseMoneyText(text: string): MoneyTextParts | undefined {
  const match = MONEY_TEXT_PATTERN.exec(text);

  return match ? { amount: match[1] } : undefined;
}

function wrapText(
  text: string,
  context: CanvasRenderingContext2D,
  style: TextStyle,
  maxWidth: number
): string[] {
  context.font = createFont(style);

  if (context.measureText(text).width <= maxWidth) {
    return [text];
  }

  const tokens = text.trim().split(/\s+/u);
  const lines: string[] = [];
  let currentLine = "";

  for (const token of tokens) {
    const candidate = currentLine ? `${currentLine} ${token}` : token;

    if (!currentLine || context.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = token;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [text];
}

function configureCanvasContext(
  context: CanvasRenderingContext2D,
  config: NormalizedArabicBitmapPrinterConfig
): CanvasRenderingContext2D {
  registerBundledFontIfNeeded(config.fontFamily);
  context.antialias = "gray";
  context.quality = "best";
  context.patternQuality = "best";
  context.textDrawingMode = "path";
  context.imageSmoothingEnabled = false;
  context.fillStyle = "white";

  return context;
}

function registerBundledFontIfNeeded(fontFamily: string): void {
  if (fontFamily !== NOTO_NASKH_FONT_FAMILY) {
    return;
  }

  registerNotoNaskhArabic();
}

function registerNotoNaskhArabic(): void {
  if (isNotoNaskhRegistered) {
    return;
  }

  if (!existsSync(NOTO_NASKH_FONT_PATH)) {
    throw new Error(`Missing node-canvas receipt font: ${NOTO_NASKH_FONT_PATH}`);
  }

  registerFont(NOTO_NASKH_FONT_PATH, {
    family: NOTO_NASKH_FONT_FAMILY,
    weight: "400"
  });
  registerFont(NOTO_NASKH_FONT_PATH, {
    family: NOTO_NASKH_FONT_FAMILY,
    weight: "700"
  });
  isNotoNaskhRegistered = true;
}

function createFont(style: TextStyle): string {
  return `${style.weight} ${style.size}px ${quoteFontFamily(
    style.fontFamily
  )}, "Arial", sans-serif`;
}

function quoteFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/"/g, "")}"`;
}

function titleStyle(config: NormalizedArabicBitmapPrinterConfig): TextStyle {
  return centeredStyle(32, config, 700);
}

function centeredStyle(
  size: number,
  config: NormalizedArabicBitmapPrinterConfig,
  weight = 400
): TextStyle {
  return { size, weight, align: "center", fontFamily: config.fontFamily };
}

function rightStyle(
  size: number,
  weight: number,
  config: NormalizedArabicBitmapPrinterConfig
): TextStyle {
  return { size, weight, align: "right", fontFamily: config.fontFamily };
}

function moneyStyle(
  size: number,
  weight: number,
  config: NormalizedArabicBitmapPrinterConfig
): TextStyle {
  return {
    size,
    weight,
    align: "left",
    direction: "ltr",
    fontFamily: config.fontFamily
  };
}

function getTableCellRects(
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig
): Array<{ x: number; width: number }> {
  let rightEdge = config.widthDots - PAGE_PADDING_DOTS;

  return columns.map((column, index) => {
    const isLastColumn = index === columns.length - 1;
    const width = isLastColumn
      ? rightEdge - PAGE_PADDING_DOTS
      : getContentWidth(config) * column.widthRatio;
    const x = rightEdge - width;

    rightEdge = x;

    return { x, width };
  });
}

function headerRow(columns: TableColumn[]): TableRow {
  return {
    size: 18,
    topPadding: 2,
    bottomPadding: 4,
    cells: columns.map((column) => ({
      text: column.title,
      align: column.align,
      weight: 700
    }))
  };
}

function drawRule(
  context: CanvasRenderingContext2D,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  drawHorizontalLine(context, 0, y, config.widthDots);

  return y + 1;
}

function drawHorizontalLine(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number
): void {
  context.fillStyle = "black";
  context.fillRect(x, Math.round(y), width, 1);
}

function getAlignedX(align: TextAlign, x: number, width: number): number {
  if (align === "center") {
    return x + width / 2;
  }

  return align === "right" ? x + width : x;
}

function getContentWidth(config: NormalizedArabicBitmapPrinterConfig): number {
  return config.widthDots - PAGE_PADDING_DOTS * 2;
}

function getLineHeight(size: number): number {
  return Math.ceil(size * LINE_HEIGHT_MULTIPLIER);
}

function createCode128BModules(value: string): string {
  const codes = encodeCode128B(value);
  const checksum =
    codes.reduce(
      (sum, code, index) => sum + code * (index === 0 ? 1 : index),
      0
    ) % 103;
  const codesWithChecksumAndStop = [...codes, checksum, 106];

  return codesWithChecksumAndStop
    .map((code) => code128Patterns[code])
    .map(patternToModules)
    .join("");
}

function encodeCode128B(value: string): number[] {
  if (!value) {
    throw new Error("Receipt barcode value cannot be empty.");
  }

  const codes = [104]; // Start Code B.

  for (const character of value) {
    const charCode = character.charCodeAt(0);

    if (charCode < 32 || charCode > 126) {
      throw new Error(
        `Code 128-B barcode only supports printable ASCII. Unsupported character: ${character}`
      );
    }

    codes.push(charCode - 32);
  }

  return codes;
}

function patternToModules(pattern: string): string {
  let modules = "";

  for (let index = 0; index < pattern.length; index++) {
    modules += (index % 2 === 0 ? "1" : "0").repeat(Number(pattern[index]));
  }

  return modules;
}

const code128Patterns = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112"
] as const;

function formatDiscountLabel(discount: ReceiptDiscount): string {
  if (discount.type === "percent") {
    return formatDiscountValue(discount);
  }

  return "\u062b\u0627\u0628\u062a";
}

function formatArabicMoney(value: number): string {
  return `${roundMoney(value).toFixed(2)} ${CURRENCY_LABEL}`;
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

function isMostlyArabic(text: string): boolean {
  return /[\u0600-\u06ff]/u.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
