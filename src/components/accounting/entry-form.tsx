"use client";

import { useRef, useState } from "react";
import { FileText, Plus, Rows3, Trash2 } from "lucide-react";
import { saveVoucherAction } from "@/lib/engine/actions";
import { Exact, amount, lineAllows, manualTypes, voucherSides, type EntryLine, type VoucherInput } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { FinanceForm } from "./finance-form";
import { Button } from "../ui/button";
import { SearchSelect, type SearchOption } from "../ui/search-select";

export type Selector = { key: string; accountId: string; partyId: string | null; partyType: "customer" | "supplier" | null; label: string; active: boolean; liquidity: string | null; control: string | null; balance: string | null };
type Line = { row: number; target: string; direction: "debit" | "credit"; amount: string; description: string };
/** Case-insensitive substring match on every word, so "rec ali" finds "1100 Accounts Receivable · Ali Traders". */
export const matchesSearch = (query: string, label: string) => {
  const text = label.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every((word) => text.includes(word));
};
const typeHelp: Record<VoucherInput["type"], string> = {
  JV: "Journal voucher: any accounts, customers or suppliers on either side.",
  VR: "Any accounts, customers or suppliers on either side.",
  CPV: "Cash payment: “Paid from” uses a cash account; “Paid to” is a supplier in party mode, or any other account in direct mode.",
  BPV: "Bank payment: “Paid from” uses a bank account; “Paid to” is a supplier in party mode, or any other account in direct mode.",
  CRV: "Cash receipt: “Received in” uses a cash account; “Received from” is a customer in party mode, or any other account in direct mode.",
  BRV: "Bank receipt: “Received in” uses a bank account; “Received from” is a customer in party mode, or any other account in direct mode.",
};
const balanceLabel = (value: string) => {
  const n = new Exact(value);
  return `PKR ${formatMoney(n.abs().toFixed(2))} ${n.isZero() ? "" : n.gt(0) ? "Dr" : "Cr"}`.trim();
};

