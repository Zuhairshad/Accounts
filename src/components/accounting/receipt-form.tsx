"use client";

import { useState } from "react";
import { recordReceiptAction } from "@/lib/engine/actions";
import { FinanceForm } from "./finance-form";

type Option = { id: string; name: string };

/** Amount received from a customer. The executive follows the customer's latest sale until the user picks one. */
export function ReceiptForm({ companyId, base, customers, accounts, executives, defaults, today, approval }: {
  companyId: string; base: string; customers: Option[]; accounts: (Option & { liquidity: string })[]; executives: Option[];
  defaults: Record<string, string>; today: string; approval: boolean;
}) {
  const [partyId, setPartyId] = useState("");
  const [executive, setExecutive] = useState("");
  const [chosen, setChosen] = useState(false);
  const active = new Set(executives.map((entry) => entry.id));
  return <FinanceForm action={recordReceiptAction} companyId={companyId} successTo={`${base}/vouchers/{id}`}
    submit={[{ label: approval ? "Submit receipt for approval" : "Post receipt" }]}>
    <div className="form-grid acc-form-grid acc-cols-3">
      <label className="field">Received date<input type="date" name="date" defaultValue={today} required /></label>
      <label className="field">Customer<select name="partyId" value={partyId} required onChange={(event) => {
        setPartyId(event.target.value);
        const suggested = defaults[event.target.value];
        if (!chosen) setExecutive(suggested && active.has(suggested) ? suggested : "");
      }}><option value="">Select customer</option>{customers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label className="field">Received into<select name="accountId" defaultValue="" required>
        <option value="">Select cash or bank account</option>
        {accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} ({entry.liquidity === "cash" ? "CRV" : "BRV"})</option>)}
      </select></label>
      <label className="field">Amount received (PKR)<input name="amount" inputMode="decimal" maxLength={21} required /></label>
      <label className="field">Sales executive<select name="salesExecutiveId" value={executive}
        onChange={(event) => { setExecutive(event.target.value); setChosen(true); }}>
        <option value="">No sales executive</option>{executives.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>
      <label className="field">Reference<input name="reference" maxLength={120} /></label>
      <label className="field field-wide">Narration<textarea name="narration" rows={2} maxLength={1000} placeholder="Amount received · customer name" /></label>
    </div>
    {partyId && defaults[partyId] && executive === defaults[partyId] && !chosen &&
      <p className="acc-note">Sales executive taken from this customer&apos;s most recent sale.</p>}
  </FinanceForm>;
}
