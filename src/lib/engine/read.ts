import { and, eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "../../db";
import { accounts, effectiveVouchers, journalLines, parties, voucherDocuments } from "../../db/schema";
import { Exact } from "./model";

type Reader = Database | Transaction;

export async function readLedger(
  db: Reader, companyId: string, target: { accountId: string } | { partyId: string }, from: string, to: string,
) {
  const condition = "accountId" in target ? sql`l.account_id = ${target.accountId}` : sql`l.party_id = ${target.partyId}`;
  const result = await db.execute<{
    id: string | null; documentId: string | null; date: string | null; number: string | null; type: string | null;
    reference: string | null; narration: string | null; code: string | null; account: string | null;
    debit: string | null; credit: string | null; running: string | null; opening: string; closing: string;
  }>(sql`
    WITH entries AS (
      SELECT l.id, v.document_id, v.accounting_date, v.number, v.type, v.reference, v.narration,
        a.code, a.name, l.debit, l.credit, l.line_no, v.created_at, v.id AS voucher_id,
        sum(l.debit-l.credit) OVER (ORDER BY v.accounting_date,v.created_at,v.id,l.line_no) AS running
      FROM ${journalLines} l JOIN ${effectiveVouchers} v ON v.company_id=l.company_id AND v.id=l.voucher_id
      JOIN ${accounts} a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE l.company_id=${companyId} AND ${condition} AND v.accounting_date<=${to}::date
    ), totals AS (
      SELECT coalesce(sum(debit-credit) FILTER (WHERE accounting_date<${from}::date),0) AS opening,
        coalesce(sum(debit-credit),0) AS closing FROM entries
    )
    SELECT entries.id, document_id AS "documentId", accounting_date::text AS date, number, type, reference, narration,
      code, name AS account, debit::text, credit::text, running::text, opening::text, closing::text
    FROM totals LEFT JOIN entries ON entries.accounting_date>=${from}::date
    ORDER BY accounting_date, created_at, voucher_id, line_no
  `);
  return { opening: result.rows[0].opening, closing: result.rows[0].closing, rows: result.rows.filter((row) => row.id !== null) };
}

export async function partyBalances(db: Reader, companyId: string, to: string) {
  const result = await db.execute<{
    id: string; name: string; type: "customer" | "supplier"; active: boolean; balance: string;
  }>(sql`
    WITH party_journal AS (
      SELECT l.party_id, sum(l.debit-l.credit) AS balance
      FROM journal_lines l JOIN effective_vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      WHERE l.company_id=${companyId} AND v.accounting_date<=${to}::date
        AND l.party_id IS NOT NULL AND a.control IN ('receivable','payable')
      GROUP BY l.party_id
    )
    SELECT p.id, p.name, p.type, p.active, coalesce(j.balance,0)::text AS balance
    FROM parties p LEFT JOIN party_journal j ON j.party_id=p.id
    WHERE p.company_id=${companyId} ORDER BY p.name,p.id
  `);
  return result.rows;
}

/**
 * Openings imported from the desktop application: posted JVs numbered OPENING-ACCOUNT-n / OPENING-PARTY-n, one line per
 * account or party against the opening equity offset. They are not opening documents, so the Opening balances screen
 * shows them read-only and refuses a second opening for the same account or party.
 */
export async function importedOpenings(db: Reader, companyId: string) {
  const result = await db.execute<{ documentId: string; number: string; date: string; targetId: string; net: string }>(sql`
    SELECT e.document_id AS "documentId",e.number,e.accounting_date::text AS date,coalesce(l.party_id,l.account_id) AS "targetId",
      sum(l.debit-l.credit)::text AS net
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    LEFT JOIN voucher_documents d ON d.company_id=e.company_id AND d.id=e.document_id
    WHERE e.company_id=${companyId} AND e.number ~ '^OPENING-(ACCOUNT|PARTY)-' AND d.source IS DISTINCT FROM 'opening'
      AND a.control IS DISTINCT FROM 'opening_equity'
    GROUP BY e.document_id,e.number,e.accounting_date,coalesce(l.party_id,l.account_id)
  `);
  return result.rows.map((row) => ({
    id: row.documentId, targetId: row.targetId, version: 0, date: row.date, imported: row.number,
    amount: new Exact(row.net).abs().toFixed(2), direction: new Exact(row.net).lt(0) ? "credit" as const : "debit" as const,
  }));
}

export async function openingRows(db: Reader, companyId: string) {
  const docs = await db.select({
    id: voucherDocuments.id, partyId: voucherDocuments.openingPartyId, accountId: voucherDocuments.openingAccountId,
    date: voucherDocuments.date, version: voucherDocuments.version, status: voucherDocuments.status,
    debit: journalLines.debit, credit: journalLines.credit,
  }).from(voucherDocuments).leftJoin(journalLines,
    and(eq(journalLines.companyId, voucherDocuments.companyId), eq(journalLines.voucherId, voucherDocuments.currentVoucherId), eq(journalLines.lineNo, 1)))
    .where(and(eq(voucherDocuments.companyId, companyId), eq(voucherDocuments.source, "opening")));
  const imported = await importedOpenings(db, companyId);
  return [...docs.map((doc) => ({
    id: doc.id, targetId: doc.partyId ?? doc.accountId!, version: doc.version, date: doc.date, imported: null as string | null,
    amount: doc.status === "void" ? "0.00" : new Exact(doc.debit ?? "0").plus(doc.credit ?? "0").toFixed(2),
    direction: new Exact(doc.credit ?? "0").gt(0) ? "credit" as const : "debit" as const,
  })), ...imported.filter((row) => !docs.some((doc) => doc.status !== "void" && (doc.partyId ?? doc.accountId) === row.targetId))];
}

export async function journalSelectors(db: Reader, companyId: string, date: string) {
  const [heads, balances] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code),
    partyBalances(db, companyId, date),
  ]);
  const controls = new Map(heads.map((account) => [account.control, account.id]));
  const options = heads.filter((account) => !["receivable", "payable"].includes(account.control ?? "")).map((account) => ({
    key: account.id, accountId: account.id, partyId: null as string | null, partyType: null as "customer" | "supplier" | null,
    label: `${account.code} · ${account.name}`, active: account.active, liquidity: account.liquidity, control: account.control, balance: null as string | null,
  }));
  for (const party of balances) {
    const accountId = controls.get(party.type === "customer" ? "receivable" : "payable");
    if (accountId) options.push({
      accountId, key: `${accountId}:${party.id}`, partyId: party.id, partyType: party.type, label: `${party.name} · ${party.type}`,
      active: party.active, liquidity: null, control: null, balance: party.balance,
    });
  }
  return options;
}

