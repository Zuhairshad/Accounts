import { sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FilePlus2, Printer } from "lucide-react";
import { z } from "zod";
import { getDb } from "@/db";
import { first, resolveRange, type Query } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";
import { formatMoney } from "@/lib/display";
import { Exact } from "@/lib/engine/model";
import type { Permission } from "@/lib/permissions";
import { FinanceForm } from "@/components/accounting/finance-form";
import { DateFilters, Money, PageHeading, PanelTable } from "@/components/accounting/finance-ui";
import { Button } from "@/components/ui/button";
import { lifecycleAction, tradeSettingsAction } from "@/lib/trade/actions";
import {
  adjustmentDetail, inventorySummary, invoiceDetail, invoiceRegister, readItem, registerLines, returnedQuantities, stockLedger, tradeHistory, tradeOptions,
} from "@/lib/trade/read";
import {
  adjustmentNames, invoiceSchema, isReturn, isSale, lineTypeNames, tradeNames, tradeType, tradeTypes, type AdjustmentCalculation,
  type InvoiceCalculation, type InvoiceInput, type TradeType,
} from "@/lib/trade/model";
import { InvoiceEditor, ItemFields } from "./editor";
import { AdjustmentEditor } from "./adjustment";

export type TradeScreen = { companyId: string; company: string; base: string; accounting: string; permissions: Permission[]; query: Query };
const permission = (screen: TradeScreen, value: Permission) => screen.permissions.includes(value);
export const quantityLabel = (value: string) => new Exact(value).toString();

function toolbarLink(url: string, text: string, primary = false) {
  return <Button asChild variant={primary ? "primary" : "outline"}><a href={url}>{primary && <FilePlus2 size={16} />}{text}</a></Button>;
}

export async function TradeRegister(screen: TradeScreen) {
  const { companyId, company, base, accounting, query } = screen;
  const db = getDb();
  const range = resolveRange(query);
  const kind = tradeType.safeParse(first(query.type));
  const status = first(query.status);
  const search = (first(query.q) ?? "").trim().slice(0,100);
  const page = Math.min(10000, Math.max(1, Number.parseInt(first(query.page) ?? "1", 10) || 1));
  const rows = await invoiceRegister(db, companyId, { ...range, type: kind.success ? kind.data : undefined, status, q: search, offset: (page - 1) * 40 });
  const lines = await registerLines(db, companyId, rows.map((row) => row.id));
  const pageLink = (to: number) => `${base}/invoices?${new URLSearchParams({
    type: kind.success ? kind.data : "", status: status ?? "", from: range.from, to: range.to, q: search, page: String(to),
  })}`;
  return <>
    <PageHeading title={kind.success ? tradeNames[kind.data] : "Invoice register"} company={company} toolbar={<>
      {kind.success && toolbarLink(`${base}/invoices`, "All invoice types")}
      {permission(screen, "create") && toolbarLink(`${base}/invoices/new?type=${kind.success ? kind.data : "sale"}`,
        kind.success ? `New ${tradeNames[kind.data].toLowerCase()}` : "New trade document", true)}
    </>} />
    <DateFilters query={query} withSearch>
      <label className="field">Document type<select name="type" defaultValue={kind.success ? kind.data : ""}>
        <option value="">All types</option>{tradeTypes.map((type) => <option value={type} key={type}>{tradeNames[type]}</option>)}
      </select></label>
      <label className="field">Status<select name="status" defaultValue={status ?? ""}>
        <option value="">Draft and posted</option><option value="draft">Draft</option><option value="posted">Posted</option><option value="void">Voided</option>
      </select></label>
    </DateFilters>
    <PanelTable title="Trade documents" headers={["Date","Invoice and items","Type","Party","External reference","Voucher","Status","Total (PKR)"]}
      empty={!rows.length ? "No invoices match your filters" : undefined}>
      {rows.map((row) => {
        const details = lines.filter((line) => line.invoiceId === row.id);
        return <tr key={row.id}><td>{displayDate(row.date)}</td><td>
          <Link className="text-link" href={`${base}/invoices/${row.id}`}>{row.number ?? "Open draft"}</Link>
          {details.length > 0 && <details className="mt-1"><summary className="muted cursor-pointer">{details.length} item {details.length === 1 ? "line" : "lines"}</summary>
            <ul className="mt-1">{details.map((line) => <li className="text-sm mb-1" key={line.lineNo}>{line.lineType !== "product" && `${lineTypeNames[line.lineType]} · `}{line.item} · {quantityLabel(line.qty)} {line.unit} · {line.amount === null ? "Draft line" : `PKR ${formatMoney(line.amount)}`}</li>)}</ul>
          </details>}
        </td><td>{tradeNames[row.type]}</td><td>{row.party}</td><td>{row.externalRef || "—"}</td>
        <td>{row.voucherDocumentId ? <Link className="text-link" href={`${accounting}/vouchers/${row.voucherDocumentId}`}>{row.voucher}</Link> : "—"}</td>
        <td><span className={`tag ${row.status === "posted" ? "tag-active" : ""}`}>{row.status}</span></td><Money value={row.total} /></tr>;
      })}
    </PanelTable>
    {(page > 1 || Number(rows[0]?.count ?? 0) > page * 40) && <nav className="finance-toolbar">
      {page > 1 && toolbarLink(pageLink(page - 1), "Previous page")}
      <span>Page {page}</span>{Number(rows[0]?.count ?? 0) > page * 40 && toolbarLink(pageLink(page + 1), "Next page")}
    </nav>}
  </>;
}

