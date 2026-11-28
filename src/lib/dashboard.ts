import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type Transaction } from "@/db";
import { Exact } from "@/lib/engine/model";
import { invoiceOutstanding } from "@/lib/engine/settlement";

/*
 * Dashboard figures. Everything is computed from effective (posted, current) journal lines, stock movements and invoices
 * in one repeatable-read snapshot, so the cards, chart and lists on one screen always agree with each other and with the
 * reports. No figure is estimated or decorative.
 */

type Decimal = InstanceType<typeof Exact>;
const d = (value: string | number | null | undefined) => new Exact(value ?? 0);
const money = (value: Decimal) => value.toFixed(2);

export type MonthPoint = { month: string; label: string; sales: string; purchases: string; expenses: string; profit: string };
export type Overview = Awaited<ReturnType<typeof loadOverview>>;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
function addMonths(day: string, months: number) {
  const [y, m] = day.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1 + months, 1)));
}
const monthLabel = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

/** Percentage change, or null when the base is zero (a change from nothing has no meaningful percentage). */
function change(current: Decimal, previous: Decimal) {
  if (previous.isZero()) return null;
  return current.minus(previous).div(previous.abs()).times(100).toDecimalPlaces(1).toNumber();
}

async function balances(tx: Transaction, companyId: string, asOf: string) {
  const [row] = (await tx.execute<{ cash: string; receivable: string; payable: string; stock: string }>(sql`
    SELECT
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.liquidity IS NOT NULL),0)::text AS cash,
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.control='receivable'),0)::text AS receivable,
      coalesce(sum(l.credit-l.debit) FILTER (WHERE a.control='payable'),0)::text AS payable,
      (SELECT coalesce(sum(m.signed_value),0) FROM stock_movements m JOIN effective_vouchers s ON s.company_id=m.company_id AND s.id=m.voucher_id
        WHERE m.company_id=${companyId} AND m.accounting_date<=${asOf}::date)::text AS stock
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    WHERE e.company_id=${companyId} AND e.accounting_date<=${asOf}::date`)).rows;
  return row;
}

async function results(tx: Transaction, companyId: string, from: string, to: string) {
  const [row] = (await tx.execute<{ sales: string; cogs: string; income: string; expense: string }>(sql`
    SELECT
      coalesce(sum(l.credit-l.debit) FILTER (WHERE a.control IN ('sales','sales_returns')),0)::text AS sales,
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.control='cogs'),0)::text AS cogs,
      coalesce(sum(l.credit-l.debit) FILTER (WHERE a.type='income'),0)::text AS income,
      coalesce(sum(l.debit-l.credit) FILTER (WHERE a.type='expense'),0)::text AS expense
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${from}::date AND ${to}::date`)).rows;
  return row;
}

/** Money received from customers: receivable credits on vouchers that also debit a cash or bank account. */
async function collections(tx: Transaction, companyId: string, from: string, to: string) {
  const [row] = (await tx.execute<{ amount: string; clients: string }>(sql`
    SELECT coalesce(sum(l.credit),0)::text AS amount,count(DISTINCT l.party_id)::text AS clients
    FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
    JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
    WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${from}::date AND ${to}::date AND a.control='receivable' AND l.credit>0
      AND EXISTS(SELECT 1 FROM journal_lines c JOIN accounts ca ON ca.company_id=c.company_id AND ca.id=c.account_id
        WHERE c.company_id=e.company_id AND c.voucher_id=e.id AND ca.liquidity IS NOT NULL AND c.debit>0)`)).rows;
  return row;
}

export type OverviewOptions = { today: string; calendar?: string; recent: number; todayOnly: boolean };

