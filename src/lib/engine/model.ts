import Decimal from "decimal.js";
import { z } from "zod";

export const Exact = Decimal.clone({ precision: 64 });
export const manualTypes = ["JV", "VR", "CPV", "CRV", "BPV", "BRV"] as const;
export const manualType = z.enum(manualTypes);
export const voucherModes = z.enum(["party", "direct"]);
export const amount = z.string().trim().regex(/^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?$/, "Enter a non-negative amount with at most two decimal places.");
export const accountDate = z.iso.date().refine((date) => date >= "1900-01-01" && date <= "2199-12-31", "Enter an accounting date between 1900 and 2199.");
export const reasonText = z.string().trim().min(3, "Enter a reason of at least three characters.").max(500);
export const journalLine = z.object({
  accountId: z.uuid({ error: "Choose an account or party for each entered line." }), partyId: z.uuid().nullable(), itemId: z.uuid().nullable().optional(),
  description: z.string().trim().max(250), debit: amount, credit: amount,
}).refine((line) => !/[1-9]/.test(line.debit) || !/[1-9]/.test(line.credit),
  { message: "A line cannot contain both a debit and a credit." });

export const manualVoucher = z.object({
  type: manualType, date: accountDate, reference: z.string().trim().max(120), narration: z.string().trim().max(1000),
  mode: voucherModes, lines: z.array(journalLine).max(100),
});

export type EntryLine = z.infer<typeof journalLine>;
export type VoucherInput = z.infer<typeof manualVoucher>;
export type JournalInput = Omit<VoucherInput, "type" | "mode"> & {
  type: VoucherInput["type"] | "opening" | "sale" | "purchase" | "sale_return" | "purchase_return" | "adjustment" | "reversal";
};
export type DraftSnapshot = { entry: VoucherInput };

/** What a manual voucher line may use, mirroring validateManual: the entry form offers only these choices. */
export type LineChoice = { partyId: string | null; partyType?: "customer" | "supplier" | null; liquidity: string | null };
export function voucherSides(type: VoucherInput["type"]) {
  if (type === "JV" || type === "VR") return null;
  const receipt = type.endsWith("RV");
  return {
    receipt, liquidity: type.startsWith("C") ? "cash" as const : "bank" as const,
    /** The side that must use the cash or bank account. */
    settlement: receipt ? "debit" as const : "credit" as const,
    labels: receipt ? { debit: "Received in", credit: "Received from" } : { debit: "Paid to", credit: "Paid from" },
  };
}
export function lineAllows(type: VoucherInput["type"], mode: VoucherInput["mode"], direction: "debit" | "credit", choice: LineChoice) {
  const sides = voucherSides(type);
  if (!sides) return true;
  if (direction === sides.settlement) return !choice.partyId && choice.liquidity === sides.liquidity;
  if (mode === "party") return !!choice.partyId && choice.partyType === (sides.receipt ? "customer" : "supplier");
  return !choice.partyId;
}
export type Transition = "submit" | "post" | "delete" | "restore";
export class AccountingError extends Error {}
