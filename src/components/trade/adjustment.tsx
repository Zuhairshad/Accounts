"use client";

import { useState } from "react";
import { FinanceForm } from "@/components/accounting/finance-form";
import { adjustmentAction } from "@/lib/trade/actions";
import { adjustmentKinds, adjustmentNames, type AdjustmentInput } from "@/lib/trade/model";
import { Exact } from "@/lib/engine/model";

export function AdjustmentEditor({ companyId, base, id, version, today, canApprove, input, options, defaultItem }: {
  companyId: string; base: string; id?: string; version: number; today: string; canApprove: boolean;
  input?: AdjustmentInput; options: { id: string; name: string; qty: string; unit: string; average: string }[]; defaultItem?: string;
}) {
  const [kind, setKind] = useState<AdjustmentInput["kind"]>(input?.kind ?? "count");
  const [item, setItem] = useState(input?.itemId ?? defaultItem ?? "");
  const [date, setDate] = useState(input?.date ?? today);
  const [physical, setPhysical] = useState(input?.physical ?? "");
  const selected = options.find((option) => option.id === item);
  const count = ["count","opening_correction"].includes(kind);
  const inbound = count || ["add","excess","opening"].includes(kind);
  const fixed = !!id;
  let difference: string | undefined;
  if (count && selected && date === today && /^\d+(?:\.\d{0,6})?$/.test(physical)) difference = new Exact(physical).minus(selected.qty).toString();
  return <FinanceForm action={adjustmentAction} companyId={companyId} id={id} version={version} successTo={`${base}/adjustments/{id}`}
    submit={[{ label: fixed ? "Post revised adjustment" : "Post adjustment" }]}>
    {fixed && <><input type="hidden" name="itemId" value={item} /><input type="hidden" name="kind" value={kind} /></>}
    <div className="form-grid trade-form-grid">
      <label className="field">Item<select name={fixed ? undefined : "itemId"} value={item} required disabled={fixed}
        onChange={(event) => setItem(event.target.value)}><option value="">Choose stock item</option>{options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}
      </select></label>
      <label className="field">Adjustment type<select name={fixed ? undefined : "kind"} value={kind} disabled={fixed}
        onChange={(event) => setKind(event.target.value as AdjustmentInput["kind"])}>
        {adjustmentKinds.filter((value) => canApprove || value !== "valuation").map((value) => <option key={value} value={value}>{adjustmentNames[value]}</option>)}
      </select></label>
      <label className="field">Adjustment date<input type="date" name="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
      <label className="field">Supporting reference<input name="reference" defaultValue={input?.reference} maxLength={120} /></label>
      {count ? <label className="field">Physical quantity<input name="physical" inputMode="decimal" value={physical} onChange={(event) => setPhysical(event.target.value)} required /></label> :
        kind !== "valuation" && <label className="field">Adjustment quantity<input name="quantity" inputMode="decimal" defaultValue={input?.quantity} required /></label>}
      {/* Added units default to the item's current average cost; a zero default would silently lower the average. */}
      {inbound && <label className="field">Cost per added unit (PKR)<input key={item} name="rate" inputMode="decimal" required
        defaultValue={input?.rate ?? (kind !== "opening" && selected ? new Exact(selected.average || "0").toDecimalPlaces(2, Exact.ROUND_HALF_UP).toFixed() : "")} /></label>}
      {kind === "valuation" && <label className="field">Signed change in value (PKR)<input name="valueChange" inputMode="decimal" defaultValue={input?.valueChange} required /></label>}
      <label className="field field-wide">Reason<textarea name="reason" defaultValue={input?.reason} required minLength={3} maxLength={500} /></label>
    </div>
    {selected && <p className="trade-hint mt-3">System quantity today {new Exact(selected.qty).toString()} {selected.unit}.
      {difference !== undefined ? ` Difference ${difference} ${selected.unit}.` : date !== today ? " The posting checks the quantity at the accounting date." : ""}</p>}
  </FinanceForm>;
}