export async function loadOverview(companyId: string, range: { from: string; to: string }, months: number, options: OverviewOptions) {
  return getDb().transaction(async (tx) => {
    const { from, to } = range;
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    const previousTo = addDays(from, -1);
    const previousFrom = addDays(previousTo, -(span - 1));

    const { today } = options;
    const [now, before, current, prior, collectedToday, collectedMonth, monthOpening] = await Promise.all([
      balances(tx, companyId, to), balances(tx, companyId, previousTo),
      results(tx, companyId, from, to), results(tx, companyId, previousFrom, previousTo),
      collections(tx, companyId, today, today), collections(tx, companyId, monthStart(today), today),
      balances(tx, companyId, addDays(monthStart(today), -1)),
    ]);
    const netSales = d(current.sales);
    const grossProfit = netSales.minus(current.cogs);
    const netProfit = d(current.income).minus(current.expense);

    // Monthly series ending with the month of the "to" date.
    const firstMonth = addMonths(monthStart(to), -(months - 1));
    const series = (await tx.execute<{ month: string; sales: string; purchases: string; expenses: string; profit: string }>(sql`
      WITH m AS (SELECT generate_series(${firstMonth}::date, ${monthStart(to)}::date, interval '1 month')::date AS month),
      j AS (
        SELECT date_trunc('month',e.accounting_date)::date AS month,
          sum(l.credit-l.debit) FILTER (WHERE a.control IN ('sales','sales_returns')) AS sales,
          sum(l.debit-l.credit) FILTER (WHERE a.type='expense' AND a.control IS DISTINCT FROM 'cogs') AS expenses,
          sum(CASE WHEN a.type='income' THEN l.credit-l.debit WHEN a.type='expense' THEN l.credit-l.debit ELSE 0 END) AS profit
        FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
        JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
        WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${firstMonth}::date AND ${to}::date
        GROUP BY 1
      ),
      p AS (
        SELECT date_trunc('month',i.accounting_date)::date AS month,
          sum(CASE WHEN i.type='purchase' THEN 1 ELSE -1 END*(i.total-coalesce((i.calculation->>'tax')::numeric,0))) AS purchases
        FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
        WHERE i.company_id=${companyId} AND i.status='posted' AND i.type IN ('purchase','purchase_return')
          AND i.accounting_date BETWEEN ${firstMonth}::date AND ${to}::date
        GROUP BY 1
      )
      SELECT m.month::text AS month,coalesce(j.sales,0)::text AS sales,coalesce(p.purchases,0)::text AS purchases,
        coalesce(j.expenses,0)::text AS expenses,coalesce(j.profit,0)::text AS profit
      FROM m LEFT JOIN j ON j.month=m.month LEFT JOIN p ON p.month=m.month ORDER BY m.month`)).rows;
    const monthly: MonthPoint[] = series.map((row) => ({ ...row, label: monthLabel(row.month),
      sales: money(d(row.sales)), purchases: money(d(row.purchases)), expenses: money(d(row.expenses)), profit: money(d(row.profit)) }));

    // Month-end cash balances for the cash card's mini chart (last six months).
    const cashTrend = (await tx.execute<{ month: string; balance: string }>(sql`
      SELECT m.month::text AS month,(SELECT coalesce(sum(l.debit-l.credit),0) FROM effective_vouchers e
        JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
        JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
        WHERE e.company_id=${companyId} AND a.liquidity IS NOT NULL
          AND e.accounting_date<=least((m.month+interval '1 month'-interval '1 day')::date,${to}::date))::text AS balance
      FROM generate_series(${addMonths(monthStart(to), -5)}::date, ${monthStart(to)}::date, interval '1 month') AS m(month)
      ORDER BY m.month`)).rows;

    const counts = (await tx.execute<{ vouchers: string; invoices: string; customers: string; suppliers: string }>(sql`
      SELECT
        (SELECT count(*) FROM effective_vouchers e WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${from}::date AND ${to}::date)::text AS vouchers,
        (SELECT count(*) FROM invoices i JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
          WHERE i.company_id=${companyId} AND i.status='posted' AND i.accounting_date BETWEEN ${from}::date AND ${to}::date)::text AS invoices,
        (SELECT count(*) FROM (SELECT l.party_id FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
          JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
          WHERE e.company_id=${companyId} AND p.type='customer' AND e.accounting_date<=${to}::date GROUP BY l.party_id HAVING sum(l.debit-l.credit)>0) x)::text AS customers,
        (SELECT count(*) FROM (SELECT l.party_id FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
          JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
          WHERE e.company_id=${companyId} AND p.type='supplier' AND e.accounting_date<=${to}::date GROUP BY l.party_id HAVING sum(l.credit-l.debit)>0) x)::text AS suppliers`)).rows[0];

    // Calendar: postings per day in the chosen month, by default the month of the "to" date.
    const calendarMonth = options.calendar ?? monthStart(to);
    const days = (await tx.execute<{ day: string; count: string }>(sql`
      SELECT e.accounting_date::text AS day,count(*)::text AS count FROM effective_vouchers e
      WHERE e.company_id=${companyId} AND e.accounting_date BETWEEN ${calendarMonth}::date AND ${addDays(addMonths(calendarMonth, 1), -1)}::date
      GROUP BY 1`)).rows;

    // Latest postings with the first party on each voucher, for the recent activity table.
    const recentRows = (await tx.execute<{ id: string; number: string; day: string; type: string; narration: string; reference: string;
      created: string; amount: string; party: string | null }>(sql`
      SELECT e.document_id AS id,e.number,e.accounting_date::text AS day,e.type::text AS type,e.narration,e.reference,
        to_char(e.created_at AT TIME ZONE 'Asia/Karachi','HH12:MI AM') AS created,
        (SELECT coalesce(sum(l.debit),0) FROM journal_lines l WHERE l.company_id=e.company_id AND l.voucher_id=e.id)::text AS amount,
        (SELECT p.name FROM journal_lines l JOIN parties p ON p.company_id=l.company_id AND p.id=l.party_id
          WHERE l.company_id=e.company_id AND l.voucher_id=e.id ORDER BY l.line_no LIMIT 1) AS party
      FROM effective_vouchers e WHERE e.company_id=${companyId} AND e.accounting_date<=${to}::date
        AND (${options.todayOnly}::boolean IS FALSE OR e.accounting_date=${today}::date)
      ORDER BY e.accounting_date DESC,e.created_at DESC,e.document_id DESC LIMIT ${options.recent + 1}`)).rows;
    const recent = recentRows.slice(0, options.recent);

    // Receivables aging from the same allocation-based logic as the Invoice Aging report.
    const open = (await invoiceOutstanding(tx, companyId, to)).filter((row) => row.type === "sale" && d(row.outstanding).gt(0));
    const bands = [
      { key: "current", label: "Current", test: (days: number) => days === 0 },
      { key: "30", label: "1–30 days", test: (days: number) => days > 0 && days <= 30 },
      { key: "60", label: "31–60 days", test: (days: number) => days > 30 && days <= 60 },
      { key: "90", label: "61–90 days", test: (days: number) => days > 60 && days <= 90 },
      { key: "over", label: "Over 90 days", test: (days: number) => days > 90 },
    ];
    const aging = bands.map((band) => ({ key: band.key, label: band.label,
      amount: money(open.filter((row) => band.test(row.overdueDays)).reduce((total, row) => total.plus(row.outstanding), d(0))),
      count: open.filter((row) => band.test(row.overdueDays)).length }));
    const overdue = open.filter((row) => row.overdueDays > 0);

    const [attention] = (await tx.execute<{ drafts: string; submitted: string; draftInvoices: string; unlinked: string; openPeriod: boolean; year: boolean }>(sql`
      SELECT
        (SELECT count(*) FROM voucher_documents WHERE company_id=${companyId} AND status='draft' AND submitted_by IS NULL)::text AS drafts,
        (SELECT count(*) FROM voucher_documents WHERE company_id=${companyId} AND status='draft' AND submitted_by IS NOT NULL)::text AS submitted,
        (SELECT count(*) FROM invoices WHERE company_id=${companyId} AND status='draft')::text AS "draftInvoices",
        (SELECT count(*) FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
          JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
          WHERE e.company_id=${companyId} AND a.control IN ('receivable','payable') AND l.party_id IS NULL)::text AS unlinked,
        EXISTS(SELECT 1 FROM accounting_periods p JOIN financial_years y ON y.company_id=p.company_id AND y.id=p.year_id
          WHERE p.company_id=${companyId} AND NOT p.closed AND NOT y.closed AND current_date BETWEEN p.starts_on AND p.ends_on) AS "openPeriod",
        EXISTS(SELECT 1 FROM financial_years WHERE company_id=${companyId}) AS year`)).rows;

    return {
      range, previous: { from: previousFrom, to: previousTo },
      cash: { value: money(d(now.cash)), change: change(d(now.cash), d(before.cash)), trend: cashTrend.map((row) => ({ month: row.month, label: monthLabel(row.month), value: money(d(row.balance)) })) },
      receivable: { value: money(d(now.receivable)), previous: money(d(before.receivable)), change: change(d(now.receivable), d(before.receivable)), customers: Number(counts.customers) },
      payable: { value: money(d(now.payable)), change: change(d(now.payable), d(before.payable)), suppliers: Number(counts.suppliers) },
      stock: { value: money(d(now.stock)), change: change(d(now.stock), d(before.stock)) },
      sales: { value: money(netSales), change: change(netSales, d(prior.sales)) },
      grossProfit: money(grossProfit), netProfit: money(netProfit),
      margin: netSales.gt(0) ? grossProfit.div(netSales).times(100).toDecimalPlaces(1).toNumber() : null,
      counts: { vouchers: Number(counts.vouchers), invoices: Number(counts.invoices) },
      monthly, calendar: { month: calendarMonth, days: Object.fromEntries(days.map((row) => [row.day, Number(row.count)])) },
      recent: recent.map((row) => ({ ...row, amount: money(d(row.amount)) })), moreRecent: recentRows.length > options.recent,
      collections: { today: money(d(collectedToday.amount)), clients: Number(collectedToday.clients), month: money(d(collectedMonth.amount)),
        owedAtMonthStart: money(d(monthOpening.receivable)),
        rate: d(monthOpening.receivable).gt(0) ? Math.min(100, d(collectedMonth.amount).div(monthOpening.receivable).times(100).toDecimalPlaces(0).toNumber()) : null },
      aging, overdue: { count: overdue.length, amount: money(overdue.reduce((total, row) => total.plus(row.outstanding), d(0))) },
      attention: { drafts: Number(attention.drafts), submitted: Number(attention.submitted), draftInvoices: Number(attention.draftInvoices),
        unlinked: Number(attention.unlinked), openPeriod: attention.openPeriod, year: attention.year },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