export function VoucherEditor({ companyId, entry, options, id, version, isPosted, approval, canPost, base }: {
  companyId: string; entry: VoucherInput; options: Selector[]; id?: string; version: number;
  isPosted: boolean; approval: boolean; canPost: boolean; base: string;
}) {
  const [header, setHeader] = useState(entry);
  const [lines, setLines] = useState<Line[]>(() => {
    if (!entry.lines.length) return [{ row: 1, target: "", direction: "debit", amount: "", description: "" },
      { row: 2, target: "", direction: "credit", amount: "", description: "" }];
    return entry.lines.map((line, index) => {
      const direction = new Exact(line.credit).gt(0) ? "credit" : "debit";
      return { row: index + 1, target: line.partyId ? `${line.accountId}:${line.partyId}` : line.accountId, direction, amount: line[direction], description: line.description };
    });
  });
  const nextLine = useRef(lines.length + 1);
  const selectors = new Map(options.map((option) => [option.key, option]));
  const sides = voucherSides(header.type);
  const allows = (entry: VoucherInput, direction: Line["direction"], option?: Selector) =>
    !!option && option.active && lineAllows(entry.type, entry.mode, direction, option);
  const choices = (direction: Line["direction"]): SearchOption[] => options.filter((option) => allows(header, direction, option)).map((option) => ({
    key: option.key, label: option.label, group: option.partyId ? "Customers and suppliers" : "Accounts", hint: option.partyId ? "Party" : "Account",
  }));
  const lineChoices = { debit: choices("debit"), credit: choices("credit") };
  /** What each line may hold, in words, for its placeholder and empty list. */
  const wanted = (direction: Line["direction"]) => !sides ? "account or party" : direction === sides.settlement ? `${sides.liquidity} account`
    : header.mode === "party" ? sides.receipt ? "customer" : "supplier" : "account";
  const sideLabel = (direction: Line["direction"]) => sides?.labels[direction] ?? (direction === "debit" ? "Debit" : "Credit");
  const payload: EntryLine[] = lines.filter((line) => line.target || line.amount || line.description).map((line) => {
    const option = selectors.get(line.target);
    return { accountId: option?.accountId ?? "", partyId: option?.partyId ?? null, description: line.description,
      debit: line.direction === "debit" ? line.amount || "0" : "0", credit: line.direction === "credit" ? line.amount || "0" : "0" };
  });
  const total = (side: "debit" | "credit") => payload.reduce((sum, line) => {
    const value = amount.safeParse(line[side]); // the server's own amount rule, so "Balanced" means it will post
    return value.success ? sum.plus(value.data) : sum;
  }, new Exact(0));
  const dr = total("debit");
  const cr = total("credit");
  const balanced = dr.eq(cr);
  const edit = (row: number, update: Partial<Line>) => setLines((current) => current.map((line) => line.row === row ? { ...line, ...update } : line));
  const add = (direction: "debit" | "credit") => setLines((current) => [
    ...current, { row: nextLine.current++, target: "", direction, amount: "", description: "" },
  ]);
  /** Applies a new type or mode: lines that no longer fit are cleared and the cash or bank line is pre-filled. */
  const retype = (next: VoucherInput) => {
    setHeader(next);
    setLines((current) => {
      let updated = current.map((line) => !line.target || allows(next, line.direction, selectors.get(line.target)) ? line : { ...line, target: "" });
      const suggest = (direction: Line["direction"], fits: (option: Selector) => boolean) => {
        const row = updated.find((line) => line.direction === direction && !line.target);
        const target = options.find((option) => option.active && fits(option))?.key;
        if (row && target) updated = updated.map((line) => line.row === row.row ? { ...line, target } : line);
      };
      const nextSides = voucherSides(next.type);
      if (nextSides) suggest(nextSides.settlement, (option) => allows(next, nextSides.settlement, option));
      else if (next.type === "VR") suggest("debit", (option) => option.control === "cash");
      return updated;
    });
  };
  return <FinanceForm action={saveVoucherAction} companyId={companyId} id={id} version={version} successTo={`${base}/vouchers/{id}`} className="acc-entry"
    submit={isPosted ? [{ label: "Post revised voucher", value: "post" }] : [
      { label: "Save draft", value: "draft", variant: "outline" },
      ...(approval ? [{ label: "Submit for approval", value: "submit" } as const] : canPost ? [{ label: "Post voucher", value: "post" } as const] : []),
    ]}>
    <input type="hidden" name="entry" value={JSON.stringify({ ...header, lines: payload })} />
    <section className="panel acc-card">
      <div className="acc-card-head"><span className="acc-card-icon" aria-hidden><FileText size={18} /></span>
        <div className="acc-card-title"><h2>Voucher details</h2><p>Type, date and reference printed on the voucher</p></div></div>
      <div className="form-grid acc-form-grid acc-cols-4">
        <label className="field">Voucher type<select disabled={!!id} value={header.type} onChange={(event) => retype({ ...header, type: event.target.value as VoucherInput["type"] })}>
          {manualTypes.map((type) => <option key={type}>{type}</option>)}
        </select></label>
        <label className="field">Accounting date<input type="date" value={header.date} onChange={(event) => setHeader({ ...header, date: event.target.value })} required /></label>
        <label className="field">Reference<input value={header.reference} onChange={(event) => setHeader({ ...header, reference: event.target.value })} maxLength={120} /></label>
        {!["JV", "VR"].includes(header.type) && <label className="field">Payment or receipt mode<select value={header.mode}
          onChange={(event) => retype({ ...header, mode: event.target.value as VoucherInput["mode"] })}>
          <option value="party">Customer or supplier</option><option value="direct">Direct account</option>
        </select></label>}
        <label className="field field-wide">Narration<textarea rows={2} value={header.narration} onChange={(event) => setHeader({ ...header, narration: event.target.value })} maxLength={1000} /></label>
      </div>
    </section>
    <section className="panel acc-card acc-lines-card">
      <div className="acc-card-head"><span className="acc-card-icon" aria-hidden><Rows3 size={18} /></span>
        <div className="acc-card-title"><h2>Journal lines</h2><p>{typeHelp[header.type]} Type any part of a name or code and press Enter; typos and initials work too.</p></div>
        <div className="acc-card-actions"><span className="pill">{lines.length} {lines.length === 1 ? "line" : "lines"}</span></div></div>
      <div className="table-scroll acc-sheet">
        <table className="entry-table acc-grid acc-voucher-grid"><thead><tr><th className="acc-grid-no" scope="col">#</th><th scope="col">Side</th><th scope="col">Account or party</th>
          <th scope="col" className="acc-num">Debit (PKR)</th><th scope="col" className="acc-num">Credit (PKR)</th><th scope="col">Line description</th><th aria-label="Remove line" /></tr></thead>
          <tbody>{lines.map((line, index) => {
            const chosen = selectors.get(line.target);
            const amount = <input className="acc-amount" aria-label={`Amount line ${index + 1}`} inputMode="decimal" value={line.amount} maxLength={21} placeholder="0.00"
              onChange={(event) => edit(line.row, { amount: event.target.value })} />;
            return <tr key={line.row} className={line.direction === "debit" ? "acc-line-dr" : "acc-line-cr"}>
              <td className="acc-grid-no">{index + 1}</td>
              <td><select className="acc-side" aria-label={`Side line ${index + 1}`} value={line.direction} onChange={(event) => {
                const direction = event.target.value as Line["direction"];
                edit(line.row, { direction, target: allows(header, direction, chosen) ? line.target : "" });
              }}>
                <option value="debit">{sideLabel("debit")}</option><option value="credit">{sideLabel("credit")}</option>
              </select></td>
              <td className="acc-grid-account"><SearchSelect value={line.target} options={lineChoices[line.direction]} label={`Account or party line ${index + 1}`}
                placeholder={`Search ${wanted(line.direction)}`} emptyText={`No ${wanted(line.direction)} matches`}
                invalidLabel={chosen && !allows(header, line.direction, chosen) ? `${chosen.label} (${chosen.active ? `not allowed for ${header.type}` : "inactive"})` : undefined}
                onChange={(target) => edit(line.row, { target })}
                onCommit={(input) => input.closest("tr")?.querySelector<HTMLInputElement>("input[inputmode=decimal]")?.focus()} />
              {chosen?.balance !== null && chosen?.balance !== undefined &&
                <small className="acc-line-balance">Current party balance {balanceLabel(chosen.balance)}</small>}</td>
              <td className="acc-num acc-grid-amount">{line.direction === "debit" ? amount : <span className="acc-grid-blank" aria-hidden>—</span>}</td>
              <td className="acc-num acc-grid-amount">{line.direction === "credit" ? amount : <span className="acc-grid-blank" aria-hidden>—</span>}</td>
              <td><input aria-label={`Description line ${index + 1}`} value={line.description} maxLength={250}
                onChange={(event) => edit(line.row, { description: event.target.value })} /></td>
              <td><button className="icon-button acc-remove" type="button" title={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((candidate) => candidate.row !== line.row))}><Trash2 size={16} /></button></td>
            </tr>;
          })}</tbody>
          <tfoot><tr className="acc-total-row">
            <td colSpan={3}><strong>Totals</strong></td>
            <td className="acc-num"><strong>{formatMoney(dr.toFixed(2))}</strong></td><td className="acc-num"><strong>{formatMoney(cr.toFixed(2))}</strong></td>
            <td colSpan={2}><span role="status" className={`status ${balanced ? dr.isZero() ? "acc-status-neutral" : "status-posted" : "acc-status-void"}`}>
              <span className="sr-only">Debit {formatMoney(dr.toFixed(2))} · Credit {formatMoney(cr.toFixed(2))} · </span>
              {balanced ? dr.isZero() ? "No amounts yet" : "Balanced" : <>Difference {formatMoney(dr.minus(cr).toFixed(2))}</>}</span></td>
          </tr></tfoot>
        </table>
      </div>
      <div className="acc-grid-footer">
        <Button type="button" variant="outline" className="button-small" disabled={lines.length >= 100} onClick={() => add("debit")}><Plus size={15} /> Add {sideLabel("debit").toLowerCase()} line</Button>
        <Button type="button" variant="outline" className="button-small" disabled={lines.length >= 100} onClick={() => add("credit")}><Plus size={15} /> Add {sideLabel("credit").toLowerCase()} line</Button>
        <dl className="acc-balance">
          <div><dt>Total debit</dt><dd>{formatMoney(dr.toFixed(2))}</dd></div>
          <div><dt>Total credit</dt><dd>{formatMoney(cr.toFixed(2))}</dd></div>
          <div className={balanced ? "acc-balance-ok" : "acc-balance-off"}><dt>Difference</dt><dd>{formatMoney(dr.minus(cr).toFixed(2))}</dd></div>
        </dl>
      </div>
      {isPosted && <label className="field acc-reason">Revision reason<input name="reason" required minLength={3} maxLength={500} /></label>}
    </section>
    {!isPosted && <input type="hidden" name="reason" value="" />}
  </FinanceForm>;
}
