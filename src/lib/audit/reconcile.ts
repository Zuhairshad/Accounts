import { sql } from "drizzle-orm";
import type { Database, Transaction } from "@/db";
import { Exact } from "@/lib/engine/model";
import { filters } from "@/lib/reports/build";
import { balanceSheet, profitLoss, summaryReport, trialBalance } from "@/lib/reports/financial";
import type { ReportRow } from "@/lib/reports/model";

/*
 * Independent accounting reconciliation.
 *
 * Every check recomputes an invariant directly from immutable journal, stock and source rows and, where a report
 * exists, compares the report's own output with that independent figure. Nothing here writes: discrepancies are
 * reported with links to the affected records so an authorised accountant can correct them through the normal,
 * audited workflows. No adjustment is ever created to make a figure balance.
 */

type Reader = Database | Transaction;
type Decimal = InstanceType<typeof Exact>;
export type CheckStatus = "pass" | "fail" | "review";
export type Finding = { label: string; href?: string; amount?: string; note?: string };
export type Check = {
  key: string; title: string; area: "journal" | "trade" | "subledger" | "inventory" | "statements";
  status: CheckStatus; summary: string; expected?: string; actual?: string; difference?: string;
  findings: Finding[]; truncated: number;
};
export type Reconciliation = { companyId: string; from: string; to: string; generatedAt: string; checks: Check[] };

const LIMIT = 200;
const d = (value: string | number | null | undefined) => new Exact(value ?? 0);
const money = (value: Decimal | string) => d(value.toString()).toFixed(2);

function check(base: Omit<Check, "findings" | "truncated" | "status"> & { status?: CheckStatus }, findings: Finding[]): Check {
  return {
    ...base, status: base.status ?? (findings.length ? "fail" : "pass"),
    findings: findings.slice(0, LIMIT), truncated: Math.max(0, findings.length - LIMIT),
  };
}

function compare(key: string, title: string, area: Check["area"], expected: Decimal, actual: Decimal, findings: Finding[], summary: string) {
  const difference = actual.minus(expected);
  return check({
    key, title, area, summary, expected: money(expected), actual: money(actual), difference: money(difference),
    status: !difference.isZero() ? "fail" : findings.length ? "review" : "pass",
  }, findings);
}

/** Read the value in the last money column of the first row whose first cell matches. */
function rowValue(rows: ReportRow[], label: string, column = -1) {
  const row = rows.find((entry) => entry.cells[0]?.value === label);
  if (!row) return null;
  const cell = column < 0 ? row.cells[row.cells.length + column] : row.cells[column];
  return cell ? d(cell.value || 0) : null;
}

