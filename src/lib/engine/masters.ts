import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Transaction } from "../../db";
import { accounts, auditLogs, companySettings, deletedRecords, journalLines, openingBalances, parties, restorationHistory, salesExecutives, voucherDocuments } from "../../db/schema";
import { AccountingError, Exact, accountDate, amount, reasonText } from "./model";
import { approvalRequired, getDocument, publishDocument, recordChange, type FinanceContext } from "./vouchers";
import { journalSnapshot, openPeriod } from "./posting";

export const openingSchema = z.object({
  kind: z.enum(["party", "account"]), targetId: z.uuid(), date: accountDate,
  direction: z.enum(["debit", "credit"]), amount,
  version: z.coerce.number().int().min(0), reason: reasonText,
});

export const accountSchema = z.object({
  id: z.uuid().optional(), version: z.coerce.number().int().min(0), code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(120), type: z.enum(["asset", "liability", "equity", "income", "expense"]),
  parentId: z.uuid().nullable(), liquidity: z.enum(["cash", "bank"]).nullable(), active: z.boolean(),
});

export const partySchema = z.object({
  id: z.uuid().optional(), version: z.coerce.number().int().min(0), type: z.enum(["customer", "supplier"]),
  name: z.string().trim().min(1).max(160), phone: z.string().trim().max(60), address: z.string().trim().max(500),
  contact: z.string().trim().max(120), email: z.union([z.literal(""), z.email().max(200)]),
  ntn: z.string().trim().max(60), strn: z.string().trim().max(60),
  creditDays: z.coerce.number().int().min(0).max(3650), creditLimit: amount, notes: z.string().trim().max(1000),
  active: z.boolean(),
});

export const salesExecutiveSchema = z.object({
  id: z.uuid().optional(), version: z.coerce.number().int().min(0),
  name: z.string().trim().min(1, "Enter the sales executive name.").max(120), phone: z.string().trim().max(60), active: z.boolean(),
});

export async function saveAccount(tx: Transaction, context: FinanceContext, parsed: z.infer<typeof accountSchema>) {
  const { companyId, actorId } = context;
  const { id, version, ...values } = parsed;
  context.require(id ? "edit" : "create");
  const existing = id ? (await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.id, id))))[0] : undefined;
  if (id && (!existing || existing.version !== version)) throw new AccountingError("This account changed. Reload it before editing.");
  if (values.liquidity && values.type !== "asset") throw new AccountingError("Cash and bank accounts must be assets.");
  if (existing?.control && (!values.active || values.type !== existing.type || values.liquidity !== existing.liquidity)) {
    throw new AccountingError("A system account’s classification, liquidity and active status are protected.");
  }
  if (values.parentId) {
    const lineage = await tx.execute<{ id: string; type: string; active: boolean }>(sql`
      with recursive parents as (
        select id, parent_id, type, active from accounts where company_id = ${companyId} and id = ${values.parentId}
        union
        select a.id, a.parent_id, a.type, a.active from accounts a join parents p on p.parent_id = a.id
        where a.company_id = ${companyId}
      ) select id, type, active from parents
    `);
    if (!lineage.rows.length || lineage.rows.some((parent) => parent.id === id || parent.type !== values.type || (!parent.active && values.active))) {
      throw new AccountingError("Choose a valid same-classification parent outside this account’s descendants.");
    }
  }
  if (existing && (!values.active || values.type !== existing.type)) {
    const [child] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.parentId, existing.id))).limit(1);
    if (child) throw new AccountingError("Move this account’s subaccounts before changing its classification or deactivating it.");
    if (values.type !== existing.type) {
      const [line] = await tx.select({ id: journalLines.id }).from(journalLines).where(and(eq(journalLines.companyId, companyId), eq(journalLines.accountId, existing.id))).limit(1);
      if (line) throw new AccountingError("An account used in a journal keeps its classification.");
    }
  }
  const [saved] = existing
    ? await tx.update(accounts).set({ ...values, version: version + 1 }).where(eq(accounts.id, existing.id)).returning()
    : await tx.insert(accounts).values({ ...values, companyId }).returning();
  await tx.insert(auditLogs).values({ companyId, actorId, action: "account.saved", data: { before: existing, after: saved } });
  return saved.id;
}

