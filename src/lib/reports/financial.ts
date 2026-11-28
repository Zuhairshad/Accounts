import { sql } from "drizzle-orm";
import { Exact } from "@/lib/engine/model";
import { displayDate } from "@/lib/validation";
import { lineTypeLabel } from "@/lib/trade/model";
import { detail, effective, inactiveDetail, movements, type AccountMovement, type Reader } from "./journal";
import { dateCell, moneyCell, sum, textCell, type Cell, type ReportDocument, type ReportFilter, type ReportRow } from "./model";

type Decimal = InstanceType<typeof Exact>;
type Named = { id: string; name: string };
type Parts = Pick<ReportDocument, "columns" | "rows" | "notes" | "warning">;
const zero = () => new Exact(0);
const signed = (dr: string, cr: string) => new Exact(dr).minus(cr);
const opening = (r: AccountMovement) => signed(r.openingDr,r.openingCr);
const period = (r: AccountMovement) => signed(r.periodDr,r.periodCr);
const closing = (r: AccountMovement) => opening(r).plus(period(r));

function debitCredit(value: Decimal, href?: string): Cell[] {
  return [moneyCell(Exact.max(value,0),href),moneyCell(Exact.max(value.negated(),0),href)];
}
const moneyColumns = ["Opening Dr","Opening Cr","Period Dr","Period Cr","Closing Dr","Closing Cr"];

function link(company: string, report: string, filter: ReportFilter, fields: Record<string,string>) {
  const query = new URLSearchParams({
    from: filter.from, to: filter.to, ...(filter.recordedAt ? { recordedAt: filter.recordedAt } : {}), ...fields,
  });
  return `/workspace/${company}/reports/${report}?${query}`;
}

const previousDay = (date: string) => new Date(new Date(`${date}T00:00:00.000Z`).getTime()-86400000).toISOString().slice(0,10);
function reportLinks(row: AccountMovement, f: ReportFilter) {
  const params = {
    account: row.id, mode: "vouchers",
    ...(f.voucher ? { voucher: f.voucher } : {}), ...(f.invoice ? { invoice: f.invoice } : {}),
    ...(f.party ? { party: f.party } : {}), ...(f.voucherType ? { voucherType: f.voucherType } : {}),
    ...(f.search ? { q: f.search } : {}),
  };
  return {
    opening: f.from > "1900-01-01" ? link(row.companyId,"mis",f,{ ...params, from:"1900-01-01", to:previousDay(f.from) }) : undefined,
    period: link(row.companyId,"mis",f,params),
    closing: link(row.companyId,"mis",f,{ ...params, from:"1900-01-01" }),
  };
}

function six(row: AccountMovement, f: ReportFilter, withLinks = true) {
  const links = withLinks ? reportLinks(row,f) : undefined;
  return [...debitCredit(opening(row),links?.opening),moneyCell(row.periodDr,links?.period),
    moneyCell(row.periodCr,links?.period),...debitCredit(closing(row),links?.closing)];
}
function totals(rows: AccountMovement[]) {
  return moneyColumns.map((_, index) => moneyCell(sum(rows,(r) => six(r, {} as ReportFilter, false)[index].value)));
}
function nonzero(row: AccountMovement, includeOpening: boolean) {
  return !new Exact(row.periodDr).isZero() || !new Exact(row.periodCr).isZero() || includeOpening && !opening(row).isZero();
}

export const accountTypes = ["asset","liability","equity","income","expense"] as const;
export const typeName = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/** Each company lists its account types once, as collapsible headings carrying the type subtotal, with the accounts beneath. */
export function companyWise(names: Named[], source: AccountMovement[], f: ReportFilter): Parts {
  const columns = ["Account Code","Account Type","Account Head",...moneyColumns];
  const rows = names.flatMap((name): ReportRow[] => {
    const part = source.filter((row) => row.companyId === name.id);
    const groups = accountTypes.flatMap((type): ReportRow[] => {
      const accounts = part.filter((row) => row.type === type);
      if (!accounts.length) return [];
      const key = `${name.id}-${type}`;
      return [{ key,style:"group",toggle:key,cells:[textCell(""),textCell(typeName(type)),textCell(""),...totals(accounts)] },
        ...accounts.map((row): ReportRow => ({ key:row.id,parent:key,
          cells:[textCell(row.code),textCell(""),textCell(row.name,reportLinks(row,f).period),...six(row,f)] }))];
    });
    return [{ key:name.id,style:"section",cells:[textCell(""),textCell(name.name),textCell("")] },...groups,
      { key:`${name.id}-total`,style:"total",cells:[textCell(""),textCell(`${name.name} subtotal`),textCell(""),...totals(part)] }];
  }).concat({ key:"grand",style:"total",cells:[textCell(""),textCell("Overall total"),textCell(""),...totals(source)] });
  return { columns, rows, notes:[
    "Each account type appears once per company with its subtotal. Select a type on screen to collapse or expand its accounts.",
    "This aggregate includes the authorized companies shown above. Intercompany entries remain in the totals.",
  ] };
}