async function linkedChoice(screen: TradeScreen, type: TradeType) {
  const { companyId, base, company, query } = screen;
  const origin = isSale(type) ? "sale" : "purchase";
  const search = (first(query.q) ?? "").trim().slice(0,100);
  const invoices = await invoiceRegister(getDb(), companyId, { from: "1900-01-01", to: "2199-12-31", type: origin, status: "posted", q: search, offset: 0 });
  return <>
    <PageHeading title={`New ${tradeNames[type].toLowerCase()}`} company={company} toolbar={
      permission(screen, "approve") ? toolbarLink(`${base}/invoices/new?type=${type}&historical=1`, "Standalone historical return") : undefined} />
    <form method="get" className="range-form panel">
      <input type="hidden" name="type" value={type} /><label className="field">Search original invoices<input name="q" defaultValue={search} maxLength={100} /></label>
      <Button type="submit" variant="outline">Search</Button>
    </form>
    <PanelTable title="Choose the original posted invoice" headers={["Invoice","Date","Party","Total (PKR)","Action"]} empty={!invoices.length ? "No posted invoices match the search" : undefined}>
      {invoices.map((row) => <tr key={row.id}><td>{row.number}</td><td>{displayDate(row.date)}</td><td>{row.party}</td>
        <Money value={row.total} /><td>{toolbarLink(`${base}/invoices/new?type=${type}&original=${row.id}`, "Return items")}</td></tr>)}
    </PanelTable>
  </>;
}

