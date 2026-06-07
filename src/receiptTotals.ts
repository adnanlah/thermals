export type ReceiptDiscount =
  | {
      type: "percent";
      value: number;
    }
  | {
      type: "fixed";
      value: number;
    };

export type ReceiptLineForTotals = {
  quantity: number;
  unitPrice: number;
  discount?: ReceiptDiscount;
};

export type ReceiptLineTotals<TItem extends ReceiptLineForTotals> = {
  item: TItem;
  grossTotal: number;
  discountAmount: number;
  netTotal: number;
};

export type ReceiptTotals<TItem extends ReceiptLineForTotals> = {
  lines: ReceiptLineTotals<TItem>[];
  subtotalBeforeDiscounts: number;
  lineDiscountTotal: number;
  subtotalAfterLineDiscounts: number;
  globalDiscountAmount: number;
  taxableSubtotal: number;
  tax: number;
  total: number;
};

export function calculateReceiptTotals<TItem extends ReceiptLineForTotals>(
  items: TItem[],
  taxRate: number,
  globalDiscount?: ReceiptDiscount
): ReceiptTotals<TItem> {
  const lines = items.map((item) => {
    const grossTotal = roundMoney(item.quantity * item.unitPrice);
    const discountAmount = calculateDiscountAmount(item.discount, grossTotal);
    const netTotal = roundMoney(grossTotal - discountAmount);

    return {
      item,
      grossTotal,
      discountAmount,
      netTotal
    };
  });
  const subtotalBeforeDiscounts = roundMoney(
    lines.reduce((sum, line) => sum + line.grossTotal, 0)
  );
  const lineDiscountTotal = roundMoney(
    lines.reduce((sum, line) => sum + line.discountAmount, 0)
  );
  const subtotalAfterLineDiscounts = roundMoney(
    subtotalBeforeDiscounts - lineDiscountTotal
  );
  const globalDiscountAmount = calculateDiscountAmount(
    globalDiscount,
    subtotalAfterLineDiscounts
  );
  const taxableSubtotal = roundMoney(
    subtotalAfterLineDiscounts - globalDiscountAmount
  );
  const tax = roundMoney(taxableSubtotal * taxRate);
  const total = roundMoney(taxableSubtotal + tax);

  return {
    lines,
    subtotalBeforeDiscounts,
    lineDiscountTotal,
    subtotalAfterLineDiscounts,
    globalDiscountAmount,
    taxableSubtotal,
    tax,
    total
  };
}

export function calculateDiscountAmount(
  discount: ReceiptDiscount | undefined,
  baseAmount: number
): number {
  if (!discount || baseAmount <= 0) {
    return 0;
  }

  if (discount.type === "percent") {
    return roundMoney(baseAmount * (clamp(discount.value, 0, 100) / 100));
  }

  return roundMoney(clamp(discount.value, 0, baseAmount));
}

export function formatDiscountValue(discount: ReceiptDiscount): string {
  if (discount.type === "percent") {
    return `${trimTrailingZeros(discount.value)}%`;
  }

  return trimTrailingZeros(discount.value);
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function trimTrailingZeros(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
