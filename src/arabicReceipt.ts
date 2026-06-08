import {
  BreakLine,
  ThermalPrinter
} from "node-thermal-printer";
import { receiptPrinterConfig } from "./config";
import {
  calculateReceiptTotals,
  formatDiscountValue,
  ReceiptDiscount,
  roundMoney
} from "./receiptTotals";

export type ArabicReceiptLineItem = {
  name: string;
  quantity: number;
  unitName: string;
  unitPrice: number;
  discount?: ReceiptDiscount;
};

export type ArabicReceipt = {
  storeName: string;
  storeAddress: string;
  storePhones?: string[];
  storeEmail?: string;
  clientName?: string;
  cashier: string;
  cashierPostNumber?: string;
  orderNumber: string;
  items: ArabicReceiptLineItem[];
  taxRate: number;
  globalDiscount?: ReceiptDiscount;
  paidWith: string;
  thankYouMessage?: string;
  printedByMessage?: string;
};

export const arabicReceiptPayload: ArabicReceipt = {
  storeName: "متجر الطابعة الحرارية",
  storeAddress: "شارع التجربة 123",
  storePhones: ["0555112233", "0666445566"],
  storeEmail: "contact@example.com",
  clientName: "زبون نقدي",
  cashier: "عدنان",
  cashierPostNumber: "POS-01",
  orderNumber: "AR-10042",
  taxRate: 0.07,
  globalDiscount: { type: "fixed", value: 100 },
  paidWith: "بطاقة بنكية",
  thankYouMessage: "شكرا لزيارتكم",
  printedByMessage: "طبع بواسطة: www.steppe.info",
  items: [
    {
      name: "قهوة",
      quantity: 2,
      unitName: "كوب",
      unitPrice: 123250,
      discount: { type: "percent", value: 10 }
    },
    {
      name: "كرواسون",
      quantity: 1,
      unitName: "قطعة",
      unitPrice: 72305,
      discount: { type: "fixed", value: 25 }
    },
    { name: "دفتر", quantity: 1, unitName: "قطعة", unitPrice: 1599 },
    { name: "دفتر", quantity: 1, unitName: "قطعة", unitPrice: 1599 },
    { name: "دفتر", quantity: 1, unitName: "قطعة", unitPrice: 1599 },
    { name: "دفتر", quantity: 1, unitName: "قطعة", unitPrice: 1599 },
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

  const totals = calculateReceiptTotals(
    receipt.items,
    receipt.taxRate,
    receipt.globalDiscount
  );

  printArabicCentered(printer, receipt.storeName, true);
  printArabicCentered(printer, receipt.storeAddress);
  printArabicCentered(printer, formatArabicDate(new Date()));
  printer.newLine();

  printArabicLine(printer, `رقم الطلب: ${receipt.orderNumber}`);
  printArabicLine(printer, `الكاشير: ${receipt.cashier}`);
  printer.drawLine();

  for (const line of totals.lines) {
    const item = line.item;

    printArabicLine(printer, item.name);
    printArabicLine(
      printer,
      `${item.quantity} ${item.unitName} * ${formatArabicMoney(
        item.unitPrice
      )} = ${formatArabicMoney(line.grossTotal)}`
    );

    if (line.discountAmount > 0 && item.discount) {
      printArabicLine(
        printer,
        `خصم ${formatDiscountLabel(item.discount)}: -${formatArabicMoney(
          line.discountAmount
        )}`
      );
      printArabicLine(printer, `بعد الخصم: ${formatArabicMoney(line.netTotal)}`);
    }
  }

  printer.drawLine();
  printArabicLine(
    printer,
    `المجموع قبل الخصم: ${formatArabicMoney(totals.subtotalBeforeDiscounts)}`
  );

  if (totals.lineDiscountTotal > 0) {
    printArabicLine(
      printer,
      `خصم السطور: -${formatArabicMoney(totals.lineDiscountTotal)}`
    );
  }

  if (totals.globalDiscountAmount > 0 && receipt.globalDiscount) {
    printArabicLine(
      printer,
      `الخصم العام ${formatDiscountLabel(
        receipt.globalDiscount
      )}: -${formatArabicMoney(totals.globalDiscountAmount)}`
    );
  }

  printArabicLine(
    printer,
    `المبلغ الخاضع للضريبة: ${formatArabicMoney(totals.taxableSubtotal)}`
  );
  printArabicLine(
    printer,
    `الضريبة ${Math.round(receipt.taxRate * 100)}%: ${formatArabicMoney(
      totals.tax
    )}`
  );
  printer.bold(true);
  printArabicLine(printer, `الإجمالي: ${formatArabicMoney(totals.total)}`);
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