export async function voucherList(
  db: Reader, companyId: string, filter: { from: string; to: string; q: string; type?: string; status?: string; offset: number },
) {
  const rows = await db.execute<{
    id: string; number: string | null; reference: string; date: string; type: string; status: string;
    narration: string; total: string; source: string; count: string;
  }>(sql`
    WITH listing AS (
      SELECT v.document_id AS id, v.number, v.reference,v.accounting_date,v.type,'posted' AS status,v.narration,
        coalesce(d.source,'legacy') AS source,v.created_at,
        (SELECT coalesce(sum(l.debit),0) FROM journal_lines l WHERE l.company_id=v.company_id AND l.voucher_id=v.id) AS total
      FROM effective_vouchers v LEFT JOIN voucher_documents d ON d.company_id=v.company_id AND d.id=v.document_id
      WHERE v.company_id=${companyId} AND v.accounting_date BETWEEN ${filter.from}::date AND ${filter.to}::date
      UNION ALL
      SELECT d.id,d.number,d.reference,d.accounting_date,d.type,'draft',d.draft#>>'{entry,narration}',d.source,d.created_at,0::numeric
      FROM voucher_documents d WHERE d.company_id=${companyId} AND d.status='draft'
        AND d.accounting_date BETWEEN ${filter.from}::date AND ${filter.to}::date
    )
    SELECT id,number,reference,accounting_date::text AS date,type,status,narration,total::text,source,count(*) OVER ()::text AS count
    FROM listing WHERE (${filter.type ?? null}::text IS NULL OR type::text=${filter.type ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status=${filter.status ?? null})
      AND (${filter.q}='' OR strpos(lower(concat_ws(' ',number,reference,narration)),lower(${filter.q}))>0)
    ORDER BY accounting_date DESC,created_at DESC,id DESC LIMIT 50 OFFSET ${filter.offset}
  `);
  return rows.rows;
}

export async function readVoucher(db: Reader, companyId: string, id: string) {
  const [doc] = await db.select().from(voucherDocuments).where(and(eq(voucherDocuments.companyId, companyId), eq(voucherDocuments.id, id)));
  const [legacy] = doc ? [] : await db.select().from(effectiveVouchers)
    .where(and(eq(effectiveVouchers.companyId, companyId), eq(effectiveVouchers.id, id), eq(effectiveVouchers.documentId, id)));
  if (!doc && !legacy) return null;
  const voucherId = doc ? doc.currentVoucherId : legacy.id;
  const result = voucherId ? await db.execute<{
    id: string; lineNo: number; accountId: string; partyId: string | null; account: string;
    party: string | null; description: string; debit: string; credit: string; control: string | null; narration: string;
  }>(sql`
    SELECT l.id,l.line_no AS "lineNo",l.account_id AS "accountId",l.party_id AS "partyId",
      a.name AS account,p.name AS party,l.description,l.debit::text,l.credit::text,a.control,v.narration
    FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    JOIN vouchers v ON v.company_id=l.company_id AND v.id=l.voucher_id
    LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
    WHERE l.company_id=${companyId} AND l.voucher_id=${voucherId} ORDER BY l.line_no
  `) : { rows: [] };
  const managedOrigin = doc?.source && doc.source !== "manual";
  const linked = voucherId && !doc ? (await db.execute<{ linked: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM invoices WHERE company_id=${companyId} AND voucher_id=${voucherId})
      OR EXISTS (SELECT 1 FROM inventory_adjustments WHERE company_id=${companyId} AND voucher_id=${voucherId}) AS linked
  `)).rows[0].linked : false;
  return {
    id, number: doc ? doc.number : legacy.number, date: doc ? doc.date : legacy.date, reference: doc ? doc.reference : legacy.reference,
    type: doc ? doc.type : legacy.type, status: doc ? doc.status : "posted", version: doc?.version ?? 0,
    postedLines: result.rows, doc, readOnlyOrigin: !!managedOrigin || !!linked, narration: legacy?.narration ?? result.rows[0]?.narration ?? "",
  };
}