export async function saveParty(tx: Transaction, context: FinanceContext, parsed: z.infer<typeof partySchema>) {
  const { companyId, actorId } = context;
  const { id, version, ...values } = parsed;
  context.require(id ? "edit" : "create");
  const [existing] = id ? await tx.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, id))) : [];
  if (id && (!existing || existing.version !== version)) throw new AccountingError("This party changed. Reload it before editing.");
  if (existing && existing.type !== values.type) {
    throw new AccountingError("A party keeps its customer or supplier classification. Create a separate account for the other role.");
  }
  const [saved] = existing
    ? await tx.update(parties).set({ ...values, version: version + 1 }).where(eq(parties.id, existing.id)).returning()
    : await tx.insert(parties).values({ ...values, companyId }).returning();
  await tx.insert(auditLogs).values({ companyId, actorId, action: "party.saved", data: { before: existing, after: saved } });
  return saved.id;
}

/** Executives are never deleted. Deactivation removes them from new documents and keeps their reported history. */
export async function saveSalesExecutive(tx: Transaction, context: FinanceContext, parsed: z.infer<typeof salesExecutiveSchema>) {
  const { companyId, actorId } = context;
  const { id, version, ...values } = parsed;
  context.require(id ? "edit" : "create");
  const [existing] = id ? await tx.select().from(salesExecutives).where(and(eq(salesExecutives.companyId, companyId), eq(salesExecutives.id, id))) : [];
  if (id && (!existing || existing.version !== version)) throw new AccountingError("This sales executive changed. Reload before saving.");
  const [duplicate] = await tx.select({ id: salesExecutives.id }).from(salesExecutives)
    .where(and(eq(salesExecutives.companyId, companyId), sql`lower(${salesExecutives.name})=lower(${values.name})`));
  if (duplicate && duplicate.id !== id) throw new AccountingError("A sales executive with this name already exists.");
  const [saved] = existing
    ? await tx.update(salesExecutives).set({ ...values, version: version + 1 }).where(eq(salesExecutives.id, existing.id)).returning()
    : await tx.insert(salesExecutives).values({ ...values, companyId }).returning();
  await tx.insert(auditLogs).values({ companyId, actorId, action: "sales_executive.saved", data: { before: existing, after: saved } });
  return saved.id;
}

