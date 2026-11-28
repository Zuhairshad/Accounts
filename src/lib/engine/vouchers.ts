import { and, eq, sql } from "drizzle-orm";
import type { Transaction } from "../../db";
import { auditLogs, companySettings, deletedRecords, restorationHistory, revisions, voucherDocuments, voucherVersions } from "../../db/schema";
import { AccountingError, manualType, manualVoucher, type DraftSnapshot, type JournalInput, type Transition, type VoucherInput } from "./model";
import { balanced, ensureUnallocated, journalSnapshot, openPeriod, postJournal, protectOrigin, validateLines, validateManual } from "./posting";

export type FinanceContext = { companyId: string; actorId: string; require: (permission: "create" | "edit" | "post" | "delete" | "restore" | "approve") => void };
export type Document = typeof voucherDocuments.$inferSelect;

export async function getDocument(tx: Transaction, companyId: string, id: string) {
  const [document] = await tx.select().from(voucherDocuments)
    .where(and(eq(voucherDocuments.companyId, companyId), eq(voucherDocuments.id, id))).for("update");
  return document;
}

export function assertVersion(document: Document | undefined, version: number) {
  if (!document || document.version !== version) throw new AccountingError("This transaction changed. Reload it before trying again.");
}

export async function snapshot(tx: Transaction, document: Document) {
  return {
    ...document,
    posting: document.currentVoucherId ? await journalSnapshot(tx, document.companyId, document.currentVoucherId) : null,
  };
}

export async function recordChange(
  tx: Transaction, context: FinanceContext, before: Document, after: Document, reason: string, action: string,
  previousData?: unknown,
) {
  await tx.insert(revisions).values({
    companyId: context.companyId, entityType: "voucher", entityId: before.id, version: after.version,
    actorId: context.actorId, reason, previousData: previousData ?? await snapshot(tx, before), nextData: await snapshot(tx, after),
  });
  await tx.insert(auditLogs).values({
    companyId: context.companyId, actorId: context.actorId, action: `voucher.${action}`, data: { documentId: before.id, version: after.version, reason },
  });
}

export async function approvalRequired(tx: Transaction, companyId: string) {
  const [settings] = await tx.select({ approval: companySettings.voucherApproval }).from(companySettings)
    .where(eq(companySettings.companyId, companyId));
  return settings.approval;
}

export async function publishDocument(tx: Transaction, context: FinanceContext, document: Document, entry: JournalInput) {
  const posted = await postJournal(tx, { ...context, documentId: document.id, originalNumber: document.number }, entry);
  const [updated] = await tx.update(voucherDocuments).set({
    status: "posted", draft: null, currentVoucherId: posted.voucherId, number: posted.number,
    date: entry.date, reference: entry.reference, version: sql`${voucherDocuments.version} + 1`,
  }).where(eq(voucherDocuments.id, document.id)).returning();
  return { document: updated, ...posted };
}

async function writablePosting(tx: Transaction, doc: Document) {
  if (doc.currentVoucherId) {
    const posting = await journalSnapshot(tx, doc.companyId, doc.currentVoucherId);
    await openPeriod(tx, doc.companyId, posting.header.date);
    await protectOrigin(tx, doc.companyId, doc.currentVoucherId);
    await ensureUnallocated(tx, doc.companyId, doc.currentVoucherId);
  }
}

async function adoptLegacy(tx: Transaction, context: FinanceContext, id: string) {
  const { companyId, actorId } = context;
  const previous = await journalSnapshot(tx, companyId, id);
  const source = previous.header;
  if (source.status !== "posted" || !source.number || !manualType.safeParse(source.type).success) {
    throw new AccountingError("Manage this voucher through its originating document.");
  }
  await protectOrigin(tx, companyId, id);
  await openPeriod(tx, companyId, source.date);
  const [doc] = await tx.insert(voucherDocuments).values({
    id, companyId, type: source.type, number: source.number, date: source.date, createdBy: actorId,
    draft: { entry: { ...source, lines: previous.lines } },
  }).returning();
  await tx.insert(voucherVersions).values({ companyId, documentId: doc.id, voucherId: id });
  // A new version: the append-only posting timeline already holds the inserted draft version.
  const [adopted] = await tx.update(voucherDocuments).set({ currentVoucherId: id, draft: null, status: "posted", version: sql`${voucherDocuments.version} + 1` })
    .where(eq(voucherDocuments.id, id)).returning();
  return adopted;
}