export async function TradeEntry(screen: TradeScreen, id?: string) {
  const { companyId, company, base, query } = screen;
  const db = getDb();
  const [options, existing] = await Promise.all([tradeOptions(db, companyId), id ? invoiceDetail(db, companyId, id) : null]);
  const requestCopy = first(query.copy);
  const rawType = tradeType.safeParse(existing?.invoice.type ?? first(query.type) ?? "sale");
  if (!rawType.success || id && (!existing?.invoice.payload || existing.invoice.status === "void" || !permission(screen, "edit"))
    || !id && !permission(screen, "create")) notFound();
  const type = rawType.data;
  const requireApproval = options.settings.voucherApproval;
  const canPost = permission(screen, "post") && (!requireApproval || permission(screen, "approve"));
  if (existing?.invoice.status === "posted" && !canPost) notFound();
  const copier = requestCopy && !id && z.uuid().safeParse(requestCopy).success ? await invoiceDetail(db, companyId, requestCopy) : null;
  if (requestCopy && (!copier || copier.invoice.type !== type || !copier.invoice.payload)) notFound();
  const saved = invoiceSchema.safeParse((existing ?? copier)?.invoice.payload);
  const originalId = saved.success ? saved.data.originalInvoiceId : first(query.original) || null;
  const exchangeId = copier ? null : saved.success ? saved.data.exchangeReturnId : first(query.exchange) || null;
  if ((originalId && !z.uuid().safeParse(originalId).success) || (exchangeId && !z.uuid().safeParse(exchangeId).success)) notFound();
  if (!existing && isReturn(type) && !originalId && !copier && first(query.historical) !== "1") return linkedChoice(screen, type);
  if (isReturn(type) && !originalId && !permission(screen, "approve") && !existing) notFound();
  const original = originalId ? await invoiceDetail(db, companyId, originalId) : null;
  const exchange = exchangeId ? await invoiceDetail(db, companyId, exchangeId) : null;
  if (originalId && (!original?.invoice.calculation || original.invoice.status !== "posted" || original.invoice.type !== (isSale(type) ? "sale" : "purchase"))) notFound();
  if (exchangeId && (!exchange || exchange.invoice.status !== "posted" || exchange.invoice.type !== "sale_return" || type !== "sale")) notFound();
  const quantities = originalId ? await returnedQuantities(db, companyId, originalId, id) : [];
  const source = original?.lines.map((line) => {
    const previous = quantities.find((row) => row.line === line.lineNo)?.quantity ?? "0";
    return { ...line, quantity: line.qty, previous, available: new Exact(line.qty).minus(previous).toString(),
      description: line.description || line.item };
  });
  const baseDate = karachiToday();
  const blank: InvoiceInput = {
    type, date: baseDate, dueOn: "", partyId: original?.invoice.partyId ?? exchange?.invoice.partyId ?? "",
    externalRef: "", poRef: "", narration: "", notes: "", reason: "", originalInvoiceId: originalId, exchangeReturnId: exchangeId,
    withholding: "0", duplicateReason: "", lines: [], payments: [], salesExecutiveId: null,
  };
  const input = saved.success && existing ? saved.data : saved.success && copier ? {
    ...saved.data, date: baseDate, dueOn: "", externalRef: "", duplicateReason: "", exchangeReturnId: null,
    reason: isReturn(type) ? "" : saved.data.reason, payments: [],
  } : blank;
  return <>
    <PageHeading title={existing ? `Edit ${tradeNames[type].toLowerCase()}` : copier ? `Duplicate ${tradeNames[type].toLowerCase()}`
      : `New ${tradeNames[type].toLowerCase()}`} company={company} toolbar={toolbarLink(
      existing ? `${base}/invoices/${existing.invoice.id}` : `${base}/invoices?type=${type}`, "Cancel")} />
    {original && <div className="setup-callout"><span>Original invoice <Link className="text-link" href={`${base}/invoices/${original.invoice.id}`}>{original.invoice.number}</Link></span>
      <span>Return prices, discounts, taxes and original sale costs come from the posted invoice.</span></div>}
    {exchange && <div className="setup-callout">Exchange sale linked to return <Link className="text-link" href={`${base}/invoices/${exchange.invoice.id}`}>{exchange.invoice.number}</Link></div>}
    <InvoiceEditor companyId={companyId} base={base} options={options} initial={input} source={source} id={existing?.invoice.id}
      originalWithholding={new Exact((original?.invoice.calculation as InvoiceCalculation | undefined)?.withholding ?? "0").gt(0)}
      version={existing?.invoice.version ?? 0} posted={existing?.invoice.status === "posted"} canPost={canPost} canCreate={permission(screen, "create")} canApprove={permission(screen, "approve")} />
  </>;
}

function Lifecycle({ screen, kind, id, version, action }: { screen: TradeScreen; kind: "invoice" | "inventory_adjustment"; id: string; version: number; action: "void" | "restore" }) {
  return <section className="panel print-hide"><details><summary className="cursor-pointer font-semibold">{action === "void" ? "Void document" : "Restore document"}</summary>
    <FinanceForm action={lifecycleAction} companyId={screen.companyId} id={id} version={version}
      submit={[{ label: action === "void" ? "Confirm void" : "Confirm restore", variant: action === "void" ? "danger" : "outline" }]}>
      <input type="hidden" name="kind" value={kind} /><input type="hidden" name="operation" value={action} />
      <label className="field mt-3">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
    </FinanceForm>
  </details></section>;
}