export async function saveOpening(tx: Transaction, context: FinanceContext, input: z.infer<typeof openingSchema>) {
  const { companyId, actorId } = context;
  const condition = input.kind === "party" ? voucherDocuments.openingPartyId : voucherDocuments.openingAccountId;
  const [candidate] = await tx.select({ id: voucherDocuments.id }).from(voucherDocuments)
    .where(and(eq(voucherDocuments.companyId, companyId), eq(condition, input.targetId)));
  let doc = candidate ? await getDocument(tx, companyId, candidate.id) : undefined;
  if ((doc?.version ?? 0) !== input.version) throw new AccountingError("An opening balance changed. Reload it before saving again.");
  const value = new Exact(input.amount);
  if (!doc && value.isZero()) return { id: input.targetId };
  if (doc && doc.status === "void" && value.isZero()) return { id: input.targetId };
  context.require(doc ? "edit" : "create");
  context.require("post");
  if (await approvalRequired(tx, companyId)) context.require("approve");
  if (!doc) {
    const [prior] = await tx.select({ id: openingBalances.id }).from(openingBalances)
      .innerJoin(journalLines, and(eq(openingBalances.companyId, journalLines.companyId), eq(openingBalances.journalLineId, journalLines.id)))
      .where(and(eq(openingBalances.companyId, companyId), input.kind === "party"
        ? eq(journalLines.partyId, input.targetId) : and(eq(journalLines.accountId, input.targetId), sql`${journalLines.partyId} is null`))).limit(1);
    if (prior) throw new AccountingError("An imported opening posting already exists. Reconcile its source mapping before editing.");
  }
  if (doc?.currentVoucherId) {
    const prior = await journalSnapshot(tx, companyId, doc.currentVoucherId);
    await openPeriod(tx, companyId, prior.header.date);
  }
  if (doc && value.isZero()) {
    context.require("delete");
    const [voided] = await tx.update(voucherDocuments).set({ status: "void", version: doc.version + 1 })
      .where(eq(voucherDocuments.id, doc.id)).returning();
    await tx.insert(deletedRecords).values({ companyId, entityType: "opening", entityId: doc.id, reason: input.reason, deletedBy: actorId });
    await recordChange(tx, context, doc, voided, input.reason, "opening_voided");
    return { id: doc.id };
  }

  const [settings] = await tx.select().from(companySettings).where(eq(companySettings.companyId, companyId));
  const [offset] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId),
    settings.openingOffsetId ? eq(accounts.id, settings.openingOffsetId) : eq(accounts.control, "opening_equity")));
  if (!offset?.active || offset.type !== "equity") throw new AccountingError("Configure an active opening-balance equity account.");
  const [party] = input.kind === "party"
    ? await tx.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, input.targetId))) : [];
  if (input.kind === "party" && !party?.active) throw new AccountingError("Choose an active party.");
  const [account] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId),
    party ? eq(accounts.control, party.type === "customer" ? "receivable" : "payable") : eq(accounts.id, input.targetId)));
  if (!account?.active || account.id === offset.id || (!party && ["receivable", "payable"].includes(account.control ?? ""))) {
    throw new AccountingError("Use an active non-offset account or enter control balances through their parties.");
  }
  const direction = input.direction === "debit";
  const amount = value.toFixed(2);
  const entry = {
    type: "opening" as const, date: input.date, reference: "", narration: `Opening balance · ${party?.name ?? account.name}`,
    lines: [
      { accountId: account.id, partyId: party?.id ?? null, description: "", debit: direction ? amount : "0", credit: direction ? "0" : amount },
      { accountId: offset.id, partyId: null, description: "", debit: direction ? "0" : amount, credit: direction ? amount : "0" },
    ],
  };
  if (!doc) {
    [doc] = await tx.insert(voucherDocuments).values({
      companyId, type: "opening", source: "opening", date: input.date, createdBy: actorId, draft: { entry },
      openingPartyId: party?.id, openingAccountId: party ? undefined : account.id,
    }).returning();
  }
  if (doc.status === "void") context.require("restore");
  const posted = await publishDocument(tx, context, doc, entry);
  const [anchor] = await tx.select({ id: journalLines.id }).from(journalLines)
    .where(and(eq(journalLines.companyId, companyId), eq(journalLines.voucherId, posted.voucherId), eq(journalLines.lineNo, 1)));
  await tx.insert(openingBalances).values({ companyId, yearId: posted.yearId, journalLineId: anchor.id });
  if (doc.status === "void") {
    const result = await tx.execute<{ id: string }>(sql`
      select d.id from deleted_records d where d.company_id = ${companyId} and d.entity_type = 'opening'
      and d.entity_id = ${doc.id} and not exists (select 1 from restoration_history r where r.company_id = d.company_id and r.deletion_id = d.id)
      order by d.deleted_at desc, d.id desc limit 1
    `);
    if (result.rows.length) await tx.insert(restorationHistory).values({ companyId, deletionId: result.rows[0].id, restoredBy: actorId, reason: input.reason });
  }
  await recordChange(tx, context, doc, posted.document, input.reason, "opening_saved");
  return { id: doc.id };
}

export async function configureAccounting(
  tx: Transaction, companyId: string, actorId: string, approval: boolean, offsetId: string | null,
) {
  if (offsetId) {
    const [account] = await tx.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.id, offsetId)));
    if (!account?.active || account.type !== "equity") throw new AccountingError("Choose an active equity account in this company.");
  }
  const [before] = await tx.select().from(companySettings).where(eq(companySettings.companyId, companyId));
  await tx.update(companySettings).set({ voucherApproval: approval, openingOffsetId: offsetId }).where(eq(companySettings.companyId, companyId));
  await tx.insert(auditLogs).values({ companyId, actorId, action: "accounting.configured",
    data: { before: { approval: before.voucherApproval, offsetId: before.openingOffsetId }, after: { approval, offsetId } } });
}
