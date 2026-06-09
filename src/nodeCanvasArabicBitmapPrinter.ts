import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CanvasRenderingContext2D,
  createCanvas,
  Image,
  loadImage,
  registerFont
} from "canvas";
import bwipjs from "@bwip-js/node";
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
  headerAlign?: TextAlign;
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
  dividerBefore?: boolean;
};

type MoneyTextParts = {
  amount: string;
};

type CellRect = { x: number; width: number };

type PrintedByGeometry = {
  qrSize: number;
  textWidth: number;
  textHeight: number;
  blockHeight: number;
  textX: number;
};

type ReceiptLayout = {
  receipt: ArabicReceipt;
  paymentMethod?: string;
  thankYouMessage: string;
  printedByMessage?: string;
  qrCodeUrl?: string;
  storeContactLines: string[];
  tableColumns: TableColumn[];
  itemRows: TableRow[];
  summaryRows: SummaryRow[];
};

export type NodeCanvasArabicBitmapReceiptOptions = {
  /**
   * Defaults to receipt.paidWith when omitted. Pass null or an empty string to
   * hide the payment-method line, or pass a string to override the receipt value.
   */
  paymentMethod?: string | null;
  thankYouMessage?: string | null;
  printedByMessage?: string | null;
  /**
   * URL (or any text) to encode as a QR code rendered beside the printed-by
   * line. Defaults to receipt.qrCodeUrl when omitted. Pass null or an empty
   * string to suppress the QR code.
   */
  qrCodeUrl?: string | null;
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
const ORDER_SECTION_TOP_MARGIN_DOTS = 50;
const BARCODE_BAR_HEIGHT_DOTS = 54;
const BARCODE_TOP_MARGIN_DOTS = 50;
const BARCODE_LABEL_GAP_DOTS = 12;
const BARCODE_BOTTOM_MARGIN_DOTS = 50;
const THANK_YOU_BOTTOM_MARGIN_DOTS = 50;
const BARCODE_MAX_WIDTH_DOTS = 420;
const BARCODE_QUIET_ZONE_DOTS = 16;
const CURRENCY_LABEL = "\u062f.\u062c";
const CURRENCY_GLYPHS_IN_RTL_VISUAL_ORDER = ["\u062c", ".", "\u062f"] as const;
const PAYMENT_METHOD_LABEL = "\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062f\u0641\u0639:";
const DEFAULT_THANK_YOU_MESSAGE = "\u0634\u0643\u0631\u0627 \u0644\u0632\u064a\u0627\u0631\u062a\u0643\u0645";
const PRINTED_BY_TOP_MARGIN_DOTS = 8;
const PRINTED_BY_BOTTOM_MARGIN_DOTS = 8;
const PRINTED_BY_BOTTOM_SPACING_DOTS = 8;
const QR_CODE_SIZE_DOTS = 100;
const QR_CODE_TEXT_GAP_DOTS = 8;
const LABEL_ORDER_NUMBER = "رقم الطلب";
const LABEL_CASHIER = "البائع";
const LABEL_CLIENT = "العميل";
const LABEL_POST_NUMBER = "رقم نقطة البيع";
const MONEY_TEXT_PATTERN = new RegExp(
  `^(-?\\d+(?:\\.\\d+)?)\\s+${escapeRegExp(CURRENCY_LABEL)}$`,
  "u"
);
const registeredFontFamilies = new Set<string>();

function createItemTableColumns(receipt: ArabicReceipt): TableColumn[] {
  return [
    {
      title: `المنتج (${formatQuantity(getReceiptItemCount(receipt))})`,
      widthRatio: 0.34,
      align: "right",
      headerAlign: "right"
    },
    { title: "الكمية", widthRatio: 0.2, align: "right", headerAlign: "right" },
    { title: "السعر", widthRatio: 0.23, align: "right", headerAlign: "right" },
    { title: "الإجمالي", widthRatio: 0.23, align: "left", headerAlign: "right" }
  ];
}

export async function createArabicBitmapReceiptWithNodeCanvas(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig,
  options: NodeCanvasArabicBitmapReceiptOptions = {}
): Promise<NodeCanvasArabicBitmapReceipt> {
  const startedAt = new Date();
  const config = normalizeArabicBitmapPrinterConfig(bitmapConfig);
  const layout = createNodeCanvasReceiptLayout(receipt, options);
  const assets = await preRenderAssets(layout);
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
  renderReceipt(context, layout, config, heightDots, assets);

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

export async function createArabicBitmapReceiptBufferWithNodeCanvas(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig,
  options: NodeCanvasArabicBitmapReceiptOptions = {}
): Promise<Buffer> {
  return (await createArabicBitmapReceiptWithNodeCanvas(
    receipt,
    bitmapConfig,
    options
  )).escposBuffer;
}

export async function saveArabicBitmapReceiptPreviewWithNodeCanvas(
  outputPath: string,
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig,
  options: NodeCanvasArabicBitmapReceiptOptions = {}
): Promise<NodeCanvasArabicBitmapReceipt> {
  const rendered = await createArabicBitmapReceiptWithNodeCanvas(
    receipt,
    bitmapConfig,
    options
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered.pngBuffer);

  return rendered;
}

export async function printArabicBitmapReceiptWithNodeCanvas(
  receipt: ArabicReceipt,
  printerConfig: SystemPrinterConfig = systemPrinterConfig,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig,
  options: NodeCanvasArabicBitmapReceiptOptions = {}
): Promise<string> {
  const buffer = await createArabicBitmapReceiptBufferWithNodeCanvas(
    receipt,
    bitmapConfig,
    options
  );

  return printBufferWithSystemPrinter(buffer, {
    ...printerConfig,
    docName: "Arabic Node Canvas Bitmap Thermal Receipt"
  });
}

type RenderedAssets = {
  barcodeImage: Image;
  qrImage?: Image;
};

async function preRenderAssets(layout: ReceiptLayout): Promise<RenderedAssets> {
  const [barcodeImage, qrImage] = await Promise.all([
    bwipjs.toBuffer({
      bcid: "code128",
      text: layout.receipt.orderNumber,
      scale: 2,
      includetext: false,
      paddingwidth: 0,
      paddingheight: 0
    }).then(loadImage),
    layout.qrCodeUrl
      ? bwipjs.toBuffer({
          bcid: "qrcode",
          text: layout.qrCodeUrl,
          scale: 3,
          paddingwidth: 0,
          paddingheight: 0
        }).then(loadImage)
      : Promise.resolve(undefined)
  ]);

  return { barcodeImage, qrImage };
}

function createNodeCanvasReceiptLayout(
  receipt: ArabicReceipt,
  options: NodeCanvasArabicBitmapReceiptOptions
): ReceiptLayout {
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
          { text: formatArabicMoney(item.unitPrice), align: "right", direction: "ltr" },
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
      bold: true,
      dividerBefore: true
    }
  );

  return {
    receipt,
    paymentMethod: resolvePaymentMethod(receipt, options),
    thankYouMessage: resolveThankYouMessage(receipt, options),
    printedByMessage: resolvePrintedByMessage(receipt, options),
    qrCodeUrl: resolveQrCodeUrl(receipt, options),
    storeContactLines: getStoreContactLines(receipt),
    tableColumns: createItemTableColumns(receipt),
    itemRows,
    summaryRows
  };
}