export async function summaryReport(db: Reader, names: Named[], f: ReportFilter, mode: "mis" | "company-wise" | "combined-heads") : Promise<Parts> {
  const source = (await movements(db,names.map((n) => n.id),f)).filter((row) => nonzero(row,f.includeOpening));
  const columns = ["Account Code","Account Head","Account Type",...moneyColumns];
  const rowFor = (row: AccountMovement): ReportRow => ({
    key: row.id, cells: [textCell(row.code),textCell(row.name,reportLinks(row,f).period),textCell(row.type),...six(row,f)],
  });
  if (mode === "mis") return { columns, rows: source.length ? [...source.map(rowFor),{ key:"total",style:"total",cells:[textCell("Total"),textCell(""),textCell(""),...totals(source)] }] : [], notes: [
    "Opening and closing are net account balances shown on their debit or credit side. Period columns show posted movements.",
  ] };
  if (mode === "company-wise") return companyWise(names,source,f);
  const groups = new Map<string, AccountMovement[]>();
  for (const row of source) {
    const key = row.group ? `mapping:${row.group}:${row.type}` : row.control ? `system:${row.control}:${row.type}` : `unmapped:${row.companyId}:${row.id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key,group);
  }
  const rows: ReportRow[] = [];
  const combinedRows: AccountMovement[] = [];
  const sorted = [...groups.entries()].sort((a,b) => (a[1][0].label || a[1][0].name).localeCompare(b[1][0].label || b[1][0].name) || a[0].localeCompare(b[0]));
  for (const [key, accounts] of sorted) {
    const first = accounts[0];
    const combined = { ...first, openingDr:sum(accounts,(r)=>r.openingDr).toFixed(2),openingCr:sum(accounts,(r)=>r.openingCr).toFixed(2),
      periodDr:sum(accounts,(r)=>r.periodDr).toFixed(2),periodCr:sum(accounts,(r)=>r.periodCr).toFixed(2) };
    combinedRows.push(combined);
    rows.push({ key,style:"section",cells:[textCell(first.group || first.control || first.code),textCell(first.label || first.name),textCell(first.type),...six(combined,f,false)] });
    rows.push(...accounts.map((account) => {
      const row = rowFor(account);
      row.cells[1] = textCell(`${names.find((n)=>n.id===account.companyId)?.name} · ${account.name}`,reportLinks(account,f).period);
      return row;
    }));
  }
  if (source.length) rows.push({ key:"grand",style:"total",cells:[textCell(""),textCell("Overall total"),textCell(""),...totals(combinedRows)] });
  return { columns, rows, notes:["Permanent system accounts and matching explicit mappings aggregate by classification. Unmapped accounts remain company-specific. Intercompany entries remain in the totals."] };
}

export async function trialBalance(db: Reader, id: string, f: ReportFilter): Promise<Parts> {
  const data = (await movements(db,[id],f)).filter((row) => nonzero(row,true));
  const movement = f.mode === "movement";
  const balance = (row: AccountMovement) => movement ? [moneyCell(row.periodDr,reportLinks(row,f).period),moneyCell(row.periodCr,reportLinks(row,f).period)]
    : debitCredit(closing(row),reportLinks(row,f).closing);
  const dr = sum(data,(row)=>balance(row)[0].value);
  const cr = sum(data,(row)=>balance(row)[1].value);
  return { columns:["Account Code","Account Head","Type",movement ? "Period Dr" : "Closing Dr",movement ? "Period Cr" : "Closing Cr"],
    rows:[...data.map((row)=>({ key:row.id,cells:[textCell(row.code),textCell(row.name),textCell(row.type),...balance(row)] })),
      { key:"total",style:"total",cells:[textCell("Total"),textCell(""),textCell(""),moneyCell(dr),moneyCell(cr)] }],
    notes:[], warning:dr.eq(cr) ? undefined : `Trial balance difference PKR ${dr.minus(cr).toFixed(2)}. Review the contributing journal lines.` };
}

function incomeGroups() {
  return new Map<string, AccountMovement[]>([
    ["Gross Sales",[]],["Less: Sales Returns",[]],["Cost of Goods Sold",[]],["Other Income",[]],["Operating Expenses",[]],["Other Expenses",[]],
  ]);
}
function profitClass(row: AccountMovement) {
  if (["sales","service_income","freight_income"].includes(row.control ?? "")) return "Gross Sales";
  if (row.control==="sales_returns") return "Less: Sales Returns";
  if (row.control==="cogs") return "Cost of Goods Sold";
  if (row.type==="income") return "Other Income";
  return row.otherExpense || ["inventory_loss","purchase_return_variance"].includes(row.control ?? "") ? "Other Expenses" : "Operating Expenses";
}
const profitAmount = (section: string, amount: Decimal) => ["Gross Sales","Other Income"].includes(section) ? amount.negated() : amount;
function resultRow(key: string,value: Decimal, style: ReportRow["style"]="total"): ReportRow {
  return { key,style,cells:[textCell(key),textCell(""),moneyCell(value)] };
}

export async function profitLoss(db: Reader, id: string, f: ReportFilter): Promise<Parts> {
  const data = await movements(db,[id],f);
  const sections = incomeGroups();
  for (const row of data) if (["income","expense"].includes(row.type) && nonzero(row,false)) sections.get(profitClass(row))!.push(row);
  const amounts = new Map<string, Decimal>();
  const rows: ReportRow[] = [];
  for (const [section, records] of sections) {
    const value = sum(records,(row)=>profitAmount(section,period(row)));
    amounts.set(section,value);
    rows.push(resultRow(section,value,"section"),...records.map((row)=>({ key:row.id,cells:[textCell(row.code),textCell(row.name),
      moneyCell(profitAmount(section,period(row)),reportLinks(row,f).period)] })));
    if (section==="Less: Sales Returns") rows.push(resultRow("Net Sales", amounts.get("Gross Sales")!.minus(value)));
    if (section==="Cost of Goods Sold") rows.push(resultRow("Gross Profit / Loss",amounts.get("Gross Sales")!.minus(amounts.get("Less: Sales Returns")!).minus(value)));
  }
  const net = amounts.get("Gross Sales")!.minus(amounts.get("Less: Sales Returns")!).minus(amounts.get("Cost of Goods Sold")!)
    .plus(amounts.get("Other Income")!).minus(amounts.get("Operating Expenses")!).minus(amounts.get("Other Expenses")!);
  rows.push(resultRow("Net Profit / Loss",net));
  return { columns:["Section or account code","Account head","Amount (PKR)"],rows,
    notes:["Income and all expense movements use the selected accounting dates. Each income and expense account belongs to one section."] };
}

export async function balanceSheet(db: Reader, id: string, f: ReportFilter, yearStart?: string): Promise<Parts> {
  const fiscal = { ...f, from:yearStart ?? "1900-01-01" };
  const data = await movements(db,[id],fiscal);
  const assets = sum(data.filter((row)=>row.type==="asset"),closing);
  const liabilities = sum(data.filter((row)=>row.type==="liability"),(row)=>closing(row).negated());
  const equity = sum(data.filter((row)=>row.type==="equity"),(row)=>closing(row).negated());
  const nominal = data.filter((row)=>["income","expense"].includes(row.type));
  const earlier = sum(nominal,(row)=>opening(row).negated());
  const profit = sum(nominal,(row)=>period(row).negated());
  const totalEquity = equity.plus(earlier).plus(profit);
  const difference = assets.minus(liabilities).minus(totalEquity);
  const rows: ReportRow[] = [];
  for (const [type,label,total] of [["asset","Assets",assets],["liability","Liabilities",liabilities],["equity","Equity",totalEquity]] as const) {
    rows.push(resultRow(label,total,"section"), ...data.filter((row)=>row.type===type && !closing(row).isZero()).map((row)=>({
      key:row.id,cells:[textCell(row.code),textCell(row.name),moneyCell(closing(row).times(type==="asset" ? 1 : -1),reportLinks(row,fiscal).closing)],
    })));
    if (type==="equity") {
      rows.push({ key:"earlier",cells:[textCell("Previously unclosed earnings"),textCell(""),moneyCell(earlier,yearStart && yearStart>"1900-01-01" ? link(id,"profit-loss",f,{from:"1900-01-01",to:previousDay(yearStart)}) : undefined)] });
      rows.push({ key:"current",cells:[textCell(yearStart ? "Current financial-year profit / loss" : "Unclosed profit / loss"),textCell(""),
        moneyCell(profit,link(id,"profit-loss",f,{from:fiscal.from}))] });
    }
  }
  rows.push(resultRow("Liabilities + equity",liabilities.plus(totalEquity)),resultRow("Reconciliation difference",difference,difference.isZero() ? "total" : "warning"));
  return { columns:["Section or account code","Account head","Amount (PKR)"],rows,
    notes:[yearStart ? `Current-year results start ${displayDate(yearStart)}. Posted retained earnings remain in equity. Only nominal balances still open are added.`
      : "No financial year covers this date. All unclosed income and expense balances are shown together."],
    warning:difference.isZero() ? undefined : `Assets and liabilities plus equity differ by PKR ${difference.toFixed(2)}. Open the account drill-down or Trial Balance to diagnose the difference.` };
}

export async function journalDetail(db: Reader,names: Named[],f: ReportFilter,mode: "mis" | "general-ledger" | "party-ledger" | "cash-bank"):Promise<Parts> {
  const all = names.map((name)=>name.id);
  const party = mode==="party-ledger";
  // Voucher Number Wise Detail also shows whether invoice lines were Product, Services or Freight / Transportation.
  const typed = mode==="mis";
  const pad = typed ? 1 : 0;
  const columns = ["Date","Voucher Number","Voucher Type","Linked Invoice Number",...(typed ? ["Invoice Line Type"] : []),
    "Account Head","Customer / Supplier","Description / Narration","Debit","Credit","Running balance","Status"];
  if (party && !f.party || mode==="general-ledger" && !f.account) return {columns,rows:[],notes:["Choose an account or party to view its ledger."]};
  const posted = ["posted","all"].includes(f.status) ? await detail(db,all,f,mode==="cash-bank",party) : [];
  const history = f.status!=="posted" ? await inactiveDetail(db,all,f) : [];
  const source = [...posted,...history].sort((a,b)=>a.day.localeCompare(b.day));
  const rows: ReportRow[] = source.map((r)=>({
    key:r.id,group:r.documentId,cells:[dateCell(r.day),textCell(r.number,`/workspace/${r.companyId}/accounting/vouchers/${r.documentId}`),
      textCell(r.type),textCell(r.invoice),...(typed ? [textCell(lineTypeLabel(r.lineType))] : []),textCell(r.account),textCell(r.party),textCell(r.narration),moneyCell(r.debit),moneyCell(r.credit),
      r.status==="posted" ? moneyCell(party ? r.partyRunning : r.running) : textCell(""),textCell(r.status)],
  }));
  const notes = ["Running balances use all effective postings for the account or party, including activity omitted by display filters."];
  if (f.status!=="posted") notes.push("Draft and voided rows are audit information and excluded from official totals.");
  if (party && f.party && f.status==="posted") {
    const amounts=await db.execute<{opening:string;closing:string}>(sql`
      WITH e AS (${effective(all,f.recordedAt)})
      SELECT coalesce(sum(l.debit-l.credit) FILTER (WHERE e.accounting_date<${f.from}::date),0)::text AS opening,
        coalesce(sum(l.debit-l.credit),0)::text AS closing FROM e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      WHERE l.party_id=${f.party} AND e.accounting_date<=${f.to}::date
    `);
    rows.unshift({key:"opening",style:"section",cells:[textCell("Opening balance"),...Array<Cell>(8+pad).fill(textCell("")),moneyCell(amounts.rows[0].opening)]});
    rows.push({key:"closing",style:"section",cells:[textCell("Closing balance"),...Array<Cell>(8+pad).fill(textCell("")),moneyCell(amounts.rows[0].closing)]});
  } else if (f.account && f.status==="posted") {
    const [selected] = await movements(db,all,{ ...f, party:undefined,voucher:undefined,invoice:undefined,voucherType:undefined,search:"" });
    if (selected) {
      rows.unshift({ key:"opening",style:"section",cells:[textCell("Opening balance"),...Array<Cell>(8+pad).fill(textCell("")),moneyCell(opening(selected))] });
      rows.push({ key:"closing",style:"section",cells:[textCell("Closing balance"),...Array<Cell>(8+pad).fill(textCell("")),moneyCell(closing(selected))] });
    }
  }
  if (posted.length) rows.push({key:"total",style:"total",cells:[textCell("Period totals"),...Array<Cell>(6+pad).fill(textCell("")),
    moneyCell(sum(posted,(row)=>row.debit)),moneyCell(sum(posted,(row)=>row.credit))]});
  return {columns,rows,notes};
}
