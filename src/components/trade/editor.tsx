"use client";

import { useState } from "react";
import { PackagePlus, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { FinanceForm } from "@/components/accounting/finance-form";
import { matchesSearch } from "@/components/accounting/entry-form";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/display";
import { Exact } from "@/lib/engine/model";
import { inlinePartyAction, invoiceAction, itemAction } from "@/lib/trade/actions";
import { isReturn, isSale, lineFinancials, lineTypeNames, lineTypes, type InvoiceInput, type LineType } from "@/lib/trade/model";
import type { tradeOptions } from "@/lib/trade/read";

type Options = Awaited<ReturnType<typeof tradeOptions>>;
type SourceLine = { lineNo: number; itemId: string; description: string; rate: string; unit: string; quantity: string; subtotal: string;
  discount: string; tax: string; previous: string; available: string; lineType: LineType };
type Row = InvoiceInput["lines"][number];
const emptyRow = (): Row => ({
  itemId: "", description: "", quantity: "", rate: "", discount: "0", tax: "0", historicalCost: "",
  originalLineNo: null, disposition: "saleable",
});
type Settlement = { accountId: string; amount: string };

export function InvoiceEditor({ companyId, base, options, initial, source, originalWithholding, id, version, posted, canPost, canCreate, canApprove }: {
  companyId: string; base: string; options: Options; initial: InvoiceInput; source?: SourceLine[]; id?: string; version: number;
  posted: boolean; canPost: boolean; canCreate: boolean; canApprove: boolean; originalWithholding: boolean;
}) {
  const [head, setHead] = useState(initial);
  const [rows, setRows] = useState<Row[]>(() => {
    if (initial.lines.length) return initial.lines;
    if (source) return source.filter((line) => new Exact(line.available).gt(0)).map((line) => ({ ...emptyRow(),
      itemId: line.itemId, description: line.description, rate: line.rate, originalLineNo: line.lineNo,
      lineType: line.lineType === "product" ? undefined : line.lineType }));
    return [emptyRow()];
  });
  const [payments, setPayments] = useState<Settlement[]>(initial.payments);
  const returned = isReturn(head.type);
  const linked = !!source;
  const sale = isSale(head.type);
  const historical = returned && !linked;
  const partyType = sale ? "customer" : "supplier";
  const taxEnabled = options.settings.tradeTax || initial.lines.some((line) => new Exact(line.tax).gt(0));
  const withholding = options.settings.tradeWithholding || new Exact(initial.withholding).gt(0) || originalWithholding;
  const cash = options.heads.filter((account) => account.liquidity);
  const patch = (item: Partial<InvoiceInput>) => setHead((current) => ({ ...current, ...item }));
  const updateLine = (index: number, item: Partial<Row>) => setRows((current) => current.map((line, i) => i === index ? { ...line, ...item } : line));
  const updatePayment = (index: number, item: Partial<Settlement>) => setPayments((current) => current.map((line, i) => i === index ? { ...line, ...item } : line));
  const payload = rows.filter((line) => linked ? line.quantity && /[1-9]/.test(line.quantity) : line.itemId || line.quantity || line.rate || line.description)
    .map((line) => ({ ...line, rate: line.rate || "0", historicalCost: historical && sale && options.goods.find((item) => item.id === line.itemId)?.kind === "stock" ? line.historicalCost : "0.0" }));
  const figures = rows.map((line) => {
    const original = source?.find((candidate) => candidate.lineNo === line.originalLineNo);
    try {
      return lineFinancials({ ...line, quantity: line.quantity || "0", rate: line.rate || "0", discount: line.discount || "0", tax: line.tax || "0" },
        original, new Exact(original?.previous ?? "0"));
    } catch { return null; }
  });
  const prices = figures.map((result) => result ? result.net.plus(result.tax) : new Exact(0));
  const total = prices.reduce((sum, price) => sum.plus(price), new Exact(0));
  // Display-only breakdown of the grand total for the summary panel.
  const part = (field: "gross" | "discount" | "tax") => figures.reduce((sum, result) => result ? sum.plus(result[field]) : sum, new Exact(0));
  const exact = (raw: string) => { try { return new Exact(raw || "0"); } catch { return new Exact(0); } };
  const paid = payments.reduce((sum, payment) => sum.plus(exact(payment.amount)), new Exact(0));
  const open = total.minus(paid).minus(exact(head.withholding));
  const availableParties = options.people.filter((person) => person.type === partyType && (person.active || person.id === head.partyId));
  const [itemFinds, setItemFinds] = useState<Record<number, string>>({});
  const availableItems = options.goods.filter((item) => item.active || rows.some((row) => row.itemId === item.id));
  const executives = options.executives.filter((entry) => entry.active || entry.id === head.salesExecutiveId);
  const updateParty = (partyId: string) => {
    const input = options.people.find((person) => person.id === partyId);
    const date = new Date(`${head.date}T00:00:00Z`);
    if (!returned && input && Number.isFinite(date.getTime())) {
      date.setUTCDate(date.getUTCDate() + input.creditDays);
      patch({ partyId, dueOn: date.toISOString().slice(0,10) });
    } else patch({ partyId });
  };
  const money = (value: InstanceType<typeof Exact>) => formatMoney(value.toFixed(2));
  const showTax = taxEnabled || linked;
  return <>
    <FinanceForm className="trade-editor" action={invoiceAction} companyId={companyId} id={id} version={version} successTo={`${base}/invoices/{id}`}
      submit={posted ? [{ label: "Post revised document", value: "post" }] :
        [{ label: "Save draft", value: "draft", variant: "outline" }, ...(canPost ? [{ label: "Post document", value: "post" } as const] : [])]}>
      <input type="hidden" name="input" value={JSON.stringify({ ...head, lines: payload, payments })} />
      <section className="panel trade-form-card">
        <div className="trade-card-head"><div><h2>Document details</h2>
          <p className="trade-subtitle">{sale ? "Customer" : "Supplier"}, dates and references for this {returned ? "return" : "invoice"}.</p></div></div>
        <div className="form-grid trade-form-grid">
          <label className="field">Accounting date<input type="date" value={head.date} onChange={(event) => patch({ date: event.target.value })} required /></label>
          <label className="field">{sale ? "Customer" : "Supplier"}<select value={head.partyId} aria-label={sale ? "Customer" : "Supplier"}
            onChange={(event) => updateParty(event.target.value)} disabled={linked || !!head.exchangeReturnId} required>
            <option value="">Select {partyType}</option>{availableParties.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>
          {!returned && <label className="field">Due date<input type="date" value={head.dueOn} min={head.date} onChange={(event) => patch({ dueOn: event.target.value })} /></label>}
          <label className="field">External invoice or reference number<input value={head.externalRef} maxLength={120}
            onChange={(event) => patch({ externalRef: event.target.value })} required={historical} /></label>
          <label className="field">Purchase order reference<input value={head.poRef} maxLength={120} onChange={(event) => patch({ poRef: event.target.value })} /></label>
          {head.type === "sale" && <label className="field">Sales executive<select aria-label="Sales executive" value={head.salesExecutiveId ?? ""}
            onChange={(event) => patch({ salesExecutiveId: event.target.value || null })}>
            <option value="">No sales executive</option>{executives.map((entry) => <option key={entry.id} value={entry.id}>
              {entry.name}{entry.active ? "" : " (inactive)"}</option>)}
          </select></label>}
          {returned && <label className="field">Return reason<input value={head.reason} maxLength={1000} onChange={(event) => patch({ reason: event.target.value })} required /></label>}
          <label className="field trade-span-2">Narration<input value={head.narration} maxLength={1000} onChange={(event) => patch({ narration: event.target.value })} /></label>
          <label className="field field-wide">{historical ? "Verified values and cost treatment" : "Notes"}<textarea
            value={head.notes} maxLength={1000} onChange={(event) => patch({ notes: event.target.value })} required={historical} /></label>
          {head.type === "purchase" && canApprove && <label className="field field-wide">Reason for duplicate supplier reference exception
            <input value={head.duplicateReason} maxLength={500} onChange={(event) => patch({ duplicateReason: event.target.value })} /></label>}
        </div>
      </section>

      <section className="panel trade-form-card trade-lines-card">
        <div className="trade-card-head"><div><h2>Items</h2>
          <p className="trade-subtitle">{linked ? "Enter the quantity to return on each original line." : "Search or pick an item on each line, then enter quantity and rate."}</p></div>
          <span className="pill">{rows.length} {rows.length === 1 ? "line" : "lines"}</span></div>
        <div className="table-scroll trade-grid-scroll"><table className="entry-table trade-entry trade-grid"><thead><tr>
          <th className="trade-col-no">#</th><th className="trade-col-type">Line type</th><th className="trade-col-item">Item and description</th>
          <th className="trade-col-qty trade-num">Quantity</th><th className="trade-col-unit">Unit</th><th className="trade-col-rate trade-num">Rate (PKR)</th>
          {historical && sale && <th className="trade-col-rate trade-num">Verified original cost</th>}
          <th className="trade-col-disc trade-num">Discount</th>{showTax && <th className="trade-col-disc trade-num">Tax</th>}
          {head.type === "sale_return" && <th className="trade-col-type">Disposition</th>}<th className="trade-col-total trade-num">Line total</th><th className="trade-col-del" aria-label="Remove" />
        </tr></thead><tbody>{rows.map((line, index) => {
          const original = source?.find((candidate) => candidate.lineNo === line.originalLineNo);
          const item = availableItems.find((candidate) => candidate.id === line.itemId);
          const changeNumber = (field: "quantity" | "rate" | "discount" | "tax" | "historicalCost", value: string) => {
            if (/^\d{0,18}(?:\.\d{0,10})?$/.test(value)) updateLine(index, { [field]: value });
          };
          const kind = line.lineType ?? "product";
          return <tr key={original?.lineNo ?? index}><td className="trade-col-no">{index + 1}</td><td>
            {original ? <span className="trade-cell-text">{lineTypeNames[original.lineType]}</span> : <select aria-label={`Line type line ${index+1}`} value={kind}
              onChange={(event) => {
                const value = event.target.value as LineType;
                updateLine(index, { lineType: value === "product" ? undefined : value,
                  ...(value !== "product" && item?.kind === "stock" ? { itemId: "" } : {}) });
              }}>{lineTypes.map((value) => <option key={value} value={value}>{lineTypeNames[value]}</option>)}</select>}
          </td><td>
            {original ? <strong className="trade-cell-text">{original.description} · line {original.lineNo}</strong> : (() => {
              const label = (entry: typeof availableItems[number]) => `${entry.sku ? `${entry.sku} · ` : ""}${entry.name}${entry.kind === "service" ? " (service)" : ""}`;
              const query = itemFinds[index] ?? "";
              // Services and freight lines carry no stock, so only service items fit them.
              const visible = availableItems.filter((entry) => (kind === "product" || entry.kind === "service") &&
                (entry.id === line.itemId || matchesSearch(query, label(entry))));
              const choose = (itemId: string) => updateLine(index, { itemId, unitLabel: undefined, purchaseAccountId: undefined });
              return <div className="trade-pick">
                <span className="trade-find"><Search size={14} aria-hidden />
                <input type="search" className="line-find" aria-label={`Find item line ${index+1}`} placeholder="Find" title="Type to search, Enter to choose" value={query}
                  onChange={(event) => setItemFinds({ ...itemFinds, [index]: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const match = visible.find((entry) => entry.id !== line.itemId) ?? visible[0];
                    if (match) {
                      choose(match.id);
                      setItemFinds({ ...itemFinds, [index]: "" });
                      event.currentTarget.closest("tr")?.querySelector<HTMLInputElement>("input[inputmode=decimal]")?.focus();
                    }
                  }} /></span>
                <select aria-label={`Item line ${index+1}`} value={line.itemId} onChange={(event) => choose(event.target.value)}>
                  <option value="">{query && !visible.length ? "No match" : "Select item or service"}</option>
                  {visible.map((entry) => <option value={entry.id} key={entry.id}>{label(entry)}</option>)}
                </select></div>;
            })()}
            <input className="trade-desc-input" aria-label={`Description line ${index+1}`} placeholder="Description" value={line.description} maxLength={250}
              onChange={(event) => updateLine(index, { description: event.target.value })} />
          </td>
          <td><input className="trade-num" aria-label={`Quantity line ${index+1}`} inputMode="decimal" value={line.quantity}
            onChange={(event) => changeNumber("quantity", event.target.value)} />
            {original && <small className="muted block trade-remaining">{new Exact(original.available).toString()} remaining</small>}</td>
          <td><span className="trade-cell-text muted">{original?.unit || item?.unit || "—"}</span></td>
          <td>{original ? <span className="trade-cell-text trade-num block">{formatMoney(original.rate)}</span> : <input className="trade-num" aria-label={`Rate line ${index+1}`} inputMode="decimal" value={line.rate}
            onChange={(event) => changeNumber("rate", event.target.value)} />}</td>
          {historical && sale && <td>{item?.kind === "service" ? <span className="trade-cell-text">—</span> : <input className="trade-num" aria-label={`Historical cost line ${index+1}`} inputMode="decimal" value={line.historicalCost}
            onChange={(event) => changeNumber("historicalCost", event.target.value)} />}</td>}
          <td>{original ? <span className="trade-cell-text muted">Original terms</span> : <input className="trade-num" aria-label={`Discount line ${index+1}`} inputMode="decimal" value={line.discount}
            onChange={(event) => changeNumber("discount", event.target.value)} />}</td>
          {showTax && <td>{original ? <span className="trade-cell-text muted">Original terms</span> : <input className="trade-num" aria-label={`Tax line ${index+1}`} inputMode="decimal" value={line.tax}
            onChange={(event) => changeNumber("tax", event.target.value)} />}</td>}
          {head.type === "sale_return" && <td><select aria-label={`Disposition line ${index+1}`} value={line.disposition}
            onChange={(event) => updateLine(index, { disposition: event.target.value as Row["disposition"] })}><option value="saleable">Saleable</option><option value="damaged">Damaged</option></select></td>}
          <td className="money-cell trade-line-total">{formatMoney(prices[index].toFixed(2))}</td>
          <td className="trade-col-del">{!linked && <button className="icon-button" type="button" title={`Remove line ${index+1}`}
            onClick={() => setRows((current) => current.filter((_, i) => i !== index))}><Trash2 size={15} /></button>}</td></tr>;
        })}</tbody></table></div>
        <div className="finance-toolbar trade-lines-foot">
          {linked ? <Button type="button" variant="outline" className="button-small" onClick={() => setRows((current) => current.map((line) =>
            ({ ...line, quantity: new Exact(source?.find((item) => item.lineNo === line.originalLineNo)?.available ?? "0").toString() })))}>
            Return all remaining items
          </Button> : <Button type="button" variant="outline" className="button-small" disabled={rows.length >= 100} onClick={() => setRows((current) => [...current, emptyRow()])}><Plus size={16} /> Add item row</Button>}
        </div>
      </section>

      <div className="trade-settle">
        <section className="panel trade-form-card">
          <div className="trade-card-head"><div><h2>{returned ? "Refund and credit adjustment" : "Payment details"}</h2>
            <p className="trade-subtitle">{returned ? "Any amount left after refunds is posted to the party’s account." : "Amounts without a cash or bank entry remain on credit."}</p></div></div>
          {payments.length > 0 && <div className="trade-payments">{payments.map((payment, index) => <div className="trade-payment" key={index}>
            <label className="field">Cash or bank account {index+1}<select value={payment.accountId} onChange={(event) => updatePayment(index, { accountId: event.target.value })} required>
              <option value="">Select account</option>{cash.map((account) => <option value={account.id} key={account.id}>{account.name} ({account.liquidity})</option>)}
            </select></label>
            <label className="field">{returned ? "Refund" : "Payment"} amount {index+1}<input className="trade-num" inputMode="decimal" value={payment.amount} maxLength={21}
              onChange={(event) => updatePayment(index, { amount: event.target.value })} required /></label>
            <button className="icon-button" type="button" title={`Remove payment ${index+1}`} onClick={() => setPayments((current) => current.filter((_, i) => i !== index))}>
              <Trash2 size={15} /></button>
          </div>)}</div>}
          <Button className="button-small trade-add-payment" variant="outline" type="button" disabled={payments.length >= 20}
            onClick={() => setPayments((current) => [...current, { accountId: "", amount: "" }])}><Plus size={16} /> Add {returned ? "refund" : "payment"}</Button>
          {withholding && <label className="field trade-withholding">Withholding amount<input className="trade-num" inputMode="decimal" value={head.withholding}
            onChange={(event) => patch({ withholding: event.target.value })} maxLength={21} /></label>}
          {posted && <label className="field trade-withholding">Revision reason<input name="reason" required minLength={3} maxLength={500} /></label>}
        </section>
        <aside className="panel trade-summary" aria-label="Invoice totals">
          <h2>Summary</h2>
          <dl className="trade-totals">
            <div><dt>Subtotal</dt><dd>{money(part("gross"))}</dd></div>
            <div><dt>Discount</dt><dd>{part("discount").isZero() ? "0.00" : `− ${money(part("discount"))}`}</dd></div>
            {showTax && <div><dt>Tax</dt><dd>{money(part("tax"))}</dd></div>}
            <div className="trade-total-grand"><dt>Grand total</dt><dd><strong>PKR {formatMoney(total.toFixed(2))}</strong></dd></div>
            <div><dt>{returned ? "Refunds" : "Paid now"}</dt><dd>{money(paid)}</dd></div>
            {withholding && <div><dt>Withholding</dt><dd>{money(exact(head.withholding))}</dd></div>}
            <div className="trade-total-due"><dt>On party account</dt><dd className={open.lt(0) ? "form-error" : undefined}>PKR {formatMoney(open.toFixed(2))}</dd></div>
          </dl>
        </aside>
      </div>
      {!posted && <input type="hidden" name="reason" value="" />}
    </FinanceForm>
    {canCreate && !linked && <div className="admin-grid trade-inline-grid">
      {!head.exchangeReturnId && <section className="panel trade-inline"><details><summary><UserPlus size={16} aria-hidden /><strong>Add {partyType} without leaving this invoice</strong></summary>
        <FinanceForm action={inlinePartyAction} companyId={companyId} submit={[{ label: `Add ${partyType}`, variant: "outline" }]}>
          <input name="type" type="hidden" value={partyType} />
          <label className="field mt-3">Party name<input name="name" required maxLength={160} /></label>
        </FinanceForm>
      </details></section>}
      <section className="panel trade-inline"><details><summary><PackagePlus size={16} aria-hidden /><strong>Add item or service without leaving this invoice</strong></summary>
        <ItemFields companyId={companyId} options={options} inline />
      </details></section>
    </div>}
  </>;
}

export function ItemFields({ companyId, options, base, item, inline = false, canPost = false, today }: {
  companyId: string; options: Options; base?: string; item?: {
    id: string; version: number; name: string; sku: string | null; kind: string; unit: string; description: string;
    category: string; reorder: string; active: boolean; purchaseAccountId: string | null;
  }; inline?: boolean; canPost?: boolean; today?: string;
}) {
  const [kind, setKind] = useState(item?.kind ?? "stock");
  const [opening, setOpening] = useState(false);
  const purchases = options.heads.filter((account) => !account.control && !account.liquidity && ["asset", "expense"].includes(account.type));
  return <FinanceForm action={itemAction} companyId={companyId} id={item?.id} version={item?.version ?? 0}
    submit={[{ label: item ? "Save item" : "Add item" }]} successTo={!inline && !item ? `${base}/inventory/{id}` : undefined}>
    <div className="form-grid trade-form-grid mt-4">
      <label className="field">Item code or SKU<input name="sku" defaultValue={item?.sku ?? ""} required maxLength={80} /></label>
      <label className="field">Item name<input name="name" defaultValue={item?.name} required maxLength={160} /></label>
      <label className="field">Item type<select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="stock">Stock product</option><option value="service">Service</option></select></label>
      <label className="field">Unit of measure<input name="unit" defaultValue={item?.unit ?? "unit"} required maxLength={40} /></label>
      {kind === "service" && <label className="field">Service purchase account<select
        name="purchaseAccountId" defaultValue={item?.purchaseAccountId ?? ""} required><option value="">Choose account</option>
        {purchases.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
      </select></label>}
      {!inline && <>
        <label className="field">Category<input name="category" defaultValue={item?.category} maxLength={100} /></label>
        <label className="field">Reorder level<input name="reorder" defaultValue={item?.reorder ?? "0"} inputMode="decimal" required /></label>
        <label className="field">Status<select name="active" defaultValue={String(item?.active ?? true)}><option value="true">Active</option><option value="false">Inactive</option></select></label>
        <label className="field field-wide">Description<textarea name="description" defaultValue={item?.description} maxLength={1000} /></label>
      </>}
    </div>
    {!inline && !item && kind === "stock" && canPost && <div className="divider mt-5 trade-opening">
      <label className="flex items-center gap-2"><input type="checkbox" name="opening" value="true" checked={opening}
        onChange={(event) => setOpening(event.target.checked)} /> Post opening stock with this item</label>
      {opening && <div className="form-grid trade-form-grid mt-4">
        <label className="field">Opening quantity<input name="openingQuantity" inputMode="decimal" required /></label>
        <label className="field">Opening rate (PKR)<input name="openingRate" inputMode="decimal" defaultValue="0" required /></label>
        <label className="field">Opening date<input name="openingDate" type="date" defaultValue={today} required /></label>
        <label className="field">Opening reason<input name="openingReason" minLength={3} maxLength={500} required /></label>
      </div>}
    </div>}
  </FinanceForm>;
}