function measureReceiptHeight(
  context: CanvasRenderingContext2D,
  layout: ReceiptLayout,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const contentWidth = getContentWidth(config);
  let y = 0;

  y += measureTextBlock(context, layout.receipt.storeName, titleStyle(config), contentWidth) + 8;
  y += measureTextBlock(context, layout.receipt.storeAddress, centeredStyle(23, config), contentWidth) + 4;
  y += measureStoreContactLines(context, layout.storeContactLines, config);
  y += measureTextBlock(context, formatArabicDate(new Date()), centeredStyle(22, config), contentWidth) + ORDER_SECTION_TOP_MARGIN_DOTS;
  y += measureOrderRow(context, layout.receipt, config) + 10;
  y += 10;
  y += measureTable(context, layout.itemRows, layout.tableColumns, config, true);
  y += 12;
  y += measureSummaryTable(context, layout.summaryRows, config);

  if (layout.paymentMethod) {
    y += measureTextBlock(
      context,
      formatPaymentMethodLine(layout.paymentMethod),
      rightStyle(24, 400, config),
      contentWidth
    ) + 18;
  }

  y += BARCODE_TOP_MARGIN_DOTS;
  y += measureBarcodeBlock(context, layout.receipt.orderNumber, config);
  y += BARCODE_BOTTOM_MARGIN_DOTS;
  y += measureTextBlock(context, layout.thankYouMessage, centeredStyle(26, config, 700), contentWidth) + THANK_YOU_BOTTOM_MARGIN_DOTS;

  if (layout.printedByMessage) {
    const geo = computePrintedByGeometry(context, layout.printedByMessage, layout.qrCodeUrl, config);

    y +=
      PRINTED_BY_TOP_MARGIN_DOTS +
      geo.blockHeight +
      PRINTED_BY_BOTTOM_MARGIN_DOTS +
      PRINTED_BY_BOTTOM_SPACING_DOTS;
  }

  return Math.max(1, Math.ceil(y + 12));
}