export async function saveManual(
  tx: Transaction, context: FinanceContext,
  { entry, id, version, reason, intent, salesExecutiveId }: {
    entry: VoucherInput; id?: string; version: number; reason: string; intent: "draft" | "post" | "submit";
    /** A validated executive credited with a new receipt. Edits keep the stored executive. */
    salesExecutiveId?: string | null;
  },
) {
  const { companyId, actorId } = context;
  context.require(id ? "edit" : "create");
  let existing = id ? await getDocument(tx, companyId, id) : undefined;
  if (id && !existing && version === 0) existing = await adoptLegacy(tx, context, id);
  else if (id) assertVersion(existing, version);
  if (existing && (existing.source !== "manual" || existing.status === "void" || existing.type !== entry.type)) {
    throw new AccountingError("This voucher cannot be edited here.");
  }
  const approval = await approvalRequired(tx, companyId);
  if (existing?.status === "posted") {
    if (intent !== "post" || reason.length < 3) throw new AccountingError("Enter a reason to revise a posted voucher.");
    if (approval) context.require("approve");
    await writablePosting(tx, existing);
  }
  if (intent === "post") {
    context.require("post");
    if (approval && existing?.status !== "posted") throw new AccountingError("Submit this draft for approval first.");
  }
  await validateManual(tx, companyId, entry, intent !== "draft");
  if (intent !== "draft") await openPeriod(tx, companyId, entry.date);
  const draft = { entry } satisfies DraftSnapshot;
  if (!existing) {
    [existing] = await tx.insert(voucherDocuments).values({
      companyId, type: entry.type, date: entry.date, reference: entry.reference, createdBy: actorId,
      draft, submittedBy: intent === "submit" ? actorId : null, salesExecutiveId: salesExecutiveId ?? null,
    }).returning();
    await tx.insert(auditLogs).values({ companyId, actorId, action: "voucher.created", data: { documentId: existing.id, intent } });
    if (intent !== "post") {
      await recordChange(tx, context, existing, existing, intent === "submit" ? "Draft created and submitted" : "Draft created", intent, {});
      return { id: existing.id };
    }
  } else if (intent !== "post") {
    const [updated] = await tx.update(voucherDocuments).set({
      draft, date: entry.date, reference: entry.reference, submittedBy: intent === "submit" ? actorId : null,
      version: sql`${voucherDocuments.version} + 1`,
    }).where(eq(voucherDocuments.id, existing.id)).returning();
    await recordChange(tx, context, existing, updated, reason || (intent === "submit" ? "Submitted for approval" : "Draft updated"), intent);
    return { id: existing.id };
  }
  const next = await publishDocument(tx, context, existing, entry);
  await recordChange(tx, context, existing, next.document, reason || "Voucher posted", existing.status === "posted" ? "revised" : "posted");
  return { id: existing.id, number: next.number };
}

export async function changeVoucher(
  tx: Transaction, context: FinanceContext, input: { id: string; version: number; operation: Transition; reason: string },
) {
  const { companyId, actorId } = context;
  let doc = await getDocument(tx, companyId, input.id);
  if (!doc && input.version === 0 && input.operation === "delete") {
    context.require("delete");
    doc = await adoptLegacy(tx, context, input.id);
  } else assertVersion(doc, input.version);
  const opening = doc?.source === "opening" && input.operation === "restore";
  if (!doc || (doc.source !== "manual" && !opening)) throw new AccountingError("Manage this voucher through its originating document.");
  const approval = await approvalRequired(tx, companyId);
  let updated: Document;
  if (input.operation === "post" || input.operation === "submit") {
    if (doc.status !== "draft") throw new AccountingError("Only a draft can be submitted or posted.");
    const entry = manualVoucher.parse((doc.draft as DraftSnapshot).entry);
    await validateManual(tx, companyId, entry, true);
    await openPeriod(tx, companyId, entry.date);
    if (input.operation === "submit") {
      context.require("edit");
      if (doc.submittedBy) throw new AccountingError("This draft has already been submitted.");
      [updated] = await tx.update(voucherDocuments).set({ submittedBy: actorId, version: doc.version + 1 })
        .where(eq(voucherDocuments.id, doc.id)).returning();
    } else {
      context.require("post");
      if (approval) {
        context.require("approve");
        if (!doc.submittedBy || doc.submittedBy === actorId || doc.createdBy === actorId) {
          throw new AccountingError("A different authorized user must approve the submitted draft.");
        }
      }
      updated = (await publishDocument(tx, context, doc, entry)).document;
    }
  } else if (input.operation === "delete") {
    context.require("delete");
    if (doc.status === "void") throw new AccountingError("This voucher is already voided.");
    if (doc.status === "posted" && approval) context.require("approve");
    await writablePosting(tx, doc);
    [updated] = await tx.update(voucherDocuments).set({ status: "void", version: doc.version + 1 })
      .where(eq(voucherDocuments.id, doc.id)).returning();
    await tx.insert(deletedRecords).values({ companyId, entityType: "voucher", entityId: doc.id, reason: input.reason, deletedBy: actorId });
  } else {
    context.require("restore");
    if (doc.status !== "void") throw new AccountingError("This voucher has already been restored or is active.");
    const latest = await tx.execute<{ id: string }>(sql`
      select d.id from deleted_records d where d.company_id = ${companyId} and d.entity_type = ${opening ? 'opening' : 'voucher'}
      and d.entity_id = ${doc.id} and not exists (
        select 1 from restoration_history r where r.company_id = d.company_id and r.deletion_id = d.id
      ) order by d.deleted_at desc, d.id desc limit 1
    `);
    if (!latest.rows.length) throw new AccountingError("There is no pending deletion to restore.");
    if (doc.currentVoucherId) {
      context.require("post");
      if (approval) context.require("approve");
      await writablePosting(tx, doc);
      const previous = await journalSnapshot(tx, companyId, doc.currentVoucherId);
      if (opening) {
        balanced(previous.lines);
        await validateLines(tx, companyId, previous.lines);
      } else {
        const entry = manualVoucher.parse({ ...previous.header, reference: doc.reference, lines: previous.lines,
          mode: previous.lines.some((line) => line.partyId) ? "party" : "direct" });
        await validateManual(tx, companyId, entry, true);
      }
    }
    [updated] = await tx.update(voucherDocuments).set({ status: doc.currentVoucherId ? "posted" : "draft", version: doc.version + 1 })
      .where(eq(voucherDocuments.id, doc.id)).returning();
    await tx.insert(restorationHistory).values({ companyId, deletionId: latest.rows[0].id, restoredBy: actorId, reason: input.reason });
  }
  await recordChange(tx, context, doc, updated, input.reason, input.operation);
  return { id: doc.id };
}

