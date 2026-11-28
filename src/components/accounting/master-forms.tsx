"use client";

import { useState } from "react";
import type { accounts, parties } from "@/db/schema";
import { saveAccountAction, savePartyAction } from "@/lib/engine/actions";
import { FinanceForm } from "./finance-form";

type Account = typeof accounts.$inferSelect;
type Party = typeof parties.$inferSelect;
export type Opening = { date: string; direction: "debit" | "credit"; amount: string; version: number };

export function AccountForm({ companyId, account, heads, base }: { companyId: string; account?: Account; heads: Account[]; base: string }) {
  const [type, setType] = useState<Account["type"]>(account?.type ?? "asset");
  return <FinanceForm action={saveAccountAction} companyId={companyId} id={account?.id} version={account?.version ?? 0}
    submit={[{ label: account ? "Save account" : "Create account" }]} successTo={account ? undefined : `${base}/chart/{id}`}>
    <div className="form-grid acc-form-grid acc-cols-3">
      <label className="field">Account code<input name="code" defaultValue={account?.code} required maxLength={24} /></label>
      <label className="field">Account name<input name="name" defaultValue={account?.name} required maxLength={120} /></label>
      <label className="field">Classification<select name="type" value={type} onChange={(e) => setType(e.target.value as Account["type"])}>
        {["asset","liability","equity","income","expense"].map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
      </select></label>
      <label className="field">Parent account<select name="parentId" defaultValue={account?.parentId ?? ""}>
        <option value="">Main head</option>{heads.filter((head) => head.active && head.type === type && head.id !== account?.id)
          .map((head) => <option value={head.id} key={head.id}>{head.code} · {head.name}</option>)}
      </select></label>
      <label className="field">Liquidity<select name="liquidity" defaultValue={account?.liquidity ?? ""}>
        <option value="">General account</option><option value="cash">Cash account</option><option value="bank">Bank account</option>
      </select></label>
      <label className="field">Account status<select name="active" defaultValue={String(account?.active ?? true)}>
        <option value="true">Active</option><option value="false">Inactive</option>
      </select></label>
    </div>
    {account?.control && <p className="acc-note">System account · {account.control.replaceAll("_", " ")}</p>}
  </FinanceForm>;
}

export function PartyForm({ companyId, party, opening, today, canPost, base }: {
  companyId: string; party?: Party; opening?: Opening; today: string; canPost: boolean; base: string;
}) {
  const [type, setType] = useState(party?.type ?? "customer");
  const [direction, setDirection] = useState(opening?.direction ?? (type === "customer" ? "debit" : "credit"));
  const [showOpening, setShowOpening] = useState(false);
  return <FinanceForm action={savePartyAction} companyId={companyId} id={party?.id} version={party?.version ?? 0}
    submit={[{ label: party ? "Save party" : "Create party" }]} successTo={party ? undefined : `${base}/parties/{id}`}>
    <div className="acc-form-section"><h3>Party details</h3>
      <div className="form-grid acc-form-grid acc-cols-3">
        <label className="field">Party name<input name="name" defaultValue={party?.name} required maxLength={160} /></label>
        <label className="field">Classification<select name="type" value={type} onChange={(event) => {
          const value = event.target.value as Party["type"];
          setType(value);
          if (!opening) setDirection(value === "customer" ? "debit" : "credit");
        }}><option value="customer">Customer</option><option value="supplier">Supplier</option></select></label>
        <label className="field">Party status<select name="active" defaultValue={String(party?.active ?? true)}><option value="true">Active</option><option value="false">Inactive</option></select></label>
      </div></div>
    <div className="acc-form-section"><h3>Contact</h3>
      <div className="form-grid acc-form-grid acc-cols-3">
        <label className="field">Contact person<input name="contact" defaultValue={party?.contact} maxLength={120} /></label>
        <label className="field">Phone<input name="phone" type="tel" defaultValue={party?.phone} maxLength={60} /></label>
        <label className="field">Email<input name="email" type="email" defaultValue={party?.email} maxLength={200} /></label>
        <label className="field field-wide">Billing address<textarea name="address" rows={2} defaultValue={party?.address} maxLength={500} /></label>
      </div></div>
    <div className="acc-form-section"><h3>Tax and credit</h3>
      <div className="form-grid acc-form-grid acc-cols-4">
        <label className="field">NTN<input name="ntn" defaultValue={party?.ntn} maxLength={60} /></label>
        <label className="field">STRN<input name="strn" defaultValue={party?.strn} maxLength={60} /></label>
        <label className="field">Credit terms (days)<input name="creditDays" type="number" min="0" max="3650" defaultValue={party?.creditDays ?? 0} required /></label>
        <label className="field">Credit limit (PKR)<input name="creditLimit" inputMode="decimal" defaultValue={party?.creditLimit ?? "0"} required maxLength={21} /></label>
        <label className="field field-wide">Notes<textarea name="notes" rows={2} defaultValue={party?.notes} maxLength={1000} /></label>
      </div></div>
    <div className="acc-form-section acc-opening">
      <div className="acc-opening-head"><h2>Opening balance</h2>
        {opening && <p className="status acc-status-neutral">PKR {opening.amount} {opening.direction === "debit" ? "Dr" : "Cr"}</p>}</div>
      {canPost && <label className="acc-check"><input type="checkbox" name="saveOpening" value="true" checked={showOpening}
        onChange={(event) => setShowOpening(event.target.checked)} /> Save opening balance with party</label>}
      {showOpening && <div className="form-grid acc-form-grid acc-cols-4">
        <input name="openingVersion" type="hidden" value={opening?.version ?? 0} />
        <label className="field">Opening balance date<input name="openingDate" type="date" defaultValue={opening?.date ?? today} required /></label>
        <label className="field">Opening balance direction<select name="openingDirection" value={direction}
          onChange={(event) => setDirection(event.target.value as Opening["direction"])}><option value="debit">Debit</option><option value="credit">Credit</option></select></label>
        <label className="field">Opening balance amount<input name="openingAmount" inputMode="decimal" maxLength={21} defaultValue={opening?.amount ?? "0"} required /></label>
        <label className="field">Opening reason<input name="openingReason" required minLength={3} maxLength={500} /></label>
      </div>}
    </div>
  </FinanceForm>;
}