function renderReceipt(
  context: CanvasRenderingContext2D,
  layout: ReceiptLayout,
  config: NormalizedArabicBitmapPrinterConfig,
  heightDots: number,
  assets: RenderedAssets
): void {
  const contentWidth = getContentWidth(config);
  let y = 0;

  context.fillStyle = "white";
  context.fillRect(0, 0, config.widthDots, heightDots);

  y = drawTextBlock(context, layout.receipt.storeName, titleStyle(config), PAGE_PADDING_DOTS, y + 8, contentWidth) + 8;
  y = drawTextBlock(context, layout.receipt.storeAddress, centeredStyle(23, config), PAGE_PADDING_DOTS, y, contentWidth) + 4;
  y = drawStoreContactLines(context, layout.storeContactLines, config, y);
  y = drawTextBlock(context, formatArabicDate(new Date()), centeredStyle(22, config), PAGE_PADDING_DOTS, y, contentWidth) + ORDER_SECTION_TOP_MARGIN_DOTS;
  y = drawOrderRow(context, layout.receipt, config, y) + 10;
  y = drawRule(context, config, y) + 8;
  y = drawTable(context, layout.itemRows, layout.tableColumns, config, y, true);
  y = drawRule(context, config, y + 4) + 8;
  y = drawSummaryTable(context, layout.summaryRows, config, y) + 8;

  if (layout.paymentMethod) {
    y = drawTextBlock(
      context,
      formatPaymentMethodLine(layout.paymentMethod),
      rightStyle(24, 400, config),
      PAGE_PADDING_DOTS,
      y,
      contentWidth
    ) + 18;
  }

  y += BARCODE_TOP_MARGIN_DOTS;
  y = drawBarcodeBlock(context, layout.receipt.orderNumber, config, y, assets.barcodeImage);
  y += BARCODE_BOTTOM_MARGIN_DOTS;
  y = drawTextBlock(
    context,
    layout.thankYouMessage,
    centeredStyle(26, config, 700),
    PAGE_PADDING_DOTS,
    y,
    contentWidth
  );

  if (layout.printedByMessage) {
    y += THANK_YOU_BOTTOM_MARGIN_DOTS + PRINTED_BY_TOP_MARGIN_DOTS;

    const geo = computePrintedByGeometry(context, layout.printedByMessage, layout.qrCodeUrl, config);
    const textY = y + Math.round((geo.blockHeight - geo.textHeight) / 2);

    if (layout.qrCodeUrl && assets.qrImage) {
      const qrY = y + Math.round((geo.blockHeight - geo.qrSize) / 2);
      context.drawImage(assets.qrImage, PAGE_PADDING_DOTS, qrY, geo.qrSize, geo.qrSize);
    }

    drawTextBlock(
      context,
      layout.printedByMessage,
      centeredStyle(18, config),
      geo.textX,
      textY,
      geo.textWidth
    );
  }
}

function computePrintedByGeometry(
  context: CanvasRenderingContext2D,
  message: string,
  qrCodeUrl: string | undefined,
  config: NormalizedArabicBitmapPrinterConfig
): PrintedByGeometry {
  const contentWidth = getContentWidth(config);
  const qrSize = qrCodeUrl ? QR_CODE_SIZE_DOTS : 0;
  const textWidth = qrSize > 0
    ? contentWidth - qrSize - QR_CODE_TEXT_GAP_DOTS
    : contentWidth;
  const textHeight = measureTextBlock(context, message, centeredStyle(18, config), textWidth);
  const blockHeight = Math.max(textHeight, qrSize);
  const textX = PAGE_PADDING_DOTS + qrSize + (qrSize > 0 ? QR_CODE_TEXT_GAP_DOTS : 0);

  return { qrSize, textWidth, textHeight, blockHeight, textX };
}

