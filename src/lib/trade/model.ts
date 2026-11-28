import { z } from "zod";
import { Exact, accountDate, amount, reasonText } from "@/lib/engine/model";

export const tradeTypes = ["sale", "purchase", "sale_return", "purchase_return"] as const;
export const tradeType = z.enum(tradeTypes);
export type TradeType = z.infer<typeof tradeType>;
export const tradeNames: Record<TradeType, string> = {
  sale: "Sales invoice", purchase: "Purchase invoice", sale_return: "Sale return", purchase_return: "Purchase return",
};

/** Product lines move stock and cost; Services and Freight / Transportation lines post only to their own income or expense. */
export const lineTypes = ["product", "services", "freight"] as const;
export type LineType = typeof lineTypes[number];
export const lineTypeNames: Record<LineType, string> = { product: "Product", services: "Services", freight: "Freight / Transportation" };
/** System account tags used by non-product lines. Sale returns of every line type use Sales Returns. */
export const lineTypeAccounts: Record<Exclude<LineType, "product">, { income: string; expense: string }> = {
  services: { income: "service_income", expense: "service_expense" },
  freight: { income: "freight_income", expense: "freight_expense" },
};
export const lineTypeLabel = (value: string | null | undefined) =>
  value?.split(/,\s*/).filter(Boolean).map((part) => lineTypeNames[part as LineType] ?? part).join(", ") ?? "";

export const adjustmentKinds = ["add", "deduct", "count", "damaged", "lost", "excess", "opening", "opening_correction", "valuation"] as const;
export const adjustmentNames: Record<typeof adjustmentKinds[number], string> = {
  add: "Add stock", deduct: "Deduct stock", count: "Physical stock count", damaged: "Damaged stock", lost: "Lost stock",
  excess: "Excess stock", opening: "Initial opening stock", opening_correction: "Opening stock correction", valuation: "Valuation adjustment",
};
export const quantityInput = z.string().trim()
  .regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,6})?$/, "Enter a quantity with at most six decimal places.");
export const rateInput = z.string().trim()
  .regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,10})?$/, "Enter a rate with at most ten decimal places.");
export const valueDelta = z.string().trim()
  .regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?$/, "Enter a signed value with at most two decimal places.");
const uuid = z.uuid();
const reference = z.string().trim().max(120);
const text = z.string().trim().max(1000);
const optionalDate = z.union([accountDate, z.literal("")]);

const line = z.object({
  itemId: uuid, description: z.string().trim().max(250), quantity: quantityInput, rate: rateInput,
  discount: amount, tax: amount, historicalCost: rateInput,
  originalLineNo: z.number().int().positive().nullable(),
  disposition: z.enum(["saleable", "damaged"]),
  unitLabel: z.string().max(40).optional(), purchaseAccountId: uuid.nullable().optional(),
  // Absent on lines saved before line types existed; those are Product lines.
  lineType: z.enum(lineTypes).optional(),
});

export const invoiceSchema = z.object({
  type: tradeType, date: accountDate, partyId: uuid, dueOn: optionalDate,
  externalRef: reference, poRef: reference, narration: text, notes: text, reason: text,
  originalInvoiceId: uuid.nullable(), exchangeReturnId: uuid.nullable(),
  withholding: amount, duplicateReason: z.string().trim().max(500),
  lines: z.array(line).min(1, "Add at least one invoice line.").max(100),
  payments: z.array(z.object({ accountId: uuid, amount })).max(20),
  salesExecutiveId: uuid.nullable().optional(),
});
export type InvoiceInput = z.infer<typeof invoiceSchema>;

export const adjustmentSchema = z.object({
  itemId: uuid, kind: z.enum(adjustmentKinds), date: accountDate,
  quantity: quantityInput, physical: quantityInput, rate: rateInput, valueChange: valueDelta,
  reference, reason: reasonText, offsetId: uuid.nullable().optional(),
});
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const itemSchema = z.object({
  // Optional: items imported from the desktop application have no code.
  sku: z.string().trim().max(80).transform((value) => value || null),
  name: z.string().trim().min(1, "Enter an item name.").max(160),
  unit: z.string().trim().min(1, "Enter a unit of measure.").max(40),
  description: text, category: z.string().trim().max(100), kind: z.enum(["stock", "service"]),
  reorder: quantityInput, active: z.boolean(), purchaseAccountId: uuid.nullable(),
});
export type ItemInput = z.infer<typeof itemSchema>;

export const isReturn = (type: TradeType) => type.endsWith("_return");
export const isSale = (type: TradeType) => type.startsWith("sale");
export const money = (value: InstanceType<typeof Exact>) => value.toDecimalPlaces(2, Exact.ROUND_HALF_UP);
export const amountText = (value: InstanceType<typeof Exact>) => money(value).toFixed(2);
export const rateText = (value: InstanceType<typeof Exact>) => value.toFixed(10);
export const lineSubtotal = (quantity: string, rate: string) => money(new Exact(quantity).times(rate));

export type TradeLine = {
  itemId: string; quantity: string; rate: string; description: string; unitLabel: string; originalLineNo: number | null;
  subtotal: string; discount: string; tax: string; amount: string; inventoryCost: string; disposition: "saleable" | "damaged";
  purchaseAccountId: string | null;
  /** Present only for Services and Freight lines, so the effect fingerprint of existing Product lines is unchanged. */
  lineType?: Exclude<LineType, "product">;
};
export type InvoiceCalculation = {
  subtotal: string; discount: string; tax: string; withholding: string; total: string;
  settled: string; partyAmount: string; appliedCredit: string; lines: TradeLine[];
};
export type AdjustmentCalculation = { previous: string; physical: string | null; difference: string; value: string; unitCost: string };
export type ItemFacts = { id: string; name: string; kind: string; unit: string; active: boolean; purchaseAccountId: string | null };

export function proratedPart(value: string, totalQty: string, before: InstanceType<typeof Exact>, after: InstanceType<typeof Exact>) {
  const basis = new Exact(value);
  return money(basis.times(after).div(totalQty)).minus(money(basis.times(before).div(totalQty)));
}

export function lineFinancials(
  line: { quantity: string; rate: string; discount: string; tax: string },
  original?: { quantity: string; subtotal: string; discount: string; tax: string },
  prior = new Exact(0),
) {
  if (!original) {
    const gross = lineSubtotal(line.quantity, line.rate);
    const discount = new Exact(line.discount);
    return { gross, discount, net: gross.minus(discount), tax: new Exact(line.tax) };
  }
  const through = prior.plus(line.quantity);
  const net = proratedPart(new Exact(original.subtotal).minus(original.discount).toFixed(2), original.quantity, prior, through);
  const discount = proratedPart(original.discount, original.quantity, prior, through);
  return { gross: net.plus(discount), discount, net, tax: proratedPart(original.tax, original.quantity, prior, through) };
}
