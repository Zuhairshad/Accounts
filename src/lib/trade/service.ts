import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "@/db";
import {
  accounts, auditLogs, companySettings, deletedRecords, inventoryAdjustments, inventoryValuations, invoiceLines, invoices, items,
  journalLines, parties, restorationHistory, revisions, stockMoves, tradeRegisterEntries, units, voucherDocuments,
} from "@/db/schema";
import { nextSequence } from "@/lib/accounting";
import { AccountingError, Exact, type JournalInput } from "@/lib/engine/model";
import { openPeriod } from "@/lib/engine/posting";
import { approvalRequired, publishDocument, recordChange, type FinanceContext } from "@/lib/engine/vouchers";
import { adjustmentSchema, invoiceSchema, isReturn, isSale, tradeNames, type AdjustmentInput, type InvoiceInput, type ItemFacts, type ItemInput } from "./model";
import { replayInventory, type Effect, type Event } from "./valuation";

type Invoice = typeof invoices.$inferSelect;
type Adjustment = typeof inventoryAdjustments.$inferSelect;
type Source = Invoice | Adjustment;
type Kind = "invoice" | "inventory_adjustment";
type Change = { id?: string; version: number; reason: string; intent: "draft" | "post" };
const prefixes = { sale: "SI", purchase: "PI", sale_return: "SR", purchase_return: "PR", adjustment: "IA" };

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function currentSettings(tx: Transaction, companyId: string) {
  return (await tx.select().from(companySettings).where(eq(companySettings.companyId, companyId)))[0];
}

export async function itemFacts(tx: Transaction, companyId: string) {
  const rows = await tx.select({ id: items.id, name: items.name, kind: items.kind, active: items.active,
    purchaseAccountId: items.purchaseAccountId, unit: units.name })
    .from(items).innerJoin(units, and(eq(items.companyId, units.companyId), eq(items.unitId, units.id)))
    .where(eq(items.companyId, companyId));
  return new Map<string, ItemFacts>(rows.map((row) => [row.id, row]));
}