function drawOrderRow(
  context: CanvasRenderingContext2D,
  receipt: ArabicReceipt,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const style = rightStyle(22, 400, config);
  let cursorY = y;

  cursorY = drawTwoColumnMetadataRow(
    context,
    style,
    formatMetadataLine(LABEL_ORDER_NUMBER, receipt.orderNumber),
    formatMetadataLine(LABEL_CASHIER, receipt.cashier),
    config,
    cursorY
  );

  if (receipt.clientName || receipt.cashierPostNumber) {
    cursorY = drawTwoColumnMetadataRow(
      context,
      style,
      receipt.clientName
        ? formatMetadataLine(LABEL_CLIENT, receipt.clientName)
        : "",
      receipt.cashierPostNumber
        ? formatMetadataLine(LABEL_POST_NUMBER, receipt.cashierPostNumber)
        : "",
      config,
      cursorY + 2
    );
  }

  return cursorY;
}

function measureOrderRow(
  context: CanvasRenderingContext2D,
  receipt: ArabicReceipt,
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const style = rightStyle(22, 400, config);
  const halfWidth = getContentWidth(config) / 2;
  let height = measureTwoColumnMetadataRow(
    context,
    style,
    formatMetadataLine(LABEL_ORDER_NUMBER, receipt.orderNumber),
    formatMetadataLine(LABEL_CASHIER, receipt.cashier),
    halfWidth
  );

  if (receipt.clientName || receipt.cashierPostNumber) {
    height +=
      2 +
      measureTwoColumnMetadataRow(
        context,
        style,
        receipt.clientName
          ? formatMetadataLine(LABEL_CLIENT, receipt.clientName)
          : "",
        receipt.cashierPostNumber
          ? formatMetadataLine(LABEL_POST_NUMBER, receipt.cashierPostNumber)
          : "",
        halfWidth
      );
  }

  return height;
}

function drawTwoColumnMetadataRow(
  context: CanvasRenderingContext2D,
  style: TextStyle,
  rightText: string,
  leftText: string,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const halfWidth = getContentWidth(config) / 2;
  const rightHeight = rightText
    ? drawTextBlock(
        context,
        rightText,
        style,
        config.widthDots - PAGE_PADDING_DOTS - halfWidth,
        y,
        halfWidth
      )
    : y;
  const leftHeight = leftText
    ? drawTextBlock(
        context,
        leftText,
        { ...style, align: "left" },
        PAGE_PADDING_DOTS,
        y,
        halfWidth
      )
    : y;

  return Math.max(rightHeight, leftHeight);
}

function measureTwoColumnMetadataRow(
  context: CanvasRenderingContext2D,
  style: TextStyle,
  rightText: string,
  leftText: string,
  halfWidth: number
): number {
  return Math.max(
    rightText ? measureTextBlock(context, rightText, style, halfWidth) : 0,
    leftText
      ? measureTextBlock(context, leftText, { ...style, align: "left" }, halfWidth)
      : 0
  );
}

function drawStoreContactLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  if (lines.length === 0) {
    return y;
  }

  const style = centeredStyle(19, config);
  let cursorY = y;

  for (const line of lines) {
    cursorY = drawTextBlock(
      context,
      line,
      style,
      PAGE_PADDING_DOTS,
      cursorY,
      getContentWidth(config)
    ) + 2;
  }

  return cursorY + 2;
}

function measureStoreContactLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  config: NormalizedArabicBitmapPrinterConfig
): number {
  if (lines.length === 0) {
    return 0;
  }

  const style = centeredStyle(19, config);

  return (
    lines.reduce(
      (height, line) =>
        height + measureTextBlock(context, line, style, getContentWidth(config)) + 2,
      0
    ) + 2
  );
}

