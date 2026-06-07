import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer";
import { ArabicReceipt } from "./arabicReceipt";
import {
  NormalizedArabicBitmapPrinterConfig,
  normalizeArabicBitmapPrinterConfig
} from "./arabicBitmapConfig";
import {
  createMonochromePreviewPngBuffer,
  readPngAsRgbaImage
} from "./bitmapPreview";
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

export type PuppeteerArabicBitmapReceipt = {
  escposBuffer: Buffer;
  pngBuffer: Buffer;
  html: string;
  widthDots: number;
  heightDots: number;
  printerDpi: number;
  renderScale: number;
  monochromeThreshold: number;
};

type RenderedScreenshot = {
  pngBuffer: Buffer;
  cssHeightDots: number;
};

const PUPPETEER_FONT_FAMILY = "Noto Naskh Arabic";
const PUPPETEER_FONT_PATH = join(
  process.cwd(),
  "src",
  "assets",
  "NotoNaskhArabic-VariableFont_wght.ttf"
);
let cachedFontFaceCss: string | undefined;

export async function createArabicBitmapReceiptWithPuppeteer(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<PuppeteerArabicBitmapReceipt> {
  const config = normalizeArabicBitmapPrinterConfig(bitmapConfig);
  const html = createReceiptHtml(receipt, config);
  // One CSS pixel represents one final printer dot; deviceScaleFactor supplies
  // the supersampled source image used before the final 1-bit conversion.
  const screenshot = await renderReceiptScreenshot(html, config);
  const rgbaImage = await readPngAsRgbaImage(screenshot.pngBuffer);
  const rasterSource = {
    data: rgbaImage.data,
    sourceWidth: rgbaImage.width,
    sourceHeight: rgbaImage.height,
    targetWidth: config.widthDots,
    targetHeight: screenshot.cssHeightDots,
    monochromeThreshold: config.monochromeThreshold
  };
  const escposBuffer = createEscposBitmapPrintBuffer({
    ...rasterSource,
    feedAfterReceiptLines: config.feedAfterReceiptLines,
    cutAfterPrint: config.cutAfterPrint
  });

  return {
    escposBuffer,
    pngBuffer: createMonochromePreviewPngBuffer(rasterSource, config.printerDpi),
    html,
    widthDots: config.widthDots,
    heightDots: screenshot.cssHeightDots,
    printerDpi: config.printerDpi,
    renderScale: config.renderScale,
    monochromeThreshold: config.monochromeThreshold
  };
}

export async function createArabicBitmapReceiptBufferWithPuppeteer(
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<Buffer> {
  return (
    await createArabicBitmapReceiptWithPuppeteer(receipt, bitmapConfig)
  ).escposBuffer;
}

export async function saveArabicBitmapReceiptPreviewWithPuppeteer(
  outputPath: string,
  receipt: ArabicReceipt,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<PuppeteerArabicBitmapReceipt> {
  const rendered = await createArabicBitmapReceiptWithPuppeteer(
    receipt,
    bitmapConfig
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered.pngBuffer);

  return rendered;
}

export async function printArabicBitmapReceiptWithPuppeteer(
  receipt: ArabicReceipt,
  printerConfig: SystemPrinterConfig = systemPrinterConfig,
  bitmapConfig: ArabicBitmapPrinterConfig = arabicBitmapPrinterConfig
): Promise<string> {
  const buffer = await createArabicBitmapReceiptBufferWithPuppeteer(
    receipt,
    bitmapConfig
  );

  return printBufferWithSystemPrinter(buffer, {
    ...printerConfig,
    docName: "Arabic Puppeteer Bitmap Thermal Receipt"
  });
}

async function renderReceiptScreenshot(
  html: string,
  config: NormalizedArabicBitmapPrinterConfig
): Promise<RenderedScreenshot> {
  const browser = await puppeteer.launch({
    headless: true,
    ...getLocalBrowserLaunchOptions(),
    args: [
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--font-render-hinting=none"
    ],
    defaultViewport: {
      width: config.widthDots,
      height: 1200,
      deviceScaleFactor: config.renderScale
    }
  });

  try {
    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "load"
    });
    await page.emulateMediaType("screen");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const receiptElement = await page.$(".receipt");

    if (!receiptElement) {
      throw new Error("Puppeteer receipt element was not rendered.");
    }

    const cssHeightDots = await receiptElement.evaluate((element) =>
      Math.ceil(element.getBoundingClientRect().height)
    );
    const screenshot = await receiptElement.screenshot({
      type: "png",
      omitBackground: false
    });

    return {
      pngBuffer: Buffer.from(screenshot),
      cssHeightDots
    };
  } finally {
    await browser.close();
  }
}

function getLocalBrowserLaunchOptions(): { executablePath?: string } {
  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || findLocalBrowserExecutable();

  return executablePath ? { executablePath } : {};
}

function findLocalBrowserExecutable(): string | undefined {
  const candidates = [
    joinIfDefined(process.env.PROGRAMFILES, "Google\\Chrome\\Application\\chrome.exe"),
    joinIfDefined(
      process.env["PROGRAMFILES(X86)"],
      "Google\\Chrome\\Application\\chrome.exe"
    ),
    joinIfDefined(
      process.env.LOCALAPPDATA,
      "Google\\Chrome\\Application\\chrome.exe"
    ),
    joinIfDefined(process.env.PROGRAMFILES, "Microsoft\\Edge\\Application\\msedge.exe"),
    joinIfDefined(
      process.env["PROGRAMFILES(X86)"],
      "Microsoft\\Edge\\Application\\msedge.exe"
    )
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function joinIfDefined(root: string | undefined, suffix: string): string | undefined {
  return root ? `${root}\\${suffix}` : undefined;
}

function createReceiptHtml(
  receipt: ArabicReceipt,
  config: NormalizedArabicBitmapPrinterConfig
): string {
  const totals = calculateReceiptTotals(
    receipt.items,
    receipt.taxRate,
    receipt.globalDiscount
  );
  const itemRows = totals.lines.map((line) => {
    const item = line.item;
    const discountRows =
      line.discountAmount > 0 && item.discount
        ? `
          <tr class="discount-row">
            <td colspan="3">خصم ${escapeHtml(formatDiscountLabel(item.discount))}</td>
            <td><bdi class="money">-${escapeHtml(formatArabicMoney(line.discountAmount))}</bdi></td>
          </tr>
          <tr class="discount-row">
            <td colspan="3">بعد الخصم</td>
            <td><bdi class="money">${escapeHtml(formatArabicMoney(line.netTotal))}</bdi></td>
          </tr>
        `
        : "";

    return `
      <tr>
        <td class="item-name">${escapeHtml(item.name)}</td>
        <td class="quantity">
          <bdi class="number">${escapeHtml(String(item.quantity))}</bdi>
          <span>${escapeHtml(item.unitName)}</span>
        </td>
        <td><bdi class="money">${escapeHtml(formatArabicMoney(item.unitPrice))}</bdi></td>
        <td><bdi class="money">${escapeHtml(formatArabicMoney(line.grossTotal))}</bdi></td>
      </tr>
      ${discountRows}
    `;
  });
  const lineDiscountRow =
    totals.lineDiscountTotal > 0
      ? summaryRow(
          "خصم السطور:",
          `-${formatArabicMoney(totals.lineDiscountTotal)}`
        )
      : "";
  const globalDiscountRow =
    totals.globalDiscountAmount > 0 && receipt.globalDiscount
      ? summaryRow(
          `الخصم العام ${formatDiscountLabel(receipt.globalDiscount)}:`,
          `-${formatArabicMoney(totals.globalDiscountAmount)}`
        )
      : "";

  return `<!doctype html>
<html lang="ar-DZ" dir="rtl">
<head>
  <meta charset="utf-8" />
  <style>${createReceiptStyles(config)}</style>
</head>
<body>
  <main class="receipt">
    <header class="header">
      <h1 class="store-name">${escapeHtml(receipt.storeName)}</h1>
      <div class="store-address">${escapeHtml(receipt.storeAddress)}</div>
      <div class="date">${escapeHtml(formatArabicDate(new Date()))}</div>
    </header>

    <section class="order-row">
      <div>رقم الطلب: <bdi dir="ltr">${escapeHtml(receipt.orderNumber)}</bdi></div>
      <div>الكاشير: ${escapeHtml(receipt.cashier)}</div>
    </section>

    <div class="rule"></div>
    <table class="items-table">
      <thead>
        <tr>
          <th>الصنف</th>
          <th>الكمية</th>
          <th>السعر</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        ${itemRows.join("")}
      </tbody>
    </table>
    <div class="rule"></div>

    <section class="summary">
      ${summaryRow("المجموع قبل الخصم:", formatArabicMoney(totals.subtotalBeforeDiscounts))}
      ${lineDiscountRow}
      ${globalDiscountRow}
      ${summaryRow("المبلغ الخاضع للضريبة:", formatArabicMoney(totals.taxableSubtotal))}
      ${summaryRow(`الضريبة ${Math.round(receipt.taxRate * 100)}%:`, formatArabicMoney(totals.tax))}
      ${summaryRow("الإجمالي:", formatArabicMoney(totals.total), "total")}
    </section>

    <div class="paid">طريقة الدفع: ${escapeHtml(receipt.paidWith)}</div>
    <div class="thanks">شكرا لزيارتكم</div>
  </main>
</body>
</html>`;
}

function createReceiptStyles(
  config: NormalizedArabicBitmapPrinterConfig
): string {
  return `
    ${getPuppeteerFontFaceCss()}

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      width: ${config.widthDots}px;
      background: #fff;
      color: #000;
      font-family: ${cssFontFamily(PUPPETEER_FONT_FAMILY)}, Arial, sans-serif;
      text-rendering: geometricPrecision;
      -webkit-font-smoothing: antialiased;
    }

    .receipt {
      width: ${config.widthDots}px;
      padding: 8px 8px 12px;
      background: #fff;
      direction: rtl;
      font-size: 24px;
      line-height: 1.22;
    }

    .header {
      text-align: center;
      margin-bottom: 10px;
    }

    .store-name {
      margin: 0 0 4px;
      font-size: 32px;
      font-weight: 800;
      line-height: 1.1;
    }

    .store-address,
    .date {
      font-size: 23px;
    }

    .order-row {
      margin: 18px 0 10px;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      direction: rtl;
      font-size: 22px;
      line-height: 1.1;
    }

    .rule {
      height: 1px;
      margin: 8px -8px 8px;
      background: #000;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      direction: rtl;
      font-size: 18px;
      line-height: 1.15;
    }

    .items-table th,
    .items-table td {
      padding: 2px 3px;
      text-align: right;
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    .items-table th {
      border-bottom: 1px solid #000;
      font-weight: 700;
      white-space: nowrap;
    }

    .items-table th:nth-child(1),
    .items-table td:nth-child(1) {
      width: 34%;
    }

    .items-table th:nth-child(2),
    .items-table td:nth-child(2) {
      width: 20%;
    }

    .items-table th:nth-child(3),
    .items-table td:nth-child(3),
    .items-table th:nth-child(4),
    .items-table td:nth-child(4) {
      width: 23%;
    }

    .item-name {
      font-size: 19px;
      font-weight: 400;
    }

    .quantity {
      direction: rtl;
      unicode-bidi: isolate;
    }

    .money,
    .number {
      direction: ltr;
      unicode-bidi: isolate;
      white-space: nowrap;
    }

    .discount-row td {
      padding-top: 0;
      font-size: 17px;
      line-height: 1.05;
    }

    .summary-row {
      display: flex;
      direction: rtl;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      font-size: 23px;
      line-height: 1.16;
      white-space: nowrap;
    }

    .summary {
      display: grid;
      gap: 4px;
      font-size: 24px;
      text-align: right;
    }

    .total {
      margin-top: 2px;
      font-size: 28px;
      font-weight: 800;
    }

    .paid {
      margin-top: 4px;
      font-size: 24px;
      text-align: right;
    }

    .thanks {
      margin-top: 34px;
      text-align: center;
      font-size: 26px;
      font-weight: 800;
    }
  `;
}

function summaryRow(label: string, value: string, extraClass = ""): string {
  return `
    <div class="summary-row ${extraClass}">
      <span>${escapeHtml(label)}</span>
      <bdi class="money">${escapeHtml(value)}</bdi>
    </div>
  `;
}

function formatDiscountLabel(discount: ReceiptDiscount): string {
  if (discount.type === "percent") {
    return formatDiscountValue(discount);
  }

  return formatArabicMoney(discount.value);
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

function getPuppeteerFontFaceCss(): string {
  if (cachedFontFaceCss) {
    return cachedFontFaceCss;
  }

  if (!existsSync(PUPPETEER_FONT_PATH)) {
    throw new Error(`Missing Puppeteer receipt font: ${PUPPETEER_FONT_PATH}`);
  }

  const fontBase64 = readFileSync(PUPPETEER_FONT_PATH).toString("base64");

  cachedFontFaceCss = `
    @font-face {
      font-family: ${cssFontFamily(PUPPETEER_FONT_FAMILY)};
      src: url("data:font/ttf;base64,${fontBase64}") format("truetype");
      font-weight: 400 800;
      font-style: normal;
      font-display: block;
    }
  `;

  return cachedFontFaceCss;
}

function cssFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/"/g, "")}"`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
