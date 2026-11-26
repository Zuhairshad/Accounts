"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { auditLogs, companySettings } from "@/db/schema";
import { accountDate, reasonText } from "@/lib/engine/model";
import { bool, entries, identifier, optionalId, readJson, run, version, type FinanceState } from "@/lib/engine/mutation";
import { partySchema, saveParty } from "@/lib/engine/masters";
import { adjustmentSchema, invoiceSchema, itemSchema, quantityInput, rateInput } from "./model";
import { saveAdjustment, saveInvoice, saveItem, tradeLifecycle } from "./service";

export async function invoiceAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.invoice", () => z.object({
    id: optionalId, version, reason: z.string().trim().max(500),
    intent: z.enum(["draft","post"]), input: invoiceSchema,
  }).parse({ ...entries(form), id: form.get("id") || undefined, input: readJson(form.get("input")) }), saveInvoice);
}

export async function adjustmentAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.adjustment", () => {
    const fields = entries(form);
    return { id: optionalId.parse(fields.id || undefined), version: version.parse(fields.version),
      input: adjustmentSchema.parse({ ...fields, quantity: fields.quantity || "0", physical: fields.physical || "0",
        rate: fields.rate || "0", valueChange: fields.valueChange || "0" }) };
  }, (tx, context, data) => saveAdjustment(tx, context, data.input, data.version, data.id));
}

export async function lifecycleAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.lifecycle", () => z.object({
    kind: z.enum(["invoice", "inventory_adjustment"]), id: identifier, version,
    operation: z.enum(["void", "restore"]), reason: reasonText,
  }).parse(entries(form)), (tx, context, data) => tradeLifecycle(tx, context, data.kind, data.id, data.version, data.operation, data.reason));
}

export async function itemAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.item", () => {
    const fields = entries(form);
    return {
      id: optionalId.parse(fields.id || undefined), version: version.parse(fields.version ?? "0"),
      input: itemSchema.parse({
        description: "", category: "", reorder: "0", ...fields,
        active: fields.active === undefined ? true : bool.parse(fields.active), purchaseAccountId: fields.purchaseAccountId || null,
      }),
      opening: fields.opening === "true" ? {
        date: accountDate.parse(fields.openingDate), quantity: quantityInput.parse(fields.openingQuantity),
        rate: rateInput.parse(fields.openingRate), reason: reasonText.parse(fields.openingReason),
        physical: "0", valueChange: "0", reference: "",
      } : undefined,
    };
  }, (tx, context, data) => saveItem(tx, context, data.input, data.id, data.version, data.opening));
}

export async function inlinePartyAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.inline_party", () => partySchema.parse({
    version: 0, address: "", phone: "", email: "", contact: "", ntn: "", strn: "", creditDays: 0,
    creditLimit: "0", notes: "", active: true, name: form.get("name"), type: form.get("type"),
  }), async (tx, context, data) => ({ id: await saveParty(tx, context, data) }));
}

export async function tradeSettingsAction(_state: FinanceState, form: FormData) {
  return run(form, "trade.settings", () => ({ tradeTax: bool.parse(form.get("tradeTax")), tradeWithholding: bool.parse(form.get("tradeWithholding")) }),
    async (tx, context, data, require) => {
      require("manage_company");
      const [before] = await tx.select({ tradeTax: companySettings.tradeTax, tradeWithholding: companySettings.tradeWithholding })
        .from(companySettings).where(eq(companySettings.companyId, context.companyId));
      await tx.update(companySettings).set(data).where(eq(companySettings.companyId, context.companyId));
      await tx.insert(auditLogs).values({ companyId: context.companyId, actorId: context.actorId, action: "trade.settings", data: { before, after: data } });
      return {};
    });
}