function History({ rows }: { rows: Awaited<ReturnType<typeof tradeHistory>> }) {
  return <section className="panel print-hide"><h2>Document history</h2>
    {rows.length ? rows.map((row) => <details className="finance-history" key={row.id}>
      <summary>{row.reason} · {row.actor} · {displayDate(row.date.slice(0,10))}</summary>
      <div className="form-grid mt-3">
        <div><strong>Before</strong><pre className="history-data">{JSON.stringify(row.before, null, 2)}</pre></div>
        <div><strong>After</strong><pre className="history-data">{JSON.stringify(row.after, null, 2)}</pre></div>
      </div>
    </details>) : <p className="muted mt-2">No recorded changes.</p>}
  </section>;
}

export async function TradeDetail(screen: TradeScreen, id: string) {
  const { companyId, company, base, accounting } = screen;
  const db = getDb();
  const detailed = await invoiceDetail(db, companyId, id);
  if (!detailed) notFound();
  const { invoice, party, voucher, original, exchange, lines, payments, executive } = detailed;
  const payload = invoice.payload as InvoiceInput | null;
  const calc = invoice.calculation as InvoiceCalculation | null;
  const archived = invoice.status === "void";
  const posted = invoice.status === "posted";
  const writable = !!payload;
  const post = permission(screen, "post");
  const pdf = `/api/trade/${companyId}/${id}`;
  const history = await tradeHistory(db, companyId, id, "invoice");
  const options = lines.length || !payload ? null : await tradeOptions(db, companyId);
  return <>
    <PageHeading title={invoice.number ?? `${tradeNames[invoice.type]} draft`} company={company} toolbar={<>
      {toolbarLink(`${base}/invoices?type=${invoice.type}`, "Invoice register")}
      {writable && !archived && permission(screen, "edit") && (!posted || post) && toolbarLink(`${base}/invoices/${id}?edit=1`, "Edit document")}
      {payload && permission(screen, "create") && toolbarLink(`${base}/invoices/new?type=${invoice.type}&copy=${id}`, "Duplicate as new")}
      {posted && payload && !isReturn(invoice.type) && permission(screen, "create") && toolbarLink(`${base}/invoices/new?type=${invoice.type}_return&original=${id}`, "Create return")}
      {posted && invoice.type === "sale_return" && permission(screen, "create") && toolbarLink(`${base}/invoices/new?type=sale&exchange=${id}`, "New exchange sale")}
      {permission(screen, "print") && <Button asChild variant="outline"><a href={`${pdf}?inline=1`} target="_blank" rel="noreferrer"><Printer size={16} /> Print invoice</a></Button>}
      {permission(screen, "export") && <Button asChild variant="outline"><a href={pdf}><Download size={16} /> Download PDF</a></Button>}
    </>} />
    <section className="panel"><dl className="finance-detail">
      <div><dt>Document type</dt><dd>{tradeNames[invoice.type]}</dd></div>
      <div><dt>Invoice date</dt><dd>{displayDate(invoice.date)}</dd></div>
      <div><dt>Status</dt><dd className="capitalize">{archived ? "Voided" : invoice.status}</dd></div>
      <div><dt>{isSale(invoice.type) ? "Customer" : "Supplier"}</dt><dd>{party?.name}</dd></div>
      {invoice.type === "sale" && <div><dt>Sales executive</dt><dd>{executive?.name ?? "—"}</dd></div>}
      <div><dt>Accounting voucher</dt><dd>{voucher ? <Link className="text-link" href={`${accounting}/vouchers/${voucher.id}`}>{voucher.number}</Link> : "Unposted"}</dd></div>
      <div><dt>External reference</dt><dd>{invoice.externalRef || "—"}</dd></div>
      <div><dt>Purchase order</dt><dd>{invoice.poRef || "—"}</dd></div>
      <div><dt>Due date</dt><dd>{invoice.dueOn ? displayDate(invoice.dueOn) : "—"}</dd></div>
      {original && <div><dt>Original invoice</dt><dd><Link className="text-link" href={`${base}/invoices/${original.id}`}>{original.number}</Link></dd></div>}
      {exchange && <div><dt>Exchange return</dt><dd><Link className="text-link" href={`${base}/invoices/${exchange.id}`}>{exchange.number}</Link></dd></div>}
      {payload?.reason && <div><dt>Return reason</dt><dd>{payload.reason}</dd></div>}
      {invoice.duplicateReason && <div><dt>External reference exception</dt><dd>{invoice.duplicateReason}</dd></div>}
      {payload?.narration && <div><dt>Narration</dt><dd>{payload.narration}</dd></div>}
      {payload?.notes && <div><dt>Notes</dt><dd>{payload.notes}</dd></div>}
    </dl></section>
    <PanelTable title="Item details" headers={["Line type","Item","Description","Quantity","Unit","Rate (PKR)","Discount","Tax","Line total","Disposition"]}>
      {lines.length ? lines.map((line) => <tr key={line.lineNo}><td>{lineTypeNames[line.lineType]}</td>
        <td><Link className="text-link" href={`${base}/inventory/${line.itemId}`}>{line.item}</Link></td><td>{line.description}</td>
        <td>{quantityLabel(line.qty)}</td><td>{line.unit}</td><td>{quantityLabel(line.rate)}</td>
        <Money value={line.discount} /><Money value={line.tax} /><Money value={line.amount} />
        <td>{invoice.type === "sale_return" ? line.disposition : "—"}</td>
      </tr>) : payload?.lines.map((line, index) => {
        const item = options?.goods.find((option) => option.id === line.itemId);
        return <tr key={index}><td>{lineTypeNames[line.lineType ?? "product"]}</td><td>{item?.name}</td><td>{line.description}</td><td>{line.quantity}</td><td>{item?.unit}</td><td>{line.rate}</td>
          <td>{line.discount}</td><td>{line.tax}</td><td>Unposted</td><td>{line.disposition}</td></tr>;
      })}
    </PanelTable>
    {posted || archived && invoice.voucherId ? <section className="panel"><dl className="finance-detail">
      <div><dt>Grand total (PKR)</dt><dd>{formatMoney(invoice.total)}</dd></div>
      {calc && <>
        <div><dt>Tax</dt><dd>{formatMoney(calc.tax)}</dd></div><div><dt>Withholding</dt><dd>{formatMoney(calc.withholding)}</dd></div>
        <div><dt>{isReturn(invoice.type) ? "Refund" : "Paid on invoice"}</dt><dd>{formatMoney(calc.settled)}</dd></div>
        <div><dt>{isReturn(invoice.type) ? "Party credit or debit adjustment" : "Initial amount on credit"}</dt><dd>{formatMoney(calc.partyAmount)}</dd></div>
        {original && <div><dt>Applied to original</dt><dd>{formatMoney(calc.appliedCredit)}</dd></div>}
      </>}
    </dl></section> : null}
    {payments.length > 0 && <PanelTable title={isReturn(invoice.type) ? "Refund details" : "Payment details"} headers={["Account","Amount (PKR)"]}>
      {payments.map((payment, index) => <tr key={index}><td>{payment.name}</td><Money value={payment.amount} /></tr>)}
    </PanelTable>}
    {writable && (archived ? permission(screen, "restore") && (!invoice.voucherId || post) : permission(screen, "delete")) &&
      <Lifecycle screen={screen} kind="invoice" id={id} version={invoice.version} action={archived ? "restore" : "void"} />}
    <History rows={history} />
  </>;
}