async function validateInvoice(tx: Transaction, context: FinanceContext, input: InvoiceInput, id?: string, posting = true, historical = false) {
  const { companyId } = context;
  const [party] = await tx.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, input.partyId)));
  const returned = isReturn(input.type);
  if (!party?.active || party.type !== (isSale(input.type) ? "customer" : "supplier")) {
    throw new AccountingError("Select an active party of the correct classification in this company.");
  }
  if (input.dueOn && input.dueOn < input.date) throw new AccountingError("Due date must be on or after the accounting date.");
  if (!returned && input.originalInvoiceId || input.exchangeReturnId && input.type !== "sale") throw new AccountingError("This linked transaction does not match the document type.");
  const [original] = input.originalInvoiceId ? await tx.select().from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.id, input.originalInvoiceId))) : [];
  if (input.originalInvoiceId && (!original?.payload || original.status !== "posted" || original.date > input.date ||
      original.partyId !== input.partyId || original.type !== (isSale(input.type) ? "sale" : "purchase"))) {
    throw new AccountingError("Select the matching posted original invoice and a valid return date.");
  }
  if (input.exchangeReturnId) {
    const [returned] = await tx.select().from(invoices)
      .where(and(eq(invoices.companyId, companyId), eq(invoices.id, input.exchangeReturnId)));
    if (returned?.type !== "sale_return" || returned.status !== "posted" || returned.partyId !== party.id || returned.date > input.date) {
      throw new AccountingError("Select a posted sale return for this customer and an exchange date on or after it.");
    }
  }
  if (returned && posting) {
    if (input.reason.trim().length < 3) throw new AccountingError("Enter a return reason.");
    if (!original) {
      context.require("approve");
      if (!input.externalRef || input.notes.trim().length < 3) {
        throw new AccountingError("A standalone historical return needs a verified source reference and a note explaining the approved value and cost.");
      }
    }
  }
  const settings = await currentSettings(tx, companyId);
  const stored = original?.calculation as import("./model").InvoiceCalculation | undefined;
  if (!historical && !settings.tradeWithholding && !new Exact(input.withholding).isZero() && (!stored || new Exact(stored.withholding).isZero())) {
    throw new AccountingError("Withholding is disabled for this company.");
  }
  const available = await itemFacts(tx, companyId);
  const ledger = await tx.select().from(accounts).where(eq(accounts.companyId, companyId));
  const accountById = new Map(ledger.map((row) => [row.id, row]));
  const lines = input.lines.map((line) => {
    const item = available.get(line.itemId);
    if (!item || (!item.active && !original && !historical)) throw new AccountingError("Select an active item in this company.");
    if (!historical && !settings.tradeTax && !new Exact(line.tax).isZero() && !original) throw new AccountingError("Tax entry is disabled for this company.");
    if (!returned && (line.originalLineNo || line.disposition !== "saleable")) throw new AccountingError("Return metadata is only available on returns.");
    if (line.disposition === "damaged" && input.type !== "sale_return") throw new AccountingError("Damaged disposition applies to sale returns.");
    if (new Exact(line.quantity).lte(0)) throw new AccountingError("Every item row needs a positive quantity.");
    const purchaseAccountId = !isSale(input.type) && item.kind === "service" ? (line.purchaseAccountId ?? item.purchaseAccountId) : null;
    if (!isSale(input.type) && item.kind === "service" && !original) {
      const account = purchaseAccountId ? accountById.get(purchaseAccountId) : undefined;
      if (!account?.active || account.control || !["asset","expense"].includes(account.type) || account.liquidity) {
        throw new AccountingError("Choose an active expense or non-cash asset account for the service item.");
      }
    }
    return { ...line, description: line.description || item.name, unitLabel: line.unitLabel || item.unit, purchaseAccountId };
  });
  for (const payment of input.payments) {
    const account = accountById.get(payment.accountId);
    if (!account?.active || !account.liquidity || new Exact(payment.amount).lte(0)) throw new AccountingError("Use an active cash or bank account and a positive settlement amount.");
  }
  if (posting && input.type === "purchase" && input.externalRef) {
    const existing = await tx.execute<{ number: string }>(sql`
      SELECT number FROM invoices WHERE company_id=${companyId} AND party_id=${party.id} AND type='purchase'
        AND status='posted' AND lower(external_ref)=lower(${input.externalRef})
        AND id IS DISTINCT FROM ${id ?? null}::uuid LIMIT 1
    `);
    if (existing.rows.length) {
      if (input.duplicateReason.length < 3) throw new AccountingError(`External supplier invoice already exists (${existing.rows[0].number}). An authorized exception needs a reason.`);
      context.require("approve");
    }
  }
  return { ...input, lines };
}

async function checkDependencies(tx: Transaction, companyId: string, invoice: Invoice) {
  const dependencies = await tx.execute<{ linked: boolean; payments: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM invoices i WHERE i.company_id=${companyId} AND i.status='posted'
      AND (i.original_invoice_id=${invoice.id} OR i.exchange_return_id=${invoice.id})) AS linked,
    EXISTS (SELECT 1 FROM payment_allocations a LEFT JOIN journal_lines l ON l.company_id=a.company_id AND l.id=a.payment_line_id
      WHERE a.company_id=${companyId} AND a.ended_on IS NULL AND (a.invoice_id=${invoice.id} OR l.voucher_id=${invoice.voucherId}::uuid)) AS payments
  `);
  if (dependencies.rows[0].linked) throw new AccountingError("Resolve the posted returns or exchange sales linked to this document first.");
  if (dependencies.rows[0].payments) throw new AccountingError("Release or reconcile the active payment allocations before changing this document.");
}

async function sourceNumber(tx: Transaction, companyId: string, date: string, type: keyof typeof prefixes) {
  const period = await openPeriod(tx, companyId, date);
  const settings = await currentSettings(tx, companyId);
  let id: string;
  let exists: boolean;
  do {
    const value = await nextSequence(tx, companyId, period.yearId, `source:${type}`);
    const prefix = settings.numberPrefix ? `${settings.numberPrefix}-` : "";
    id = `${prefix}${prefixes[type]}-${date.replaceAll("-", "")}-${String(value).padStart(settings.numberPadding, "0")}`;
    const result = await tx.execute<{ occupied: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM invoices WHERE company_id=${companyId} AND number=${id})
        OR EXISTS (SELECT 1 FROM inventory_adjustments WHERE company_id=${companyId} AND number=${id}) AS occupied
    `);
    exists = result.rows[0].occupied;
  } while (exists);
  return id;
}

