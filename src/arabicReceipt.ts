import {
  BreakLine,
  ThermalPrinter
} from "node-thermal-printer";
import { receiptPrinterConfig } from "./config";

export type ArabicReceiptLineItem = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export type ArabicReceipt = {
  storeName: string;
  storeAddress: string;
  cashier: string;
  orderNumber: string;
  items: ArabicReceiptLineItem[];
  taxRate: number;
  paidWith: string;
};

export const arabicReceiptPayload: ArabicReceipt = {
  storeName: "متجر الطابعة الحرارية",
  storeAddress: "شارع التجربة 123",
  cashier: "أمينة",
  orderNumber: "AR-10042",
  taxRate: 0.07,
  paidWith: "بطاقة بنكية",
  items: [
    { name: "قهوة", quantity: 2, unitPrice: 250 },
    { name: "كرواسون", quantity: 1, unitPrice: 325 },
    { name: "دفتر", quantity: 1, unitPrice: 599 }
  ]
};

export function createArabicReceiptBuffer(
  receipt: ArabicReceipt = arabicReceiptPayload
): Buffer {
  const printer = new ThermalPrinter({
    type: receiptPrinterConfig.type,
    width: receiptPrinterConfig.width,
    interface: "webusb-buffer",
    removeSpecialCharacters: false,
    breakLine: BreakLine.WORD,
    lineCharacter: "-"
  });

  printer.add(Buffer.from([0x1b, 0x40, 0x1b, 0x3d, 0x01]));
  printer.setCharacterSet(receiptPrinterConfig.arabicCharacterSet);

  const subtotal = receipt.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );
  const tax = roundMoney(subtotal * receipt.taxRate);
  const total = roundMoney(subtotal + tax);

  printArabicCentered(printer, receipt.storeName, true);
  printArabicCentered(printer, receipt.storeAddress);
  printArabicCentered(printer, formatArabicDate(new Date()));
  printer.newLine();

  printArabicLine(printer, `رقم الطلب: ${receipt.orderNumber}`);
  printArabicLine(printer, `الكاشير: ${receipt.cashier}`);
  printer.drawLine();

  for (const item of receipt.items) {
    printArabicLine(printer, item.name);
    printArabicLine(
      printer,
      `${item.quantity} x ${formatArabicMoney(item.unitPrice)} = ${formatArabicMoney(
        item.quantity * item.unitPrice
      )}`
    );
  }

  printer.drawLine();
  printArabicLine(printer, `المجموع الفرعي: ${formatArabicMoney(subtotal)}`);
  printArabicLine(
    printer,
    `الضريبة ${Math.round(receipt.taxRate * 100)}%: ${formatArabicMoney(tax)}`
  );
  printer.bold(true);
  printArabicLine(printer, `الإجمالي: ${formatArabicMoney(total)}`);
  printer.bold(false);
  printArabicLine(printer, `طريقة الدفع: ${receipt.paidWith}`);

  printer.newLine();
  printArabicCentered(printer, "شكرا لزيارتكم");
  printer.newLine();
  printer.cut();

  return printer.getBuffer();
}

function printArabicCentered(
  printer: ThermalPrinter,
  text: string,
  isTitle = false
): void {
  printer.alignCenter();

  if (isTitle) {
    printer.setTextDoubleHeight();
    printer.bold(true);
  }

  printer.println(formatArabicForPrinter(text));

  if (isTitle) {
    printer.bold(false);
    printer.setTextNormal();
  }
}

function printArabicLine(printer: ThermalPrinter, text: string): void {
  printer.alignRight();
  printer.println(formatArabicForPrinter(text));
}

function formatArabicForPrinter(text: string): string {
  if (!receiptPrinterConfig.reverseArabicOutput) {
    return text;
  }

  return reverseRtlTextForSingleBytePrinter(text);
}

function reverseRtlTextForSingleBytePrinter(text: string): string {
  const tokens = text.match(/[A-Za-z0-9.,/\\\-+%]+|\s+|./gu) ?? [];

  return tokens.reverse().join("");
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
