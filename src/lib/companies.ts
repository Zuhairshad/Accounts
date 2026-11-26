import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "@/db";
import { accounts, auditLogs, companies, companyMembers, companyRoles, companySettings, financialYears, journalLines, parties, users, effectiveVouchers, invoices } from "@/db/schema";
import { AccessError, type Actor } from "./auth";
import { permissions, type Permission } from "./permissions";

export async function companyList(actor: Actor, db: Database | Transaction = getDb()) {
  if (actor.superAdmin) {
    const rows = await db.select().from(companies).orderBy(desc(companies.active), asc(companies.name));
    return rows.map((company) => ({ ...company, permissions: [...permissions] }));
  }
  return db.select({
    id: companies.id, name: companies.name, active: companies.active, version: companies.version,
    createdAt: companies.createdAt, permissions: companyRoles.permissions,
  }).from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .innerJoin(companyRoles, and(eq(companyRoles.id, companyMembers.roleId), eq(companyRoles.companyId, companyMembers.companyId)))
    .where(eq(companyMembers.userId, actor.id)).orderBy(desc(companies.active), asc(companies.name));
}

export async function requireCompany(actor: Actor, companyId: string, permission: Permission, tx?: Transaction, allowInactive = false) {
  const company = (await companyList(actor, tx)).find((row) => row.id === companyId);
  if (!company || (!allowInactive && !company.active) || !company.permissions.includes(permission)) throw new AccessError();
  return company;
}

export async function lockCompany(tx: Transaction, companyId: string) {
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update");
}

export async function lockActor(tx: Transaction, actor: Actor, write = false) {
  const [current] = await tx.select({ active: users.active, version: users.sessionVersion })
    .from(users).where(eq(users.id, actor.id)).for(write ? "update" : "share");
  if (!current?.active || current.version !== actor.version) throw new AccessError();
}

export async function logAudit(tx: Transaction, actorId: string, action: string, companyId?: string, data: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({ action, actorId, companyId, data });
}

export async function companyDetails(companyId: string) {
  const db = getDb();
  const [[settings], years] = await Promise.all([
    db.select().from(companySettings).where(eq(companySettings.companyId, companyId)),
    db.select().from(financialYears).where(eq(financialYears.companyId, companyId)).orderBy(desc(financialYears.startsOn)),
  ]);
  return { settings, years };
}

export async function companyMembersAndRoles(companyId: string) {
  const db = getDb();
  return Promise.all([
    db.select({ id: users.id, username: users.username, displayName: users.displayName, roleId: companyMembers.roleId })
      .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
      .where(eq(companyMembers.companyId, companyId)).orderBy(users.username),
    db.select().from(companyRoles).where(eq(companyRoles.companyId, companyId)).orderBy(companyRoles.name),
  ]);
}

export async function dashboard(companyId: string, range: { from: string; to: string }) {
  return getDb().transaction(async (db) => {
    const [result] = await db.select({
      count: sql<string>`count(distinct ${effectiveVouchers.id})::text`,
      debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
    }).from(effectiveVouchers).leftJoin(journalLines, and(eq(journalLines.voucherId, effectiveVouchers.id), eq(journalLines.companyId, companyId)))
      .where(and(eq(effectiveVouchers.companyId, companyId),
        gte(effectiveVouchers.date, range.from), lte(effectiveVouchers.date, range.to)));
    const recent = await db.select({
      id: effectiveVouchers.documentId, number: effectiveVouchers.number, date: effectiveVouchers.date, type: effectiveVouchers.type, narration: effectiveVouchers.narration,
    }).from(effectiveVouchers).where(and(eq(effectiveVouchers.companyId, companyId),
      gte(effectiveVouchers.date, range.from), lte(effectiveVouchers.date, range.to)))
      .orderBy(desc(effectiveVouchers.date), desc(effectiveVouchers.createdAt)).limit(12);
    return { ...result, recent };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function combinedDashboard(ids: string[], range: { from: string; to: string }) {
  if (!ids.length) return [];
  return getDb().select({
    id: companies.id, name: companies.name,
    count: sql<string>`count(distinct ${effectiveVouchers.id})::text`,
    debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)::text`,
    credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)::text`,
  }).from(companies)
    .leftJoin(effectiveVouchers, and(eq(effectiveVouchers.companyId, companies.id),
      gte(effectiveVouchers.date, range.from), lte(effectiveVouchers.date, range.to)))
    .leftJoin(journalLines, and(eq(journalLines.companyId, companies.id), eq(journalLines.voucherId, effectiveVouchers.id)))
    .where(inArray(companies.id, ids)).groupBy(companies.id, companies.name).orderBy(companies.name);
}

export async function searchCompany(companyId: string, prefix: string) {
  const query = prefix.toLowerCase();
  const db = getDb();
  const [heads, contacts, documents, entries] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.name, kind: accounts.type })
      .from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.active, true),
        sql`(strpos(lower(${accounts.name}), ${query}) > 0 or strpos(lower(${accounts.code}), ${query}) > 0)`))
      .orderBy(accounts.name).limit(15),
    db.select({ id: parties.id, name: parties.name, kind: parties.type })
      .from(parties).where(and(eq(parties.companyId, companyId), eq(parties.active, true),
        sql`strpos(lower(${parties.name}), ${query}) > 0`)).orderBy(parties.name).limit(15),
    db.select({ id: invoices.id, name: invoices.number, kind: invoices.type })
      .from(invoices).innerJoin(effectiveVouchers, and(eq(effectiveVouchers.companyId, invoices.companyId), eq(effectiveVouchers.id, invoices.voucherId)))
      .where(and(eq(invoices.companyId, companyId), eq(invoices.status, "posted"),
        sql`strpos(lower(${invoices.number}), ${query}) > 0`)).orderBy(desc(invoices.date)).limit(15),
    db.select({ id: effectiveVouchers.documentId, name: effectiveVouchers.number, kind: effectiveVouchers.type })
      .from(effectiveVouchers).where(and(eq(effectiveVouchers.companyId, companyId),
        sql`strpos(lower(concat_ws(' ', ${effectiveVouchers.number}, ${effectiveVouchers.reference}, ${effectiveVouchers.narration})), ${query}) > 0`))
      .orderBy(desc(effectiveVouchers.date)).limit(15),
  ]);
  return [
    ...heads.map((row) => ({ ...row, path: "accounting/chart" })),
    ...contacts.map((row) => ({ ...row, path: "accounting/parties" })),
    ...entries.map((row) => ({ ...row, path: "accounting/vouchers" })),
    ...documents.map((row) => ({ ...row, path: "trade/invoices" })),
  ];
}