export async function InventoryView(screen: TradeScreen) {
  const { companyId, base, company, query } = screen;
  const asOf = karachiToday();
  const rows = await inventorySummary(getDb(), companyId, asOf);
  const q = (first(query.q) ?? "").trim().toLowerCase().slice(0,100);
  const visible = rows.filter((row) => !q || `${row.name} ${row.sku} ${row.category}`.toLowerCase().includes(q));
  return <>
    <PageHeading title="Inventory items" company={company} toolbar={<>{toolbarLink(`${base}/adjustments`, "Inventory adjustments")}
      {permission(screen, "create") && toolbarLink(`${base}/inventory/new`, "Add item", true)}</>} />
    <form className="range-form panel" method="get"><label className="field">Search items<input name="q" defaultValue={q} maxLength={100} /></label>
      <Button type="submit" variant="outline">Search</Button></form>
    <PanelTable title={`Available stock on ${displayDate(asOf)}`} headers={["Item","SKU","Category","Unit","Opening","Purchased","Sold","Sale returns","Purchase returns","Adjustments","On hand","Average cost","Stock value","Status"]}
      empty={!visible.length ? "No inventory items match your search" : undefined}>
      {visible.map((row) => <tr key={row.id}><td><Link className="text-link" href={`${base}/inventory/${row.id}`}>{row.name}</Link>
        {row.kind === "service" && <span className="tag ml-2">Service</span>}</td><td>{row.sku}</td><td>{row.category || "—"}</td><td>{row.unit}</td>
        {[row.opening,row.purchases,row.sales,row.saleReturns,row.purchaseReturns,row.adjusted,row.qty].map((quantity, index) =>
          <td key={index} className="money-cell">{row.kind === "service" ? "—" : quantityLabel(quantity)}</td>)}
        <td className="money-cell">{quantityLabel(row.average)}</td><Money value={row.value} />
        <td>{row.active ? row.kind === "stock" && new Exact(row.qty).lt(row.reorder) ? "Below reorder" : "Active" : "Inactive"}</td></tr>)}
    </PanelTable>
  </>;
}