async function history(tx: Transaction, context: FinanceContext, kind: Kind, previous: Source | null, next: Source, reason: string) {
  await tx.insert(revisions).values({
    companyId: context.companyId, actorId: context.actorId, entityType: kind, entityId: next.id, version: next.version,
    previousData: previous ?? {}, nextData: next, reason,
  });
  await tx.insert(auditLogs).values({
    companyId: context.companyId, actorId: context.actorId, action: `${kind}.changed`,
    data: { id: next.id, version: next.version, status: next.status, reason },
  });
}

async function documentFor(tx: Transaction, companyId: string, kind: Kind, id: string) {
  return (await tx.select().from(voucherDocuments).where(and(eq(voucherDocuments.companyId, companyId),
    eq(voucherDocuments.source, kind), eq(voucherDocuments.sourceId, id))).for("update"))[0];
}

async function moveHistoricalAllocations(
  tx: Transaction, context: FinanceContext, oldId: string, newId: string, previousApplied: string | null, nextApplied: string,
) {
  const { companyId, actorId } = context;
  const rows = await tx.execute<{ id: string; account_id: string; party_id: string; debit: string; credit: string; payment_line_id: string; ended_on: string | null }>(sql`
    SELECT a.id,a.ended_on,l.id AS payment_line_id,l.account_id,l.party_id,l.debit::text,l.credit::text
    FROM payment_allocations a JOIN journal_lines l ON l.company_id=a.company_id AND l.id=a.payment_line_id
    WHERE a.company_id=${companyId} AND l.voucher_id=${oldId}
  `);
  if (!rows.rows.length) return;
  const current = await tx.select().from(journalLines).where(and(eq(journalLines.companyId, companyId), eq(journalLines.voucherId, newId)));
  for (const row of rows.rows) {
    const replacement = current.find((line) => line.partyId === row.party_id && line.accountId === row.account_id &&
      new Exact(line.debit).eq(row.debit) && new Exact(line.credit).eq(row.credit));
    if (!replacement || !new Exact(nextApplied).eq(previousApplied ?? 0)) {
      if (!row.ended_on) throw new AccountingError("Revaluation would change a return credit with active allocations. Release its allocations first.");
      continue;
    }
    await tx.execute(sql`UPDATE payment_allocations SET payment_line_id=${replacement.id} WHERE company_id=${companyId} AND id=${row.id}`);
    await tx.insert(auditLogs).values({ companyId, actorId, action: "payment.allocation_rebound",
      data: { allocationId: row.id, previousLine: row.payment_line_id, nextLine: replacement.id } });
  }
}

