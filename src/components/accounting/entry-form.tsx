"use client";

import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { saveVoucherAction } from "@/lib/engine/actions";
import { Exact, manualTypes, type EntryLine, type VoucherInput } from "@/lib/engine/model";
import { formatMoney } from "@/lib/display";
import { FinanceForm } from "./finance-form";
import { Button } from "../ui/button";

export type Selector = { key: string; accountId: string; partyId: string | null; label: string; active: boolean; liquidity: string | null; control: string | null; balance: string | null };
type Line = { row: number; target: string; direction: "debit" | "credit"; amount: string; description: string };
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
  return <FinanceForm action={saveVoucherAction} companyId={companyId} id={id} version={version} successTo={`${base}/vouchers/{id}`}
    submit={isPosted ? [{ label: "Post revised voucher", value: "post" }] : [
      { label: "Save draft", value: "draft", variant: "outline" },
      ...(approval ? [{ label: "Submit for approval", value: "submit" } as const] : canPost ? [{ label: "Post voucher", value: "post" } as const] : []),
    ]}>
    <input type="hidden" name="entry" value={JSON.stringify({ ...header, lines: payload })} />
    <div className="form-grid">
      <label className="field">Voucher type<select disabled={!!id} value={header.type} onChange={(event) => setType(event.target.value as VoucherInput["type"])}>
        {manualTypes.map((type) => <option key={type}>{type}</option>)}
      </select></label>
      <label className="field">Accounting date<input type="date" value={header.date} onChange={(event) => setHeader({ ...header, date: event.target.value })} required /></label>
      <label className="field">Reference<input value={header.reference} onChange={(event) => setHeader({ ...header, reference: event.target.value })} maxLength={120} /></label>
      {!["JV", "VR"].includes(header.type) && <label className="field">Payment or receipt mode<select value={header.mode}
        onChange={(event) => setHeader({ ...header, mode: event.target.value as VoucherInput["mode"] })}>
        <option value="party">Customer or supplier</option><option value="direct">Direct account</option>
      </select></label>}
      <label className="field field-wide">Narration<textarea value={header.narration} onChange={(event) => setHeader({ ...header, narration: event.target.value })} maxLength={1000} /></label>
    </div>
    <div className="table-scroll mt-5">
      <table className="entry-table"><thead><tr><th>Side</th><th>Account or party</th><th>Amount (PKR)</th><th>Line description</th><th aria-label="Remove line" /></tr></thead>
        <tbody>{lines.map((line, index) => {
          const chosen = selectors.get(line.target);
          return <tr key={line.row}>
            <td><select aria-label={`Side line ${index + 1}`} value={line.direction} onChange={(event) => edit(line.row, { direction: event.target.value as Line["direction"] })}>
              <option value="debit">Debit</option><option value="credit">Credit</option>
            </select></td>
            <td><select aria-label={`Account or party line ${index + 1}`} value={line.target} onChange={(event) => edit(line.row, { target: event.target.value })}>
              <option value="">Choose account or party</option>
              {chosen && !chosen.active && <option value={chosen.key}>{chosen.label} (inactive)</option>}
              <optgroup label="Accounts">{options.filter((option) => !option.partyId && option.active).map((option) =>
                <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
              <optgroup label="Customers and suppliers">{options.filter((option) => option.partyId && option.active).map((option) =>
                <option key={option.key} value={option.key}>{option.label}</option>)}</optgroup>
            </select>{chosen?.balance !== null && chosen?.balance !== undefined &&
              <small className="muted block">Current party balance {balanceLabel(chosen.balance)}</small>}</td>
            <td><input aria-label={`Amount line ${index + 1}`} inputMode="decimal" value={line.amount} maxLength={21}
              onChange={(event) => edit(line.row, { amount: event.target.value })} /></td>
            <td><input aria-label={`Description line ${index + 1}`} value={line.description} maxLength={250}
              onChange={(event) => edit(line.row, { description: event.target.value })} /></td>
            <td><button className="icon-button" type="button" title={`Remove line ${index + 1}`} onClick={() => setLines((current) => current.filter((candidate) => candidate.row !== line.row))}><Trash2 size={16} /></button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="finance-toolbar mt-4">
      <Button type="button" variant="outline" disabled={lines.length >= 100} onClick={() => add("debit")}><Plus size={16} /> Add debit line</Button>
      <Button type="button" variant="outline" disabled={lines.length >= 100} onClick={() => add("credit")}><Plus size={16} /> Add credit line</Button>
      <span className={dr.eq(cr) ? "muted" : "form-error"} role="status">Debit {formatMoney(dr.toFixed(2))} · Credit {formatMoney(cr.toFixed(2))} · Difference {formatMoney(dr.minus(cr).toFixed(2))}</span>
    </div>
    {isPosted && <label className="field mt-5">Revision reason<input name="reason" required minLength={3} maxLength={500} /></label>}
    {!isPosted && <input type="hidden" name="reason" value="" />}
  </FinanceForm>;
}