export async function reconcile(db: Reader, companyId: string, range: { from: string; to: string }): Promise<Reconciliation> {
  const { from, to } = range;
  const base = `/workspace/${companyId}`;
  const voucherHref = (documentId: string) => `${base}/accounting/vouchers/${documentId}`;
  const invoiceHref = (id: string) => `${base}/trade/invoices/${id}`;
  const checks: Check[] = [];

  /* 1. Every effective voucher balances and has at least two lines (or none for an allowed zero-value source). */
  const unbalanced = (await db.execute<{ documentId: string; number: string; day: string; lines: string; dr: string; cr: string }>(sql`
    SELECT e.document_id AS "documentId",e.number,e.accounting_date::text AS day,count(l.id)::text AS lines,
      coalesce(sum(l.debit),0)::text AS dr,coalesce(sum(l.credit),0)::text AS cr
    FROM effective_vouchers e LEFT JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date
    GROUP BY e.document_id,e.number,e.accounting_date
    HAVING coalesce(sum(l.debit),0)<>coalesce(sum(l.credit),0) OR count(l.id)=1
    ORDER BY e.accounting_date,e.number`)).rows;
  checks.push(check({
    key: "balanced-vouchers", title: "Every posted voucher balances", area: "journal",
    summary: unbalanced.length ? `${unbalanced.length} effective vouchers do not balance.` : "All effective vouchers have equal debits and credits.",
  }, unbalanced.map((row) => ({
    label: `${row.number} · ${row.day}`, href: voucherHref(row.documentId), amount: money(d(row.dr).minus(row.cr)),
    note: `${row.lines} lines, Dr ${money(row.dr)} / Cr ${money(row.cr)}`,
  }))));

  /* 2. Each trade or adjustment source has exactly one effective posting, and only while the source is posted. */
  const sourceIssues = (await db.execute<{ kind: string; id: string; label: string; documentId: string | null; note: string }>(sql`
    SELECT 'invoice' AS kind,i.id,coalesce(i.number,'Unnumbered invoice') AS label,NULL::uuid AS "documentId",
      'Posted invoice has no effective journal' AS note
    FROM invoices i WHERE i.company_id=${companyId} AND i.status='posted' AND i.accounting_date<=${to}::date
      AND NOT EXISTS(SELECT 1 FROM effective_vouchers e WHERE e.company_id=i.company_id AND e.id=i.voucher_id)
    UNION ALL
    SELECT 'invoice',i.id,coalesce(i.number,'Unnumbered invoice'),e.document_id,
      'Invoice is '||i.status||' but its journal is still effective'
    FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
    WHERE i.company_id=${companyId} AND i.status<>'posted'
    UNION ALL
    SELECT 'invoice',i.id,coalesce(i.number,'Unnumbered invoice'),e.document_id,
      'An effective journal is linked to this invoice but is not its current posting'
    FROM effective_vouchers e JOIN voucher_documents s ON s.company_id=e.company_id AND s.id=e.document_id AND s.source='invoice'
    JOIN invoices i ON i.company_id=s.company_id AND i.id=s.source_id
    WHERE e.company_id=${companyId} AND i.voucher_id IS DISTINCT FROM e.id
    UNION ALL
    SELECT 'adjustment',a.id,coalesce(a.number,'Unnumbered adjustment'),e.document_id,
      'An effective journal is linked to this adjustment but is not its current posting'
    FROM effective_vouchers e JOIN voucher_documents s ON s.company_id=e.company_id AND s.id=e.document_id AND s.source='inventory_adjustment'
    JOIN inventory_adjustments a ON a.company_id=s.company_id AND a.id=s.source_id
    WHERE e.company_id=${companyId} AND a.voucher_id IS DISTINCT FROM e.id
    UNION ALL
    SELECT 'adjustment',a.id,coalesce(a.number,'Unnumbered adjustment'),NULL,'Posted adjustment has no effective journal'
    FROM inventory_adjustments a WHERE a.company_id=${companyId} AND a.status='posted' AND a.voucher_id IS NOT NULL
      AND a.accounting_date<=${to}::date
      AND NOT EXISTS(SELECT 1 FROM effective_vouchers e WHERE e.company_id=a.company_id AND e.id=a.voucher_id)
    UNION ALL
    SELECT 'voucher',e.document_id,e.number,e.document_id,'Trade-type voucher without a linked invoice (legacy or imported posting)'
    FROM effective_vouchers e WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date
      AND e.type IN ('sale','purchase','sale_return','purchase_return')
      AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.company_id=e.company_id AND i.voucher_id=e.id)
    ORDER BY 1,3`)).rows;
  const hardSource = sourceIssues.filter((row) => row.kind !== "voucher");
  checks.push(check({
    key: "single-posting", title: "No duplicate or orphaned source postings", area: "trade",
    status: hardSource.length ? "fail" : sourceIssues.length ? "review" : "pass",
    summary: hardSource.length ? `${hardSource.length} invoice or adjustment postings are duplicated, missing or still effective after a void.`
      : sourceIssues.length ? `${sourceIssues.length} trade vouchers have no invoice source. Review them; they are included in the ledger.`
        : "Each posted invoice and adjustment has exactly one effective journal.",
  }, sourceIssues.map((row) => ({
    label: row.label, note: row.note,
    href: row.kind === "invoice" ? invoiceHref(row.id) : row.kind === "adjustment" ? `${base}/trade/adjustments/${row.id}` : voucherHref(row.documentId ?? row.id),
  }))));

  /* 3. Invoice totals agree with the settlement side and, for sales, the revenue side of their journal. */
  const invoiceRows = (await db.execute<{ id: string; number: string; type: string; total: string; settlement: string; revenue: string; cogs: string; cost: string; payload: boolean }>(sql`
    WITH inv AS (
      SELECT i.* FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
      WHERE i.company_id=${companyId} AND i.status='posted' AND i.accounting_date<=${to}::date
    ), paid AS (
      SELECT inv.id,(p->>'accountId')::uuid AS account_id FROM inv
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inv.payload->'payments')='array' THEN inv.payload->'payments' ELSE '[]'::jsonb END) p
    )
    SELECT inv.id,inv.number,inv.type,inv.total::text,
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.control IN ('receivable','payable','withholding_receivable','withholding_payable')
        OR EXISTS(SELECT 1 FROM paid WHERE paid.id=inv.id AND paid.account_id=l.account_id)),0)::text AS settlement,
      coalesce(sum(l.credit-l.debit) FILTER (WHERE a.control IN ('sales','sales_returns','service_income','freight_income','output_tax')),0)::text AS revenue,
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.control='cogs'),0)::text AS cogs,
      (SELECT coalesce(sum(x.inventory_cost),0) FROM invoice_lines x JOIN inventory_items g ON g.company_id=x.company_id AND g.id=x.item_id
        WHERE x.company_id=inv.company_id AND x.invoice_id=inv.id AND x.posting_voucher_id=inv.voucher_id AND g.kind='stock')::text AS cost,
      inv.payload IS NOT NULL AS payload
    FROM inv LEFT JOIN journal_lines l ON l.company_id=inv.company_id AND l.voucher_id=inv.voucher_id
    LEFT JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    GROUP BY inv.id,inv.number,inv.type,inv.total,inv.payload,inv.company_id,inv.voucher_id,inv.accounting_date
    ORDER BY inv.accounting_date,inv.number`)).rows;
  const totalIssues: Finding[] = [];
  const cogsIssues: Finding[] = [];
  let unverifiable = 0;
  for (const row of invoiceRows) {
    const sign = row.type === "sale" || row.type === "purchase_return" ? 1 : -1;
    const settlement = d(row.settlement).times(sign);
    if (!settlement.eq(row.total)) totalIssues.push({ label: `${row.number} (${row.type.replace("_", " ")})`, href: invoiceHref(row.id),
      amount: money(settlement.minus(row.total)), note: `Invoice total ${money(row.total)}, party/payment/withholding lines ${money(settlement)}` });
    if (row.type === "sale" || row.type === "sale_return") {
      const revenue = d(row.revenue).times(row.type === "sale" ? 1 : -1);
      if (!revenue.eq(row.total)) totalIssues.push({ label: `${row.number} (${row.type.replace("_", " ")})`, href: invoiceHref(row.id),
        amount: money(revenue.minus(row.total)), note: `Invoice total ${money(row.total)}, sales/returns, service, freight and output tax lines ${money(revenue)}` });
      if (!row.payload) { unverifiable++; continue; }
      const expectedCogs = d(row.cost).times(row.type === "sale" ? 1 : -1);
      if (!d(row.cogs).eq(expectedCogs)) cogsIssues.push({ label: row.number, href: invoiceHref(row.id), amount: money(d(row.cogs).minus(expectedCogs)),
        note: `Line inventory cost ${money(expectedCogs)}, COGS posted ${money(row.cogs)}` });
    }
  }
  checks.push(check({
    key: "invoice-journal", title: "Invoices and returns post their totals correctly", area: "trade",
    summary: totalIssues.length ? `${totalIssues.length} invoice postings differ from the invoice total.`
      : `${invoiceRows.length} effective invoices and returns agree with their settlement and revenue journal lines.`,
  }, totalIssues));
  checks.push(check({
    key: "cogs", title: "Cost of goods sold matches issued inventory cost", area: "trade",
    status: cogsIssues.length ? "fail" : unverifiable ? "review" : "pass",
    summary: cogsIssues.length ? `${cogsIssues.length} sales or sale returns post COGS different from their line costs.`
      : unverifiable ? `${unverifiable} imported invoices have no recorded line costs and cannot be verified line by line.`
        : "COGS on every sale and sale return equals the recorded inventory cost.",
  }, cogsIssues));

  /* 4 & 5. Control accounts agree with the customer and supplier subledgers. */
  for (const [control, partyType, title] of [["receivable", "customer", "Accounts Receivable"], ["payable", "supplier", "Accounts Payable"]] as const) {
    const [totals] = (await db.execute<{ gl: string; subledger: string; account: string | null }>(sql`
      SELECT
        coalesce(sum(l.debit-l.credit) FILTER (WHERE a.control=${control}),0)::text AS gl,
        coalesce(sum(l.debit-l.credit) FILTER (WHERE p.type::text=${partyType}),0)::text AS subledger,
        (SELECT id::text FROM accounts WHERE company_id=${companyId} AND control=${control}) AS account
      FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
      WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date`)).rows;
    const causes = (await db.execute<{ documentId: string; number: string; day: string; amount: string; reason: string }>(sql`
      SELECT e.document_id AS "documentId",e.number,e.accounting_date::text AS day,(l.debit-l.credit)::text AS amount,
        CASE WHEN l.party_id IS NULL THEN 'Control line without a ${sql.raw(partyType)}'
          WHEN a.control=${control} THEN 'Control line tagged with a '||p.type::text
          ELSE 'A ${sql.raw(partyType)} is tagged on non-control account '||a.code||' · '||a.name END AS reason
      FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      LEFT JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
      WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date AND (
        (a.control=${control} AND (l.party_id IS NULL OR p.type::text<>${partyType}))
        OR (p.type::text=${partyType} AND a.control IS DISTINCT FROM ${control}))
      ORDER BY e.accounting_date,e.number,l.line_no`)).rows;
    const href = totals.account ? `${base}/reports/general-ledger?account=${totals.account}&from=1900-01-01&to=${to}` : undefined;
    checks.push(compare(`${control}-subledger`, `${title} reconciles with ${partyType} balances`, "subledger",
      d(totals.gl), d(totals.subledger), causes.map((row): Finding => ({
        label: `${row.number} · ${row.day}`, href: voucherHref(row.documentId), amount: money(row.amount), note: row.reason,
      })).concat(causes.length && href ? [{ label: `${title} control ledger`, href, note: "Open the control ledger" }] : []),
      `Expected is the ${title} control balance as of ${to}; actual is the sum of ${partyType} balances shown in party reports.` +
      (causes.length ? " Link unlinked lines through Legacy party voucher linking." : "")));
  }

  /* 6. Inventory control account agrees with the dated stock subledger, item by item. */
  const stock = (await db.execute<{ itemId: string | null; name: string; stock: string; gl: string }>(sql`
    WITH s AS (
      SELECT m.item_id AS k,m.item_id,sum(m.signed_value) AS value FROM stock_movements m
      JOIN effective_vouchers e ON e.company_id=m.company_id AND e.id=m.voucher_id
      WHERE m.company_id=${companyId} AND m.accounting_date<=${to}::date GROUP BY m.item_id
    ), g AS (
      SELECT coalesce(l.item_id,'00000000-0000-0000-0000-000000000000'::uuid) AS k,l.item_id,sum(l.debit-l.credit) AS value FROM effective_vouchers e
      JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.control='inventory'
      WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date GROUP BY l.item_id
    )
    SELECT coalesce(s.item_id,g.item_id) AS "itemId",coalesce(i.name,'Inventory lines without an item') AS name,
      coalesce(s.value,0)::text AS stock,coalesce(g.value,0)::text AS gl
    FROM s FULL JOIN g ON g.k=s.k
    LEFT JOIN inventory_items i ON i.company_id=${companyId} AND i.id=coalesce(s.item_id,g.item_id)
    ORDER BY name`)).rows;
  checks.push(compare("inventory", "Inventory valuation reconciles with the Inventory account", "inventory",
    stock.reduce((t, r) => t.plus(r.gl), d(0)), stock.reduce((t, r) => t.plus(r.stock), d(0)),
    stock.filter((row) => !d(row.stock).eq(row.gl)).map((row) => ({
      label: row.name, amount: money(d(row.stock).minus(row.gl)), note: `Stock ledger ${money(row.stock)}, Inventory GL ${money(row.gl)}`,
      href: row.itemId ? `${base}/reports/stock-ledger?item=${row.itemId}&from=1900-01-01&to=${to}` : `${base}/reports/inventory-valuation?to=${to}`,
    })), `Expected is the Inventory control balance as of ${to}; actual is the stock subledger value.`));

  /* 7. Report outputs agree with independent journal totals. */
  const [journal] = (await db.execute<{ dr: string; cr: string; periodDr: string; periodCr: string; profit: string }>(sql`
    SELECT coalesce(sum(l.debit),0)::text AS dr,coalesce(sum(l.credit),0)::text AS cr,
      coalesce(sum(l.debit) FILTER (WHERE e.accounting_date>=${from}::date),0)::text AS "periodDr",
      coalesce(sum(l.credit) FILTER (WHERE e.accounting_date>=${from}::date),0)::text AS "periodCr",
      coalesce(sum(l.credit-l.debit) FILTER (WHERE e.accounting_date>=${from}::date AND a.type IN ('income','expense')),0)::text AS profit
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date`)).rows;
  const filter = filters({ from, to }, "manual");
  const core = { ...filter, status: "posted" as const };

  const tb = await trialBalance(db, companyId, { ...core, mode: "" });
  const tbDr = rowValue(tb.rows, "Total", 3) ?? d(0);
  const tbCr = rowValue(tb.rows, "Total", 4) ?? d(0);
  const tbFindings: Finding[] = [];
  if (!d(journal.dr).eq(journal.cr)) tbFindings.push({ label: "Journal debits and credits differ", amount: money(d(journal.dr).minus(journal.cr)) });
  checks.push(compare("trial-balance", "Trial Balance balances", "statements", tbDr, tbCr, tbFindings,
    `Closing debit and credit columns of the Trial Balance as of ${to}. Raw journal: Dr ${money(journal.dr)}, Cr ${money(journal.cr)}.`));

  const [year] = (await db.execute<{ startsOn: string }>(sql`
    SELECT starts_on::text AS "startsOn" FROM financial_years WHERE company_id=${companyId} AND starts_on<=${to}::date AND ends_on>=${to}::date`)).rows;
  const bs = await balanceSheet(db, companyId, core, year?.startsOn);
  const bsDifference = rowValue(bs.rows, "Reconciliation difference") ?? d(0);
  checks.push(compare("balance-sheet", "Balance Sheet balances", "statements", d(0), bsDifference, [],
    `Assets minus liabilities, equity and unclosed results as of ${to}.`));

  const pl = await profitLoss(db, companyId, core);
  const plNet = rowValue(pl.rows, "Net Profit / Loss") ?? d(0);
  checks.push(compare("profit-loss", "Profit & Loss agrees with the journal", "statements", d(journal.profit), plNet, [],
    `Net result for ${from} to ${to}: expected is income minus expense recomputed from journal lines; actual is the report.`));

  const mis = await summaryReport(db, [{ id: companyId, name: "" }], { ...core, includeOpening: true }, "mis");
  const misDr = rowValue(mis.rows, "Total", 5) ?? d(0);
  const misCr = rowValue(mis.rows, "Total", 6) ?? d(0);
  checks.push(compare("mis", "Daily MIS reconciles with the General Ledger", "statements",
    d(journal.periodDr).plus(journal.periodCr), misDr.plus(misCr),
    misDr.eq(journal.periodDr) && misCr.eq(journal.periodCr) ? [] : [{
      label: "Period movement", note: `MIS Dr ${money(misDr)} / Cr ${money(misCr)}; journal Dr ${money(journal.periodDr)} / Cr ${money(journal.periodCr)}`,
      href: `${base}/reports/mis?from=${from}&to=${to}`,
    }], `Total period debits plus credits for ${from} to ${to}.`));

  /* 8. Net sales in the trade registers agree with Sales, Service and Freight Income less Sales Returns in the ledger. */
  const [sales] = (await db.execute<{ register: string; ledger: string }>(sql`
    SELECT
      (SELECT coalesce(sum(CASE WHEN i.type='sale' THEN 1 ELSE -1 END*(i.total-coalesce((i.calculation->>'tax')::numeric,0))),0)
        FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
        WHERE i.company_id=${companyId} AND i.status='posted' AND i.type IN ('sale','sale_return')
          AND i.accounting_date BETWEEN ${from}::date AND ${to}::date)::text AS register,
      (SELECT coalesce(sum(l.credit-l.debit),0) FROM effective_vouchers e
        JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
        JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
        WHERE e.company_id=${companyId} AND a.control IN ('sales','sales_returns','service_income','freight_income')
          AND e.accounting_date BETWEEN ${from}::date AND ${to}::date)::text AS ledger`)).rows;
  const salesManual = (await db.execute<{ documentId: string; number: string; amount: string }>(sql`
    SELECT e.document_id AS "documentId",e.number,sum(l.credit-l.debit)::text AS amount FROM effective_vouchers e
    JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.control IN ('sales','sales_returns','service_income','freight_income')
    WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${from}::date AND ${to}::date
      AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.company_id=e.company_id AND i.voucher_id=e.id)
    GROUP BY e.document_id,e.number ORDER BY e.number`)).rows;
  checks.push(compare("net-sales", "Net sales agree with sales and return invoices", "trade", d(sales.register), d(sales.ledger),
    salesManual.map((row) => ({ label: row.number, href: voucherHref(row.documentId), amount: money(row.amount), note: "Sales posting not created by an invoice" })),
    `Expected is invoice net sales (sales minus returns, before tax) for ${from} to ${to}; actual is the Sales, Service Income and Freight Income less Sales Returns ledger movement.`));

  /* 9. Payment allocations point at effective payments and posted invoices and never exceed the invoice. */
  const allocationIssues = (await db.execute<{ invoiceId: string; number: string | null; note: string; amount: string }>(sql`
    SELECT x.invoice_id AS "invoiceId",i.number,'Active allocation uses a payment line that is no longer effective' AS note,x.amount::text
    FROM payment_allocations x JOIN invoices i ON i.company_id=x.company_id AND i.id=x.invoice_id
    JOIN journal_lines l ON l.company_id=x.company_id AND l.id=x.payment_line_id
    WHERE x.company_id=${companyId} AND x.ended_on IS NULL
      AND NOT EXISTS(SELECT 1 FROM effective_vouchers e WHERE e.company_id=l.company_id AND e.id=l.voucher_id)
    UNION ALL
    SELECT x.invoice_id,i.number,'Active allocation to an invoice that is not posted',x.amount::text
    FROM payment_allocations x JOIN invoices i ON i.company_id=x.company_id AND i.id=x.invoice_id
    WHERE x.company_id=${companyId} AND x.ended_on IS NULL AND i.status<>'posted'
    UNION ALL
    SELECT i.id,i.number,'Allocations exceed the invoice amount due from the party',(sum(x.amount)-coalesce(i.party_amount,i.total))::text
    FROM payment_allocations x JOIN invoices i ON i.company_id=x.company_id AND i.id=x.invoice_id
    WHERE x.company_id=${companyId} AND x.ended_on IS NULL
    GROUP BY i.id,i.number,i.party_amount,i.total HAVING sum(x.amount)>coalesce(i.party_amount,i.total)`)).rows;
  checks.push(check({
    key: "allocations", title: "Payment allocations are valid", area: "subledger",
    summary: allocationIssues.length ? `${allocationIssues.length} active allocations need review.` : "All active allocations link effective payments to posted invoices within their amount.",
  }, allocationIssues.map((row) => ({ label: row.number ?? "Invoice", href: invoiceHref(row.invoiceId), amount: money(row.amount), note: row.note }))));

  /* 10. Postings sit inside the period and year they reference. */
  const periodIssues = (await db.execute<{ documentId: string; number: string; day: string; note: string }>(sql`
    SELECT e.document_id AS "documentId",e.number,e.accounting_date::text AS day,
      'Dated outside its accounting period '||p.starts_on::text||' to '||p.ends_on::text AS note
    FROM effective_vouchers e JOIN accounting_periods p ON p.company_id=e.company_id AND p.id=e.period_id
    WHERE e.company_id=${companyId} AND (e.accounting_date<p.starts_on OR e.accounting_date>p.ends_on)
    ORDER BY e.accounting_date`)).rows;
  checks.push(check({
    key: "periods", title: "Postings fall inside their accounting periods", area: "journal",
    summary: periodIssues.length ? `${periodIssues.length} vouchers are dated outside the period they were posted to.` : "Every effective voucher is dated inside its period.",
  }, periodIssues.map((row) => ({ label: `${row.number} · ${row.day}`, href: voucherHref(row.documentId), note: row.note }))));

  return { companyId, from, to, generatedAt: new Date().toISOString(), checks };
}