async function writeEffect(tx: Transaction, context: FinanceContext, source: Source, effect: Effect, reason: string) {
  const { companyId, actorId } = context;
  const { event, calc, journal, moves } = effect;
  const hash = digest({ calc, journal, moves });
  let document = await documentFor(tx, companyId, event.kind, source.id);
  if (document?.status === "posted") await openPeriod(tx, companyId, document.date);
  const type = event.kind === "invoice" ? event.input.type : "adjustment";
  const reference = event.kind === "invoice" ? event.input.externalRef : event.input.reference;
  const narration = event.kind === "invoice" ? event.input.narration || tradeNames[event.input.type] : event.input.reason;
  const entry: JournalInput = { type, date: event.input.date, reference, narration, lines: journal };
  if (!document) {
    [document] = await tx.insert(voucherDocuments).values({
      companyId, source: event.kind, sourceId: source.id, type, date: entry.date, reference, draft: { entry }, createdBy: actorId,
    }).returning();
  }
  const next = await publishDocument(tx, context, document, entry);
  await recordChange(tx, context, document, next.document, reason, document.status === "posted" ? "revalued" : "source_posted");
  if (moves.length) {
    const stored = await tx.insert(stockMoves).values(moves.map(({ qtyAfter: _qty, valueAfter: _value, averageCost: _average, ...move }) =>
      ({ ...move, companyId, voucherId: next.voucherId, date: entry.date }))).returning({ id: stockMoves.id, lineNo: stockMoves.lineNo });
    const byLine = new Map(moves.map((move) => [move.lineNo, move]));
    await tx.insert(inventoryValuations).values(stored.map((row) => {
      const move = byLine.get(row.lineNo)!;
      return { companyId, moveId: row.id, qty: move.qtyAfter, value: move.valueAfter, averageCost: move.averageCost };
    }));
  }
  if (effect.event.kind === "invoice" && "lines" in effect.calc && "partyId" in source) {
    const { input } = effect.event;
    const calculation = effect.calc;
    if (source.voucherId) await moveHistoricalAllocations(tx, context, source.voucherId, next.voucherId, source.appliedCredit, calculation.appliedCredit);
    const [updated] = await tx.update(invoices).set({
      date: input.date, dueOn: input.dueOn || null, partyId: input.partyId, originalInvoiceId: input.originalInvoiceId, exchangeReturnId: input.exchangeReturnId,
      number: source.number ?? await sourceNumber(tx, companyId, input.date, input.type),
      voucherId: next.voucherId, externalRef: input.externalRef, poRef: input.poRef, duplicateReason: input.duplicateReason,
      payload: input, calculation, effectHash: hash, status: "posted", total: calculation.total,
      partyAmount: calculation.partyAmount, appliedCredit: calculation.appliedCredit, version: source.version + 1,
    }).where(and(eq(invoices.companyId, companyId), eq(invoices.id, source.id))).returning();
    await tx.insert(invoiceLines).values(calculation.lines.map(({ quantity, purchaseAccountId: _purchaseAccount, ...line }, index) => ({
      ...line, qty: quantity, companyId, invoiceId: source.id, postingVoucherId: next.voucherId, lineNo: index + 1,
    })));
    await tx.insert(tradeRegisterEntries).values({ companyId, invoiceId: source.id }).onConflictDoNothing();
    await history(tx, context, "invoice", source, updated, reason);
    return updated;
  }
  if (event.kind !== "inventory_adjustment" || "partyId" in source) throw new Error("Trade effect/source mismatch");
  const { input } = event;
  const [updated] = await tx.update(inventoryAdjustments).set({
    date: input.date, itemId: input.itemId, kind: input.kind, reason: input.reason, status: "posted", payload: input, calculation: calc,
    effectHash: hash, voucherId: next.voucherId, number: source.number ?? await sourceNumber(tx, companyId, input.date, "adjustment"),
    version: source.version + 1,
  }).where(and(eq(inventoryAdjustments.companyId, companyId), eq(inventoryAdjustments.id, source.id))).returning();
  await history(tx, context, "inventory_adjustment", source, updated, reason);
  return updated;
}

async function recalculate(
  tx: Transaction, context: FinanceContext, target: { id: string; replacement?: Event; reason: string },
) {
  const { companyId } = context;
  const goods = await itemFacts(tx, companyId);
  const accountRows = await tx.select().from(accounts).where(eq(accounts.companyId, companyId));
  const controls = new Map(accountRows.filter((row) => row.control).map((row) => [row.control!, row.id]));
  const managedInvoices = await tx.select().from(invoices).where(and(eq(invoices.companyId, companyId),
    sql`${invoices.payload} is not null AND (${invoices.status} = 'posted' OR ${invoices.id} = ${target.id})`));
  const adjustments = await tx.select().from(inventoryAdjustments).where(and(eq(inventoryAdjustments.companyId, companyId),
    sql`${inventoryAdjustments.payload} is not null AND (${inventoryAdjustments.status} = 'posted' OR ${inventoryAdjustments.id} = ${target.id})`));
  const legacy = await tx.execute<{ id: string; created: Date | string; date: string; itemId: string; qty: string; value: string; lineNo: number }>(sql`
    SELECT v.id,v.created_at AS created,m.accounting_date::text AS date,m.item_id AS "itemId",m.signed_quantity::text AS qty,
      m.signed_value::text AS value,m.line_no AS "lineNo" FROM stock_movements m
    JOIN effective_vouchers v ON v.company_id=m.company_id AND v.id=m.voucher_id
    LEFT JOIN invoices i ON i.company_id=v.company_id AND i.voucher_id=v.id
    LEFT JOIN inventory_adjustments a ON a.company_id=v.company_id AND a.voucher_id=v.id
    WHERE m.company_id=${companyId} AND i.payload IS NULL AND a.payload IS NULL ORDER BY v.accounting_date,v.created_at,m.created_at,m.id
  `);
  const source = new Map<string, Source>([...managedInvoices, ...adjustments].map((record) => [record.id, record]));
  const events: Event[] = [
    ...managedInvoices.filter((row) => row.id !== target.id && row.status === "posted").map((row) =>
      ({ kind: "invoice" as const, id: row.id, createdAt: row.createdAt, input: invoiceSchema.parse(row.payload) })),
    ...adjustments.filter((row) => row.id !== target.id && row.status === "posted").map((row) =>
      ({ kind: "inventory_adjustment" as const, id: row.id, createdAt: row.createdAt, input: adjustmentSchema.parse(row.payload) })),
    // Raw drizzle execute returns timestamptz as text; the replay orders events by Date.
    ...legacy.rows.map((row, index) => ({ kind: "legacy" as const, id: row.id, createdAt: new Date(row.created), input: { ...row, lineNo: index } })),
  ];
  if (target.replacement) events.push(target.replacement);
  const allocationRows = await tx.execute<{ invoiceId: string; amount: string; date: string; endedOn: string | null }>(sql`
    SELECT a.invoice_id AS "invoiceId",a.amount::text,a.accounting_date::text AS date,a.ended_on::text AS "endedOn"
    FROM payment_allocations a JOIN journal_lines l ON l.company_id=a.company_id AND l.id=a.payment_line_id
    JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
    WHERE a.company_id=${companyId}
  `);
  const allocations = new Map<string, typeof allocationRows.rows>();
  for (const allocation of allocationRows.rows) {
    const list = allocations.get(allocation.invoiceId) ?? [];
    list.push(allocation);
    allocations.set(allocation.invoiceId, list);
  }
  const effects = replayInventory(events, { items: goods, controls, allocations });
  let saved: Source | undefined;
  for (const effect of effects) {
    const record = source.get(effect.event.id);
    if (!record) throw new Error("Accounting effect has no source record");
    if (effect.event.id !== target.id && record.effectHash === digest({ calc: effect.calc, journal: effect.journal, moves: effect.moves })) continue;
    const changed = await writeEffect(tx, context, record, effect, effect.event.id === target.id
      ? target.reason : `Inventory and trade revaluation after ${target.id}`);
    if (effect.event.id === target.id) saved = changed;
  }
  return saved;
}

