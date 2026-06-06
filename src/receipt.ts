import {
  BreakLine,
  CharacterSet,
  ThermalPrinter
} from "node-thermal-printer";
import { receiptPrinterConfig } from "./config";

const receiptCharacterSet = CharacterSet.WPC1256_ARABIC;

export type ReceiptLineItem = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export type Receipt = {
  storeName: string;
  storeAddress: string;
  cashier: string;
  orderNumber: string;
  items: ReceiptLineItem[];
  taxRate: number;
  paidWith: string;
};

export function buildSampleReceipt(): Receipt {
  return {
    storeName: "THERMAL DEMO SHOP",
    storeAddress: "123 Printer Lane",
    cashier: "Amina",
    orderNumber: "R-10042",
    taxRate: 0.07,
    paidWith: "CARD",
    items: [
      { name: "Coffee", quantity: 2, unitPrice: 2.5 },
      { name: "Croissant", quantity: 1, unitPrice: 3.25 },
      { name: "Notebook", quantity: 1, unitPrice: 5.99 }
    ]
  };
}

export function createReceiptBuffer(receipt: Receipt): Buffer {
  const printer = new ThermalPrinter({
    type: receiptPrinterConfig.type,
    width: receiptPrinterConfig.width,
    interface: "webusb-buffer",
    removeSpecialCharacters: false,
    breakLine: BreakLine.WORD,
    lineCharacter: "-"
  });

  printer.add(Buffer.from([0x1b, 0x40, 0x1b, 0x3d, 0x01]));
  printer.setCharacterSet(receiptCharacterSet);

  const subtotal = receipt.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0
  );
  const tax = roundMoney(subtotal * receipt.taxRate);
  const total = roundMoney(subtotal + tax);

  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(receipt.storeName);
  printer.bold(false);
  printer.setTextNormal();
  printer.println(receipt.storeAddress);
  printer.println(new Date().toLocaleString());
  printer.newLine();

  printer.alignLeft();
  printer.leftRight("Order", receipt.orderNumber);
  printer.leftRight("Cashier", receipt.cashier);
  printer.drawLine();

  for (const item of receipt.items) {
    printer.println(item.name);
    printer.leftRight(
      `${item.quantity} x ${formatMoney(item.unitPrice)}`,
      formatMoney(item.quantity * item.unitPrice)
    );
  }

  printer.drawLine();
  printer.leftRight("Subtotal", formatMoney(subtotal));
  printer.leftRight(`Tax ${Math.round(receipt.taxRate * 100)}%`, formatMoney(tax));
  printer.bold(true);
  printer.leftRight("Total", formatMoney(total));
  printer.bold(false);
  printer.leftRight("Paid with", receipt.paidWith);

  printer.newLine();
  printer.alignCenter();
  printer.println("Thank you!");
  printer.newLine();
  printer.cut();

  return printer.getBuffer();
}

function formatMoney(value: number): string {
  return `$${roundMoney(value).toFixed(2)}`;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
