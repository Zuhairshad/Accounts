"use client";

import { useRef, useState } from "react";
import { FileText, Plus, Rows3, Trash2 } from "lucide-react";
import { saveVoucherAction } from "@/lib/engine/actions";
import { Exact, manualTypes, type EntryLine, type VoucherInput } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { FinanceForm } from "./finance-form";
import { Button } from "../ui/button";

export type Selector = { key: string; accountId: string; partyId: string | null; label: string; active: boolean; liquidity: string | null; control: string | null; balance: string | null };
type Line = { row: number; target: string; direction: "debit" | "credit"; amount: string; description: string };
/** Case-insensitive substring match on every word, so "rec ali" finds "1100 Accounts Receivable · Ali Traders". */
export const matchesSearch = (query: string, label: string) => {
  const text = label.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every((word) => text.includes(word));
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
  const [finds, setFinds] = useState<Record<number, string>>({});
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
  const payload: EntryLine[] = lines.filter((line) => line.target || line.amount || line.description).map((line) => {
    const option = selectors.get(line.target);
    return { accountId: option?.accountId ?? "", partyId: option?.partyId ?? null, description: line.description,
      debit: line.direction === "debit" ? line.amount || "0" : "0", credit: line.direction === "credit" ? line.amount || "0" : "0" };
  });
  const total = (side: "debit" | "credit") => payload.reduce((sum, line) => {
    return /^\d+(?:\.\d{0,2})?$/.test(line[side]) ? sum.plus(line[side]) : sum;
  }, new Exact(0));
  const dr = total("debit");
  const cr = total("credit");
  const balanced = dr.eq(cr);
  const edit = (row: number, update: Partial<Line>) => setLines((current) => current.map((line) => line.row === row ? { ...line, ...update } : line));
  const add = (direction: "debit" | "credit") => setLines((current) => [
    ...current, { row: nextLine.current++, target: "", direction, amount: "", description: "" },
  ]);
  const setType = (type: VoucherInput["type"]) => {
    setHeader({ ...header, type });
    if (type === "JV") return;
    if (type === "VR") {
      const suggestions = { debit: "cash", credit: "sales" };
      setLines((current) => current.map((line, index) => {
        if (index > 1 || line.target) return line;
        const target = options.find((option) => option.active && option.control === suggestions[line.direction])?.key;
        return target ? { ...line, target } : line;
      }));
      return;
    }
    const direction = type.endsWith("RV") ? "debit" : "credit";
    const liquidity = type.startsWith("C") ? "cash" : "bank";
    const target = options.find((option) => option.active && option.liquidity === liquidity)?.key;
    const row = lines.find((line) => line.direction === direction && !line.target);
    if (target && row) edit(row.row, { target });
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
        <label className="field">Voucher type<select disabled={!!id} value={header.type} onChange={(event) => setType(event.target.value as VoucherInput["type"])}>
          {manualTypes.map((type) => <option key={type}>{type}</option>)}
        </select></label>
        <label className="field">Accounting date<input type="date" value={header.date} onChange={(event) => setHeader({ ...header, date: event.target.value })} required /></label>
        <label className="field">Reference<input value={header.reference} onChange={(event) => setHeader({ ...header, reference: event.target.value })} maxLength={120} /></label>
        {!["JV", "VR"].includes(header.type) && <label className="field">Payment or receipt mode<select value={header.mode}
          onChange={(event) => setHeader({ ...header, mode: event.target.value as VoucherInput["mode"] })}>
          <option value="party">Customer or supplier</option><option value="direct">Direct account</option>
        </select></label>}
        <label className="field field-wide">Narration<textarea rows={2} value={header.narration} onChange={(event) => setHeader({ ...header, narration: event.target.value })} maxLength={1000} /></label>
      </div>
    </section>
    <section className="panel acc-card acc-lines-card">
      <div className="acc-card-head"><span className="acc-card-icon" aria-hidden><Rows3 size={18} /></span>
        <div className="acc-card-title"><h2>Journal lines</h2><p>Type to search an account or party and press Enter. Enter in a cell moves to the next one.</p></div>
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
              <td><select className="acc-side" aria-label={`Side line ${index + 1}`} value={line.direction} onChange={(event) => edit(line.row, { direction: event.target.value as Line["direction"] })}>
                <option value="debit">Debit</option><option value="credit">Credit</option>
              </select></td>
              <td className="acc-grid-account">{(() => {
                const query = finds[line.row] ?? "";
                const visible = options.filter((option) => option.active && (option.key === line.target || matchesSearch(query, option.label)));
                return <>
                  <input type="search" className="line-find" aria-label={`Find account or party line ${index + 1}`} placeholder="Type to search, Enter to choose"
                    value={query} onChange={(event) => setFinds({ ...finds, [line.row]: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const match = visible.find((option) => option.key !== line.target) ?? visible[0];
                      if (match) {
                        edit(line.row, { target: match.key });
                        setFinds({ ...finds, [line.row]: "" });
                        event.currentTarget.closest("tr")?.querySelector<HTMLInputElement>("input[inputmode=decimal]")?.focus();
                      }
                    }} />
                  <select aria-label={`Account or party line ${index + 1}`} value={line.target} onChange={(event) => edit(line.row, { target: event.target.value })}>
                    <option value="">{query && !visible.length ? "No match" : "Choose account or party"}</option>
                    {chosen && !chosen.active && <option value={chosen.key}>{chosen.label} (inactive)</option>}
                    <optgroup label="Accounts">{visible.filter((option) => !option.partyId).map((option) =>
                      <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
                    <optgroup label="Customers and suppliers">{visible.filter((option) => option.partyId).map((option) =>
                      <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
                  </select></>;
              })()}{chosen?.balance !== null && chosen?.balance !== undefined &&
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
        <Button type="button" variant="outline" className="button-small" disabled={lines.length >= 100} onClick={() => add("debit")}><Plus size={15} /> Add debit line</Button>
        <Button type="button" variant="outline" className="button-small" disabled={lines.length >= 100} onClick={() => add("credit")}><Plus size={15} /> Add credit line</Button>
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