function drawBarcodeBlock(
  context: CanvasRenderingContext2D,
  value: string,
  config: NormalizedArabicBitmapPrinterConfig,
  y: number,
  barcodeImage: Image
): number {
  const contentWidth = getContentWidth(config);
  const targetWidth = Math.min(
    BARCODE_MAX_WIDTH_DOTS,
    contentWidth - BARCODE_QUIET_ZONE_DOTS * 2
  );
  const startX = Math.round((config.widthDots - targetWidth) / 2);

  context.drawImage(barcodeImage, startX, y, targetWidth, BARCODE_BAR_HEIGHT_DOTS);

  drawTextBlock(
    context,
    value,
    { ...moneyStyle(18, 400, config), align: "center" },
    PAGE_PADDING_DOTS,
    y + BARCODE_BAR_HEIGHT_DOTS + BARCODE_LABEL_GAP_DOTS,
    contentWidth
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

function drawTable(
  context: CanvasRenderingContext2D,
  rows: TableRow[],
  columns: TableColumn[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number,
  drawHeader: boolean
): number {
  const cellRects = getTableCellRects(columns, config);
  let cursorY = y;

  if (drawHeader) {
    cursorY = drawTableHeader(context, columns, cellRects, config, cursorY);
  }

  for (const row of rows) {
    cursorY = drawTableRow(context, row, columns, cellRects, config, cursorY);
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
  const cellRects = getTableCellRects(columns, config);
  let height = includeHeader
    ? measureTableRow(context, headerRow(columns), columns, cellRects, config)
    : 0;

  for (const row of rows) {
    height += measureTableRow(context, row, columns, cellRects, config);
  }

  return height;
}

function drawTableHeader(
  context: CanvasRenderingContext2D,
  columns: TableColumn[],
  cellRects: CellRect[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const row = headerRow(columns);
  const rowHeight = measureTableRow(context, row, columns, cellRects, config);
  const nextY = drawTableRow(context, row, columns, cellRects, config, y);

  drawHorizontalLine(context, PAGE_PADDING_DOTS, y + rowHeight - 1, getContentWidth(config));

  return nextY;
}

function drawTableRow(
  context: CanvasRenderingContext2D,
  row: TableRow,
  columns: TableColumn[],
  cellRects: CellRect[],
  config: NormalizedArabicBitmapPrinterConfig,
  y: number
): number {
  const rowHeight = measureTableRow(context, row, columns, cellRects, config);

  row.cells.forEach((cell, index) => {
    const rect = cellRects[index];
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
  cellRects: CellRect[],
  config: NormalizedArabicBitmapPrinterConfig
): number {
  const maxCellHeight = row.cells.reduce((height, cell, index) => {
    const rect = cellRects[index];

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
    if (row.dividerBefore) {
      cursorY = drawRule(context, config, cursorY + 4) + 6;
    }

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
    const dividerHeight = row.dividerBefore ? 11 : 0;

    return (
      height +
      dividerHeight +
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
  if (registeredFontFamilies.has(NOTO_NASKH_FONT_FAMILY)) {
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
  registeredFontFamilies.add(NOTO_NASKH_FONT_FAMILY);
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
      align: column.headerAlign ?? column.align,
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

function formatDiscountLabel(discount: ReceiptDiscount): string {
  if (discount.type === "percent") {
    return formatDiscountValue(discount);
  }

  return "\u062b\u0627\u0628\u062a";
}

function resolveOption(
  options: NodeCanvasArabicBitmapReceiptOptions,
  key: keyof NodeCanvasArabicBitmapReceiptOptions,
  fallback: string | null | undefined
): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(options, key)
    ? options[key]
    : fallback;

  return normalizeOptionalText(value);
}

function resolvePaymentMethod(
  receipt: ArabicReceipt,
  options: NodeCanvasArabicBitmapReceiptOptions
): string | undefined {
  return resolveOption(options, "paymentMethod", receipt.paidWith);
}

function resolveThankYouMessage(
  receipt: ArabicReceipt,
  options: NodeCanvasArabicBitmapReceiptOptions
): string {
  return resolveOption(options, "thankYouMessage", receipt.thankYouMessage) ?? DEFAULT_THANK_YOU_MESSAGE;
}

function resolveQrCodeUrl(
  receipt: ArabicReceipt,
  options: NodeCanvasArabicBitmapReceiptOptions
): string | undefined {
  return resolveOption(options, "qrCodeUrl", receipt.qrCodeUrl);
}

function resolvePrintedByMessage(
  receipt: ArabicReceipt,
  options: NodeCanvasArabicBitmapReceiptOptions
): string | undefined {
  return resolveOption(options, "printedByMessage", receipt.printedByMessage);
}

function getStoreContactLines(receipt: ArabicReceipt): string[] {
  const phones = receipt.storePhones?.map((phone) => phone.trim()).filter(Boolean) ?? [];
  const email = normalizeOptionalText(receipt.storeEmail);
  const lines: string[] = [];

  if (phones.length > 0) {
    lines.push(`الهاتف: ${phones.join(" / ")}`);
  }

  if (email) {
    lines.push(`البريد الالكتروني: ${email}`);
  }

  return lines;
}

function formatMetadataLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function getReceiptItemCount(receipt: ArabicReceipt): number {
  return receipt.items.reduce((sum, item) => sum + item.quantity, 0);
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : parseFloat(value.toFixed(2)).toString();
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function formatPaymentMethodLine(paymentMethod: string): string {
  return `${PAYMENT_METHOD_LABEL} ${paymentMethod}`;
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