export async function ItemView(screen: TradeScreen, id?: string) {
  const { companyId, base, company, accounting, query } = screen;
  const db = getDb();
  const existing = id ? await readItem(db, companyId, id) : null;
  if (id && !existing || !id && !permission(screen, "create")) notFound();
  const today = karachiToday();
  const canEdit = permission(screen, id ? "edit" : "create");
  const item = existing?.item;
  const range = resolveRange(query);
  const summary = id ? (await inventorySummary(db, companyId, range.to, id))[0] : null;
  const ledger = item?.kind === "stock" ? await stockLedger(db, companyId, item.id, range.from, range.to) : [];
  const options = canEdit ? await tradeOptions(db, companyId) : null;
  return <>
    <PageHeading title={item?.name ?? "Add inventory item"} company={company} toolbar={<>
      {toolbarLink(`${base}/inventory`, "Inventory")}
      {item?.kind === "stock" && permission(screen, "post") && permission(screen, "create") && toolbarLink(`${base}/adjustments/new?item=${item.id}`, "Adjust stock")}
    </>} />
    {canEdit && options ? <section className="panel"><h2>Item details</h2><ItemFields companyId={companyId} base={base} options={options}
      item={existing ? { ...existing.item, unit: existing.unit } : undefined} canPost={permission(screen, "post")} today={today} /></section> :
      item && <section className="panel"><dl className="finance-detail"><div><dt>SKU</dt><dd>{item.sku || "—"}</dd></div>
        <div><dt>Unit</dt><dd>{existing?.unit}</dd></div><div><dt>Category</dt><dd>{item.category || "—"}</dd></div>
        <div><dt>Reorder level</dt><dd>{quantityLabel(item.reorder)}</dd></div><div><dt>Status</dt><dd>{item.active ? "Active" : "Inactive"}</dd></div>
        <div><dt>Description</dt><dd>{item.description || "—"}</dd></div></dl></section>}
    {summary && item?.kind === "stock" && <>
      <section className="panel"><h2>Stock on {displayDate(range.to)}</h2><dl className="finance-detail mt-3">
        <div><dt>Available quantity</dt><dd>{quantityLabel(summary.qty)} {summary.unit}</dd></div>
        <div><dt>Moving-average cost</dt><dd>{quantityLabel(summary.average)} PKR</dd></div>
        <div><dt>Inventory value</dt><dd>{formatMoney(summary.value)} PKR</dd></div>
        <div><dt>Opening date</dt><dd>{summary.openingDate ? displayDate(summary.openingDate) : "—"}</dd></div>
        <div><dt>Opening quantity</dt><dd>{quantityLabel(summary.opening)}</dd></div>
        <div><dt>Effective opening rate</dt><dd>{new Exact(summary.opening).isZero() ? "—" :
          new Exact(summary.openingValue).div(summary.opening).toFixed(10).replace(/\.?0+$/, "")}</dd></div>
      </dl></section>
      <DateFilters query={query} dateLabel="Stock ledger dates" />
      <PanelTable title="Stock ledger" headers={["Date","Voucher","Movement","Change in quantity","Unit cost","Value change","Running quantity","Running value","Average"]}
        empty={!ledger.length ? "No posted movements in this period" : undefined}>
        {ledger.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td><td><Link className="text-link" href={`${accounting}/vouchers/${row.documentId}`}>{row.voucher}</Link></td>
          <td className="capitalize">{row.kind.replaceAll("_"," ")}</td><td>{quantityLabel(row.qty)}</td><td>{quantityLabel(row.unitCost)}</td>
          <Money value={row.value} /><td>{quantityLabel(row.qtyAfter)}</td><Money value={row.valueAfter} /><td>{quantityLabel(row.average)}</td></tr>)}
      </PanelTable>
    </>}
  </>;
}