export async function saveInvoice(tx: Transaction, context: FinanceContext, data: Change & { input: InvoiceInput }) {
  const { companyId, actorId } = context;
  context.require(data.id ? "edit" : "create");
  if (data.intent === "post") {
    context.require("post");
    if (await approvalRequired(tx, companyId)) context.require("approve");
  }
  let [before] = data.id ? await tx.select().from(invoices).where(and(eq(invoices.companyId, companyId), eq(invoices.id, data.id))).for("update") : [];
  if (data.id && (!before?.payload || before.version !== data.version || before.status === "void" || before.type !== data.input.type)) {
    throw new AccountingError("Reload the current draft or active document before editing.");
  }
  if (before?.status === "posted") {
    if (data.intent !== "post" || data.reason.length < 3) throw new AccountingError("Enter a reason to revise a posted document.");
    await openPeriod(tx, companyId, before.date);
    await checkDependencies(tx, companyId, before);
  }
  const input = await validateInvoice(tx, context, data.input, before?.id, data.intent === "post");
  if (data.intent === "post") await openPeriod(tx, companyId, input.date);
  if (!before) {
    [before] = await tx.insert(invoices).values({
      companyId, type: input.type, date: input.date, partyId: input.partyId, dueOn: input.dueOn || null, total: "0",
      externalRef: input.externalRef, poRef: input.poRef, originalInvoiceId: input.originalInvoiceId, exchangeReturnId: input.exchangeReturnId,
      createdBy: actorId, payload: input,
    }).returning();
    if (data.intent === "draft") await history(tx, context, "invoice", null, before, "Draft created");
  } else if (data.intent === "draft") {
    const [updated] = await tx.update(invoices).set({
      date: input.date, partyId: input.partyId, dueOn: input.dueOn || null, externalRef: input.externalRef, poRef: input.poRef,
      originalInvoiceId: input.originalInvoiceId, exchangeReturnId: input.exchangeReturnId, payload: input, version: before.version + 1,
    }).where(eq(invoices.id, before.id)).returning();
    await history(tx, context, "invoice", before, updated, "Draft changed");
  }
  if (data.intent === "post") await recalculate(tx, context, {
    id: before.id, replacement: { id: before.id, kind: "invoice", createdAt: before.createdAt, input }, reason: data.reason || "Invoice posted",
  });
  return { id: before.id };
}