export async function repairLegacyParty(
  tx: Transaction, context: FinanceContext,
  input: { voucherId: string; reason: string; links: { lineNumber: number; partyId: string }[] },
) {
  context.require("edit");
  context.require("post");
  if (await approvalRequired(tx, context.companyId)) context.require("approve");
  const { companyId, actorId } = context;
  await protectOrigin(tx, companyId, input.voucherId);
  await ensureUnallocated(tx, companyId, input.voucherId);
  const previous = await journalSnapshot(tx, companyId, input.voucherId);
  const source = previous.header;
  if (source.status !== "posted" || !manualType.safeParse(source.type).success || !source.number) throw new AccountingError("This legacy voucher cannot be repaired here.");
  await openPeriod(tx, companyId, source.date);
  const [managed] = await tx.select().from(voucherVersions)
    .where(and(eq(voucherVersions.companyId, companyId), eq(voucherVersions.voucherId, source.id)));
  if (managed) throw new AccountingError("This journal already belongs to a managed voucher.");
  const links = new Map(input.links.map((link) => [link.lineNumber, link.partyId]));
  if (!links.size || links.size !== input.links.length || [...links.keys()].some((line) => !previous.lines.some((original) => original.lineNo === line && !original.partyId))) {
    throw new AccountingError("Choose a party for each unlinked line being repaired.");
  }
  const entry: JournalInput = {
    type: source.type, date: source.date, narration: source.narration, reference: "",
    lines: previous.lines.map((line) => ({ ...line, partyId: links.get(line.lineNo) ?? line.partyId })),
  };
  await validateLines(tx, companyId, entry.lines);
  const [doc] = await tx.insert(voucherDocuments).values({
    id: source.id, companyId, type: source.type, date: source.date,
    number: source.number, createdBy: actorId, draft: { entry },
  }).returning();
  await tx.insert(voucherVersions).values({ companyId, documentId: doc.id, voucherId: source.id });
  const next = await publishDocument(tx, context, doc, entry);
  await recordChange(tx, context, doc, next.document, input.reason, "party_repaired", previous);
  return { id: doc.id };
}

/** Origin services must call this inside the same transaction as their source rows and stock changes. */
export async function postOriginVoucher(
  tx: Transaction, context: FinanceContext,
  source: { kind: "invoice" | "inventory_adjustment"; id: string }, entry: JournalInput,
) {
  context.require("post");
  if (await approvalRequired(tx, context.companyId)) context.require("approve");
  const allowed = source.kind === "invoice" ? ["sale", "purchase", "sale_return", "purchase_return"] : ["adjustment"];
  if (!allowed.includes(entry.type)) throw new AccountingError("The journal type does not match its originating document.");
  const [doc] = await tx.insert(voucherDocuments).values({
    companyId: context.companyId, type: entry.type, date: entry.date, createdBy: context.actorId,
    source: source.kind, sourceId: source.id, draft: { entry },
  }).returning();
  const posted = await publishDocument(tx, context, doc, entry);
  await recordChange(tx, context, doc, posted.document, "Posted by originating document", "posted");
  return posted;
}