export async function TradeSettings(screen: TradeScreen) {
  const { companyId, company } = screen;
  if (!permission(screen, "manage_company")) notFound();
  const { settings } = await tradeOptions(getDb(), companyId);
  return <>
    <PageHeading title="Invoice settings" company={company} />
    <section className="panel"><h2>Tax and withholding entry</h2>
      <p className="muted mt-2">Enable these fields only for businesses that use them. Enter reviewed amounts on each document.</p>
      <FinanceForm action={tradeSettingsAction} companyId={companyId} submit={[{ label: "Save invoice settings" }]}>
        <div className="form-grid mt-4">
          <label className="field">Tax entry<select name="tradeTax" defaultValue={String(settings.tradeTax)}><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
          <label className="field">Withholding entry<select name="tradeWithholding" defaultValue={String(settings.tradeWithholding)}><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
        </div>
      </FinanceForm>
    </section>
  </>;
}

export async function AdjustmentView(screen: TradeScreen, id?: string) {
  const { companyId, base, company, accounting, query } = screen;
  const db = getDb();
  const existing = id ? await adjustmentDetail(db, companyId, id) : null;
  if (id && !existing) notFound();
  const editing = !!id && first(query.edit) === "1";
  if (!id || editing) {
    if (!permission(screen, "post") || !permission(screen, id ? "edit" : "create") || editing && (!existing?.source.payload || existing.source.status !== "posted")) notFound();
    const today = karachiToday();
    const options = await inventorySummary(db, companyId, today);
    return <>
      <PageHeading title={editing ? "Edit inventory adjustment" : "New inventory adjustment"} company={company}
        toolbar={toolbarLink(id ? `${base}/adjustments/${id}` : `${base}/adjustments`, "Cancel")} />
      <section className="panel"><AdjustmentEditor companyId={companyId} base={base} today={today} canApprove={permission(screen, "approve")}
        id={id} version={existing?.source.version ?? 0} input={existing?.source.payload as import("@/lib/trade/model").AdjustmentInput | undefined}
        options={options.filter((row) => row.kind === "stock" && row.active)} defaultItem={first(query.item)} /></section>
    </>;
  }
  const { source, item, voucher, actor } = existing!;
  const calc = source.calculation as AdjustmentCalculation | null;
  const archive = source.status === "void";
  return <>
    <PageHeading title={source.number ?? "Inventory adjustment"} company={company} toolbar={<>
      {toolbarLink(`${base}/adjustments`, "Adjustment register")}
      {!archive && source.payload && permission(screen, "edit") && permission(screen, "post") && toolbarLink(`${base}/adjustments/${id}?edit=1`, "Edit adjustment")}
    </>} />
    <section className="panel"><dl className="finance-detail">
      <div><dt>Type</dt><dd>{adjustmentNames[source.kind as keyof typeof adjustmentNames] ?? "Inventory adjustment"}</dd></div>
      <div><dt>Date</dt><dd>{source.date && displayDate(source.date)}</dd></div>
      <div><dt>Item</dt><dd>{item?.item.name}</dd></div><div><dt>Status</dt><dd className="capitalize">{archive ? "Voided" : source.status}</dd></div>
      <div><dt>Voucher</dt><dd>{voucher && <Link className="text-link" href={`${accounting}/vouchers/${voucher.id}`}>{voucher.number}</Link>}</dd></div>
      <div><dt>Entered by</dt><dd>{actor?.name ?? "—"}</dd></div>
      <div><dt>Reason</dt><dd>{source.reason}</dd></div>
      <div><dt>Supporting reference</dt><dd>{(source.payload as import("@/lib/trade/model").AdjustmentInput | null)?.reference || "—"}</dd></div>
      {calc && <>
        <div><dt>System quantity</dt><dd>{quantityLabel(calc.previous)}</dd></div>
        <div><dt>Physical quantity</dt><dd>{calc.physical ? quantityLabel(calc.physical) : "—"}</dd></div>
        <div><dt>Quantity difference</dt><dd>{quantityLabel(calc.difference)}</dd></div>
        <div><dt>Cost per unit (PKR)</dt><dd>{quantityLabel(calc.unitCost)}</dd></div>
        <div><dt>Value adjustment (PKR)</dt><dd>{formatMoney(calc.value)}</dd></div>
      </>}
    </dl></section>
    {!!source.payload && (archive ? permission(screen, "restore") && permission(screen, "post") : permission(screen, "delete")) &&
      <Lifecycle screen={screen} kind="inventory_adjustment" id={source.id} version={source.version} action={archive ? "restore" : "void"} />}
    <History rows={await tradeHistory(db, companyId, source.id, "inventory_adjustment")} />
  </>;
}