async function normalizeAdjustment(tx: Transaction, context: FinanceContext, input: AdjustmentInput, existing?: Adjustment) {
  const { companyId } = context;
  const item = (await itemFacts(tx, companyId)).get(input.itemId);
  if (!item?.active || item.kind !== "stock") throw new AccountingError("Choose an active inventory item.");
  if (input.kind === "valuation") context.require("approve");
  if (input.kind === "opening") {
    const imported = await tx.execute<{ exists: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM stock_movements m JOIN effective_vouchers v ON v.company_id=m.company_id AND v.id=m.voucher_id
        LEFT JOIN inventory_adjustments a ON a.company_id=m.company_id AND a.voucher_id=m.voucher_id
        WHERE m.company_id=${companyId} AND m.item_id=${input.itemId}
          AND ((m.movement_kind IN ('legacy','opening') AND a.payload IS NULL) OR (a.kind='opening' AND a.id IS DISTINCT FROM ${existing?.id ?? null}::uuid))) AS exists
    `);
    if (imported.rows[0].exists) throw new AccountingError("This item already has an opening or imported stock history. Use an opening correction after reconciliation.");
  }
  const settings = await currentSettings(tx, companyId);
  const tag = ["opening", "opening_correction"].includes(input.kind) ? "opening_equity" :
    ["damaged", "lost"].includes(input.kind) ? "inventory_loss" : "inventory_adjustment";
  const configured = tag === "opening_equity" ? settings.openingOffsetId : null;
  const [offset] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId),
    configured ? eq(accounts.id, configured) : eq(accounts.control, tag)));
  if (!offset?.active) throw new AccountingError("The adjustment offset account is unavailable.");
  return { ...input, offsetId: offset.id };
}

export async function saveAdjustment(tx: Transaction, context: FinanceContext, input: AdjustmentInput, version = 0, id?: string) {
  const { companyId, actorId } = context;
  context.require(id ? "edit" : "create");
  context.require("post");
  if (await approvalRequired(tx, companyId)) context.require("approve");
  let [before] = id ? await tx.select().from(inventoryAdjustments).where(and(eq(inventoryAdjustments.companyId, companyId), eq(inventoryAdjustments.id, id))).for("update") : [];
  if (id && (!before?.payload || before.version !== version || before.status !== "posted" || before.itemId !== input.itemId || before.kind !== input.kind)) {
    throw new AccountingError("Reload the adjustment before editing. Item and adjustment type stay fixed.");
  }
  if (before?.date) await openPeriod(tx, companyId, before.date);
  const payload = await normalizeAdjustment(tx, context, input, before);
  await openPeriod(tx, companyId, input.date);
  if (!before) [before] = await tx.insert(inventoryAdjustments).values({
    companyId, itemId: input.itemId, date: input.date, kind: input.kind, reason: input.reason,
    status: "draft", createdBy: actorId, payload,
  }).returning();
  await recalculate(tx, context, { id: before.id, replacement: { id: before.id, kind: "inventory_adjustment", createdAt: before.createdAt, input: payload }, reason: input.reason });
  return { id: before.id };
}

export async function saveItem(
  tx: Transaction, context: FinanceContext, input: ItemInput, id: string | undefined, version: number,
  initial?: Omit<AdjustmentInput, "itemId" | "kind" | "offsetId">,
) {
  const { companyId, actorId } = context;
  context.require(id ? "edit" : "create");
  const [before] = id ? await tx.select().from(items).where(and(eq(items.companyId, companyId), eq(items.id, id))) : [];
  if (id && (!before || before.version !== version)) throw new AccountingError("This item changed. Reload before saving.");
  const { unit, ...fields } = input;
  if (fields.kind === "service") {
    const [account] = fields.purchaseAccountId ? await tx.select().from(accounts)
      .where(and(eq(accounts.companyId, companyId), eq(accounts.id, fields.purchaseAccountId))) : [];
    if (!account?.active || account.control || account.liquidity || !["asset","expense"].includes(account.type)) {
      throw new AccountingError("Choose an active expense or non-cash asset account for service purchases.");
    }
  } else fields.purchaseAccountId = null;
  await tx.insert(units).values({ companyId, name: unit }).onConflictDoNothing();
  const [unitRow] = await tx.select().from(units).where(and(eq(units.companyId, companyId), eq(units.name, unit)));
  if (before && (before.kind !== input.kind || before.unitId !== unitRow.id)) {
    const result = await tx.execute<{ used: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM invoice_lines WHERE company_id=${companyId} AND item_id=${before.id})
        OR EXISTS(SELECT 1 FROM stock_movements WHERE company_id=${companyId} AND item_id=${before.id}) AS used
    `);
    if (result.rows[0].used) throw new AccountingError("Once an item is used, its stock/service classification and unit stay fixed.");
  }
  const [saved] = before ? await tx.update(items).set({ ...fields, unitId: unitRow.id, version: before.version + 1 })
    .where(and(eq(items.companyId, companyId), eq(items.id, before.id))).returning()
    : await tx.insert(items).values({ ...fields, companyId, unitId: unitRow.id }).returning();
  await tx.insert(auditLogs).values({ companyId, actorId, action: "inventory.item_saved", data: { before, after: saved } });
  if (initial) {
    if (before || input.kind !== "stock") throw new AccountingError("Use an opening adjustment for an existing stock item.");
    await saveAdjustment(tx, context, { ...initial, itemId: saved.id, kind: "opening" });
  }
  return { id: saved.id };
}

