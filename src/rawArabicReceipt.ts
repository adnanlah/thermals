import { encode } from "iconv-lite";
import { ArabicReceipt } from "./arabicReceipt";
import {
  calculateReceiptTotals,
  formatDiscountValue,
  ReceiptDiscount,
  roundMoney
} from "./receiptTotals";

type ArabicCodePage = {
  encoding: string;
  escTValue: number;
};

const windows1256Arabic: ArabicCodePage = {
  encoding: "win1256",
  // Xprinter/ESC-POS clone mapping used by node-thermal-printer for WPC1256.
  escTValue: 50
};

export function createRawArabicReceiptBuffer(receipt: ArabicReceipt): Buffer {
  const totals = calculateReceiptTotals(
    receipt.items,
    receipt.taxRate,
    receipt.globalDiscount
  );
  const parts: Buffer[] = [];

  add(parts, esc(0x40)); // Initialize printer.
  add(parts, esc(0x3d, 0x01)); // Select printer.
  add(parts, Buffer.from([0x1c, 0x2e])); // Cancel Chinese/Kanji mode.
  selectCodePage(parts, windows1256Arabic);

  center(parts);
  bold(parts, true);
  add(parts, encodeArabicLine(receipt.storeName));
  bold(parts, false);
  add(parts, encodeArabicLine(receipt.storeAddress));
  add(parts, encodeArabicLine(formatArabicDate(new Date())));
  lineFeed(parts);

  right(parts);
  add(parts, encodeArabicLine(`رقم الطلب: ${receipt.orderNumber}`));
  add(parts, encodeArabicLine(`الكاشير: ${receipt.cashier}`));
  drawLine(parts);

  for (const line of totals.lines) {
    const item = line.item;

    add(parts, encodeArabicLine(item.name));
    add(
      parts,
      encodeArabicLine(
        `${item.quantity} ${item.unitName} * ${formatArabicMoney(
          item.unitPrice
        )} = ${formatArabicMoney(line.grossTotal)}`
      )
    );

    if (line.discountAmount > 0 && item.discount) {
      add(
        parts,
        encodeArabicLine(
          `خصم ${formatDiscountLabel(item.discount)}: -${formatArabicMoney(
            line.discountAmount
          )}`
        )
      );
      add(parts, encodeArabicLine(`بعد الخصم: ${formatArabicMoney(line.netTotal)}`));
    }
  }

  drawLine(parts);
  add(
    parts,
    encodeArabicLine(
      `المجموع قبل الخصم: ${formatArabicMoney(totals.subtotalBeforeDiscounts)}`
    )
  );

  if (totals.lineDiscountTotal > 0) {
    add(
      parts,
      encodeArabicLine(`خصم السطور: -${formatArabicMoney(totals.lineDiscountTotal)}`)
    );
  }

  if (totals.globalDiscountAmount > 0 && receipt.globalDiscount) {
    add(
      parts,
      encodeArabicLine(
        `الخصم العام ${formatDiscountLabel(
          receipt.globalDiscount
        )}: -${formatArabicMoney(totals.globalDiscountAmount)}`
      )
    );
  }

  add(
    parts,
    encodeArabicLine(
      `المبلغ الخاضع للضريبة: ${formatArabicMoney(totals.taxableSubtotal)}`
    )
  );
  add(
    parts,
    encodeArabicLine(
      `الضريبة ${Math.round(receipt.taxRate * 100)}%: ${formatArabicMoney(
        totals.tax
      )}`
    )
  );
  bold(parts, true);
  add(parts, encodeArabicLine(`الإجمالي: ${formatArabicMoney(totals.total)}`));
  bold(parts, false);
  add(parts, encodeArabicLine(`طريقة الدفع: ${receipt.paidWith}`));

  lineFeed(parts);
  center(parts);
  add(parts, encodeArabicLine("شكرا لزيارتكم"));
  lineFeed(parts, 2);
  add(parts, Buffer.from([0x1d, 0x56, 0x00])); // Full cut when supported.

  return Buffer.concat(parts);
}

function encodeArabicLine(text: string): Buffer {
  return Buffer.concat([
    encode(formatArabicForSingleBytePrinter(text), windows1256Arabic.encoding),
    Buffer.from("\r\n", "ascii")
  ]);
}

function formatArabicForSingleBytePrinter(text: string): string {
  return reverseRtlTextForSingleBytePrinter(text);
}

function reverseRtlTextForSingleBytePrinter(text: string): string {
  const tokens = text.match(/[A-Za-z0-9.,/\\\-+%]+|\s+|./gu) ?? [];

  return tokens.reverse().join("");
}

function selectCodePage(parts: Buffer[], codePage: ArabicCodePage): void {
  add(parts, esc(0x74, codePage.escTValue));
}

function center(parts: Buffer[]): void {
  add(parts, esc(0x61, 0x01));
}

function right(parts: Buffer[]): void {
  add(parts, esc(0x61, 0x02));
}

function bold(parts: Buffer[], enabled: boolean): void {
  add(parts, esc(0x45, enabled ? 0x01 : 0x00));
}

function drawLine(parts: Buffer[]): void {
  add(parts, Buffer.from("----------------------------------------\r\n", "ascii"));
}

function lineFeed(parts: Buffer[], count = 1): void {
  add(parts, Buffer.from("\r\n".repeat(count), "ascii"));
}

function esc(...bytes: number[]): Buffer {
  return Buffer.from([0x1b, ...bytes]);
}

function add(parts: Buffer[], buffer: Buffer): void {
  parts.push(buffer);
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
