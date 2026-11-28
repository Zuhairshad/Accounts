"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, financialYears, periods } from "@/db/schema";
import { AccountingError, accountDate, amount, manualVoucher, reasonText } from "./model";
import { changeVoucher, repairLegacyParty, saveManual } from "./vouchers";
import { accountSchema, configureAccounting, openingSchema, partySchema, salesExecutiveSchema, saveAccount, saveOpening, saveParty, saveSalesExecutive } from "./masters";
import { receiptSchema, recordReceipt } from "./receipts";
import { allocatePayment, releaseAllocation } from "./settlement";
import { bool, entries, identifier, optionalId, readJson, run, version, type FinanceState } from "./mutation";
export type { FinanceState } from "./mutation";

const journalEntry = z.object({
  entry: manualVoucher, id: optionalId, version, reason: z.string().trim().max(500),
  intent: z.enum(["draft", "post", "submit"]),
});

export async function saveVoucherAction(_state: FinanceState, form: FormData) {
  return run(form, "voucher.save", () => journalEntry.parse({ ...entries(form), id: form.get("id") || undefined, entry: readJson(form.get("entry")) }), saveManual);
}

export async function transitionVoucherAction(_state: FinanceState, form: FormData) {
  return run(form, "voucher.transition", () => z.object({
    id: identifier, version, operation: z.enum(["submit", "post", "delete", "restore"]), reason: reasonText,
  }).parse(entries(form)), changeVoucher);
}

export async function repairPartyAction(_state: FinanceState, form: FormData) {
  return run(form, "voucher.repair_party", () => z.object({
    voucherId: identifier, reason: reasonText, confirmed: z.literal("true"),
    links: z.array(z.object({ lineNumber: z.number().int().positive(), partyId: identifier })).min(1).max(100),
  }).parse({ ...entries(form), links: form.getAll("repair").map((value) => {
    const [line, partyId] = String(value).split(":");
    return { lineNumber: Number(line), partyId };
  }), }), repairLegacyParty);
}

export async function saveAccountAction(_state: FinanceState, form: FormData) {
  return run(form, "account.save", () => accountSchema.parse({
    ...entries(form), id: form.get("id") || undefined, parentId: form.get("parentId") || null, liquidity: form.get("liquidity") || null,
    active: bool.parse(form.get("active")),
  }), async (tx, context, value) => ({ id: await saveAccount(tx, context, value) }));
}

export async function savePartyAction(_state: FinanceState, form: FormData) {
  return run(form, "party.save", () => {
    const party = partySchema.parse({ ...entries(form), id: form.get("id") || undefined, active: bool.parse(form.get("active")) });
    const opening = form.get("saveOpening") === "true" ? {
      date: accountDate.parse(form.get("openingDate")), direction: z.enum(["debit", "credit"]).parse(form.get("openingDirection")),
      amount: amount.parse(form.get("openingAmount")), version: version.parse(form.get("openingVersion")), reason: reasonText.parse(form.get("openingReason")),
    } : null;
    return { party, opening };
  }, async (tx, context, { party, opening }) => {
    const id = await saveParty(tx, context, party);
    if (opening) await saveOpening(tx, context, { ...opening, kind: "party", targetId: id });
    return { id };
  });
}

export async function saveSalesExecutiveAction(_state: FinanceState, form: FormData) {
  return run(form, "sales_executive.save", () => salesExecutiveSchema.parse({
    ...entries(form), id: form.get("id") || undefined, phone: form.get("phone") ?? "", active: bool.parse(form.get("active") ?? "true"),
  }), async (tx, context, value) => ({ id: await saveSalesExecutive(tx, context, value) }));
}

export async function recordReceiptAction(_state: FinanceState, form: FormData) {
  return run(form, "receipt.record", () => receiptSchema.parse({
    ...entries(form), reference: form.get("reference") ?? "", narration: form.get("narration") ?? "",
    salesExecutiveId: form.get("salesExecutiveId") || null,
  }), recordReceipt);
}

export async function saveOpeningAction(_state: FinanceState, form: FormData) {
  return run(form, "opening.save", () => {
    const chosen = form.getAll("selected").map((value) => identifier.parse(value));
    return z.array(openingSchema).min(1, "Select at least one opening balance to save.").max(100).parse(chosen.map((id) => ({
      targetId: id, kind: form.get(`kind.${id}`), version: form.get(`version.${id}`), date: form.get(`date.${id}`),
      direction: form.get(`direction.${id}`), amount: form.get(`amount.${id}`), reason: form.get("reason"),
    })));
  }, async (tx, context, data) => {
    for (const row of data) await saveOpening(tx, context, row);
    return {};
  });
}

export async function configureAccountingAction(_state: FinanceState, form: FormData) {
  return run(form, "settings.accounting", () => ({
    approval: bool.parse(form.get("approval")), offsetId: identifier.nullable().parse(form.get("offsetId") || null),
  }), async (tx, context, { approval, offsetId }, require) => {
    require("manage_company");
    await configureAccounting(tx, context.companyId, context.actorId, approval, offsetId);
    return {};
  });
}

export async function periodAction(_state: FinanceState, form: FormData) {
  return run(form, "period.save", () => z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("create"), yearId: identifier, from: accountDate, to: accountDate }),
    z.object({ operation: z.enum(["close", "reopen"]), id: identifier, version, reason: reasonText }),
  ]).parse(entries(form)), async (tx, context, data, require) => {
    const { companyId, actorId } = context;
    require("close_period");
    if (data.operation === "create") {
      const [year] = await tx.select().from(financialYears)
        .where(and(eq(financialYears.companyId, companyId), eq(financialYears.id, data.yearId))).for("update");
      if (!year || year.closed || data.from > data.to || data.from < year.startsOn || data.to > year.endsOn) {
        throw new AccountingError("Choose dates inside an open financial year.");
      }
      const [period] = await tx.insert(periods).values({ companyId, yearId: year.id, startsOn: data.from, endsOn: data.to }).returning();
      await tx.insert(auditLogs).values({ companyId, actorId, action: "period.created", data: { after: period } });
    } else {
      const [before] = await tx.select().from(periods)
        .where(and(eq(periods.companyId, companyId), eq(periods.id, data.id))).for("update");
      if (!before || before.version !== data.version) throw new AccountingError("The accounting period changed. Reload to continue.");
      const closed = data.operation === "close";
      if (closed === before.closed) throw new AccountingError("The period is already in that state.");
      const [year] = await tx.select().from(financialYears).where(and(eq(financialYears.companyId, companyId), eq(financialYears.id, before.yearId)));
      if (!closed && year.closed) throw new AccountingError("Reopen the financial year through an approved review before reopening its period.");
      const [after] = await tx.update(periods).set({ closed, version: before.version + 1 }).where(eq(periods.id, before.id)).returning();
      await tx.insert(auditLogs).values({ companyId, actorId, action: `period.${data.operation}`, data: { before, after, reason: data.reason } });
    }
    return {};
  });
}

export async function allocateAction(_state: FinanceState, form: FormData) {
  return run(form, "payments.allocate", () => z.object({
    partyId: identifier, lineId: identifier, invoiceId: optionalId, date: accountDate, amount,
  }).parse({ ...entries(form), invoiceId: form.get("invoiceId") || undefined }), allocatePayment);
}

export async function releaseAction(_state: FinanceState, form: FormData) {
  return run(form, "payments.release", () => z.object({
    id: identifier, partyId: identifier, date: accountDate, reason: reasonText,
  }).parse(entries(form)), releaseAllocation);
}