export async function tradeLifecycle(
  tx: Transaction, context: FinanceContext, kind: Kind, id: string, version: number, operation: "void" | "restore", reason: string,
) {
  const { companyId, actorId } = context;
  context.require(operation === "void" ? "delete" : "restore");
  const [source] = kind === "invoice" ? await tx.select().from(invoices).where(and(eq(invoices.companyId, companyId), eq(invoices.id, id))).for("update")
    : await tx.select().from(inventoryAdjustments).where(and(eq(inventoryAdjustments.companyId, companyId), eq(inventoryAdjustments.id, id))).for("update");
  if (!source?.payload || source.version !== version || (operation === "void") === (source.status === "void")) {
    throw new AccountingError("This document changed or is already in the requested state.");
  }
  if (source.voucherId && source.date) {
    await openPeriod(tx, companyId, source.date);
    if (await approvalRequired(tx, companyId)) context.require("approve");
  }
  if (operation === "void") {
    if ("partyId" in source) await checkDependencies(tx, companyId, source);
    const document = await documentFor(tx, companyId, kind, id);
    if (document) {
      const [voided] = await tx.update(voucherDocuments).set({ status: "void", version: document.version + 1 }).where(eq(voucherDocuments.id, document.id)).returning();
      await recordChange(tx, context, document, voided, reason, "origin_voided");
    }
    const table = kind === "invoice" ? invoices : inventoryAdjustments;
    const [updated] = await tx.update(table).set({ status: "void", version: source.version + 1 }).where(eq(table.id, id)).returning();
    if (source.voucherId) await recalculate(tx, context, { id, reason });
    await tx.insert(deletedRecords).values({ companyId, entityType: kind, entityId: id, reason, deletedBy: actorId });
    await history(tx, context, kind, source, updated, reason);
  } else {
    if (source.voucherId) {
      context.require("post");
      const input = "partyId" in source ? await validateInvoice(tx, context, invoiceSchema.parse(source.payload), id, true, true)
        : adjustmentSchema.parse(source.payload);
      const event = "type" in input ? { kind: "invoice" as const, id, createdAt: source.createdAt, input }
        : { kind: "inventory_adjustment" as const, id, createdAt: source.createdAt, input };
      if (event.kind === "inventory_adjustment" && event.input.kind === "valuation") context.require("approve");
      await recalculate(tx, context, { id, replacement: event, reason });
    } else {
      const table = kind === "invoice" ? invoices : inventoryAdjustments;
      const [updated] = await tx.update(table).set({ status: "draft", version: source.version + 1 }).where(eq(table.id, id)).returning();
      await history(tx, context, kind, source, updated, reason);
    }
    const last = await tx.execute<{ id: string }>(sql`
      SELECT d.id FROM deleted_records d WHERE d.company_id=${companyId} AND d.entity_type=${kind} AND d.entity_id=${id}
        AND NOT EXISTS (SELECT 1 FROM restoration_history r WHERE r.company_id=d.company_id AND r.deletion_id=d.id)
      ORDER BY d.deleted_at DESC,d.id DESC LIMIT 1
    `);
    if (!last.rows.length) throw new AccountingError("There is no unresolved deletion for this document.");
    await tx.insert(restorationHistory).values({ companyId, deletionId: last.rows[0].id, restoredBy: actorId, reason });
  }
  return { id };
}