export async function AdjustmentRegister(screen: TradeScreen) {
  const { companyId, base, company, accounting, query } = screen;
  const range = resolveRange(query);
  const status = first(query.status) ?? "";
  const search = (first(query.q) ?? "").trim().slice(0,100);
  const rows = (await getDb().execute<{ id: string; date: string | null; kind: string | null; status: string; number: string | null; reason: string; item: string | null;
    voucherId: string; voucher: string; actor: string; difference: string | null; value: string | null }>(sql`
    SELECT a.id,a.accounting_date::text AS date,a.kind,a.status,a.number,a.reason,g.name AS item,
      coalesce(d.id,v.id) AS "voucherId",coalesce(d.number,v.number) AS voucher,u.display_name AS actor,
      a.calculation->>'difference' AS difference,a.calculation->>'value' AS value
    FROM inventory_adjustments a LEFT JOIN users u ON u.id=a.created_by
    LEFT JOIN inventory_items g ON g.company_id=a.company_id AND g.id=a.item_id
    LEFT JOIN vouchers v ON v.company_id=a.company_id AND v.id=a.voucher_id
    LEFT JOIN voucher_versions w ON w.company_id=v.company_id AND w.voucher_id=v.id
    LEFT JOIN voucher_documents d ON d.company_id=w.company_id AND d.id=w.document_id
    WHERE a.company_id=${companyId} AND coalesce(a.accounting_date,v.accounting_date) BETWEEN ${range.from}::date AND ${range.to}::date
      AND (${status}='' AND a.status<>'void' OR a.status::text=${status})
      AND (${search}='' OR strpos(lower(concat_ws(' ',a.number,a.reason,g.name,u.display_name)),lower(${search}))>0)
    ORDER BY coalesce(a.accounting_date,v.accounting_date) DESC,a.created_at DESC LIMIT 100
  `)).rows;
  return <>
    <PageHeading title="Inventory adjustments" company={company} toolbar={<>
      {toolbarLink(`${base}/inventory`, "Inventory")}
      {permission(screen, "create") && permission(screen, "post") && toolbarLink(`${base}/adjustments/new`, "New adjustment", true)}
    </>} />
    <DateFilters query={query} withSearch>
      <label className="field">Status<select name="status" defaultValue={status}><option value="">Active</option><option value="void">Voided</option></select></label>
    </DateFilters>
    <PanelTable title="Adjustment register" headers={["Date","Adjustment","Item","Type","Status","Qty difference","Value (PKR)","Voucher","Entered by","Reason"]}
      empty={!rows.length ? "No adjustments match your filters" : undefined}>
      {rows.map((row) => <tr key={row.id}><td>{row.date ? displayDate(row.date) : "—"}</td><td><Link className="text-link" href={`${base}/adjustments/${row.id}`}>{row.number ?? "View adjustment"}</Link></td>
        <td>{row.item ?? "—"}</td><td>{row.kind ? adjustmentNames[row.kind as keyof typeof adjustmentNames] : "—"}</td><td>{row.status}</td>
        <td>{row.difference ? quantityLabel(row.difference) : "—"}</td>{row.value ? <Money value={row.value} /> : <td>—</td>}
        <td>{row.voucherId && <Link className="text-link" href={`${accounting}/vouchers/${row.voucherId}`}>{row.voucher}</Link>}</td>
        <td>{row.actor}</td><td>{row.reason}</td></tr>)}
    </PanelTable>
  </>;
}
