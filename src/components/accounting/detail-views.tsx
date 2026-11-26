import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { Copy, Download, Printer } from "lucide-react";
import { getDb } from "@/db";
import { accounts, companySettings, parties } from "@/db/schema";
import {
  allocateAction, releaseAction, repairPartyAction, transitionVoucherAction,
} from "@/lib/engine/actions";
import { accountDate, Exact, manualType, manualVoucher, type EntryLine, type VoucherInput } from "@/lib/engine/model";
import { journalSelectors, openingRows, partyBalances, readLedger, readVoucher } from "@/lib/engine/read";
import { activeAllocations, invoiceOutstanding, paymentSources } from "@/lib/engine/settlement";
import { formatMoney } from "@/lib/display";
import { first, resolveRange } from "@/lib/range";
import { displayDate, karachiToday } from "@/lib/validation";
import { VoucherEditor } from "./entry-form";
import { AccountForm, PartyForm } from "./master-forms";
import { FinanceForm } from "./finance-form";
import { DateFilters, Ledger, Money, PageHeading, PanelTable, sided } from "./finance-ui";
import { InvoiceAging, type Screen } from "./index-views";
import { Button } from "../ui/button";

const overview = async (companyId: string) => (await getDb().select().from(companySettings).where(eq(companySettings.companyId, companyId)))[0];

export type ViewVoucher = NonNullable<Awaited<ReturnType<typeof readVoucher>>>;

export function entryFrom(voucher: ViewVoucher): VoucherInput | undefined {
  const draft = manualVoucher.safeParse((voucher.doc?.draft as { entry?: unknown } | undefined)?.entry);
  if (draft.success) return draft.data;
  const type = manualType.safeParse(voucher.type);
  if (!type.success) return undefined;
  return {
    type: type.data, date: voucher.date, reference: voucher.reference, narration: voucher.narration,
    mode: voucher.postedLines.some((line) => line.partyId) ? "party" : "direct", lines: voucher.postedLines,
  };
}

export async function VoucherEntry(screen: Screen, id?: string, copyId?: string) {
  const { companyId, base, companyName, permissions } = screen;
  const [settings, source, options] = await Promise.all([
    overview(companyId), id || copyId ? readVoucher(getDb(), companyId, (id ?? copyId)!) : null,
    journalSelectors(getDb(), companyId, karachiToday()),
  ]);
  const entry = source ? entryFrom(source) : undefined;
  if (id && (!permissions.includes("edit") || !source || source.status === "void" || source.readOnlyOrigin || !entry ||
    (source.status === "posted" && (!permissions.includes("post") || (settings.voucherApproval && !permissions.includes("approve")))))) notFound();
  if (!id && (!permissions.includes("create") || (copyId && (!entry || source?.readOnlyOrigin)))) notFound();
  return <>
    <PageHeading title={id ? "Edit voucher" : copyId ? "Duplicate as new voucher" : "New voucher"} company={companyName}
      toolbar={<Button asChild variant="outline"><Link href={id ? `${base}/vouchers/${id}` : `${base}/vouchers`}>Cancel</Link></Button>} />
    <section className="panel">
      <VoucherEditor companyId={companyId} base={base} options={options} version={id ? source!.version : 0} id={id}
        entry={entry ? { ...entry, date: copyId ? karachiToday() : entry.date } : {
          type: "JV", date: karachiToday(), reference: "", narration: "", mode: "party", lines: [],
        }} approval={settings.voucherApproval} canPost={permissions.includes("post")} isPosted={!!id && source?.status === "posted"} />
    </section>
  </>;
}

export async function VoucherDetail(screen: Screen, voucher: ViewVoucher) {
  const { companyId, base, companyName, permissions } = screen;
  const { id, number, type, date, status, version } = voucher;
  const [settings, current, history] = await Promise.all([
    overview(companyId), partyBalances(getDb(), companyId, karachiToday()),
    getDb().execute<{ id: string; date: string; actor: string; reason: string; previous: unknown; next: unknown }>(sql`
      SELECT r.id, (r.created_at AT TIME ZONE 'Asia/Karachi')::text AS date, u.display_name AS actor,
        r.reason, r.previous_data AS previous, r.next_data AS next
      FROM transaction_revisions r JOIN users u ON u.id=r.actor_id
      WHERE r.company_id=${companyId} AND r.entity_type='voucher' AND r.entity_id=${id} ORDER BY r.version DESC
    `),
  ]);
  const entry = entryFrom(voucher);
  const lines: (EntryLine & { account?: string; party?: string | null })[] = voucher.postedLines.length ? voucher.postedLines : entry?.lines ?? [];
  const options = voucher.postedLines.length || !lines.length ? [] : await journalSelectors(getDb(), companyId, karachiToday());
  const total = (side: "debit" | "credit") => lines.reduce((sum, line) => sum.plus(line[side]), new Exact(0)).toFixed(2);
  const approvalRight = !settings.voucherApproval || permissions.includes("approve");
  const managed = voucher.doc?.source === "manual";
  const legacyManual = !voucher.doc && !voucher.readOnlyOrigin && manualType.safeParse(type).success;
  const repairable = legacyManual && voucher.postedLines.some((line) => ["receivable","payable"].includes(line.control ?? "") && !line.partyId);
  const canEdit = (managed || (legacyManual && !repairable)) && status !== "void" && permissions.includes("edit") &&
    (status !== "posted" || (permissions.includes("post") && approvalRight));
  const canPost = status === "draft" && managed && permissions.includes("post") && approvalRight &&
    (!settings.voucherApproval || !!voucher.doc?.submittedBy && voucher.doc?.submittedBy !== screen.actorId && voucher.doc?.createdBy !== screen.actorId);
  const canVoid = (managed || (legacyManual && !repairable)) && status !== "void" && permissions.includes("delete") && (status !== "posted" || approvalRight);
  const canRestore = (managed || voucher.doc?.source === "opening") && status === "void" &&
    permissions.includes("restore") && (!voucher.doc?.currentVoucherId || (permissions.includes("post") && approvalRight));
  const needsRepair = repairable
    ? voucher.postedLines.filter((line) => ["receivable","payable"].includes(line.control ?? "") && !line.partyId) : [];
  const pdf = `/api/accounting/${companyId}/vouchers/${id}`;
  return <>
    <PageHeading title={number ?? `${type} draft`} company={companyName} toolbar={<>
      <Button variant="outline" asChild><Link href={`${base}/vouchers`}>Voucher register</Link></Button>
      {voucher.doc?.sourceId && ["invoice","inventory_adjustment"].includes(voucher.doc.source) &&
        <Button variant="outline" asChild><Link href={`/workspace/${companyId}/trade/${voucher.doc.source === "invoice" ? "invoices" : "adjustments"}/${voucher.doc.sourceId}`}>Originating document</Link></Button>}
      {canEdit && <Button variant="outline" asChild><a href={`${base}/vouchers/${id}?edit=1`}>Edit voucher</a></Button>}
      {entry && !voucher.readOnlyOrigin && permissions.includes("create") &&
        <Button variant="outline" asChild><a href={`${base}/vouchers/new?copy=${id}`}><Copy size={16} /> Duplicate as new</a></Button>}
      {permissions.includes("print") && <Button variant="outline" asChild><a href={`${pdf}?inline=1`} target="_blank" rel="noreferrer"><Printer size={16} /> Print voucher</a></Button>}
      {permissions.includes("export") && <Button variant="outline" asChild><a href={pdf}><Download size={16} /> Download PDF</a></Button>}
    </>} />
    <section className="panel"><dl className="finance-detail">
      <div><dt>Accounting date</dt><dd>{displayDate(date)}</dd></div>
      <div><dt>Voucher type</dt><dd>{type}</dd></div>
      <div><dt>Status</dt><dd className="capitalize">{status === "void" ? "Voided" : status === "draft" && voucher.doc?.submittedBy ? "Awaiting approval" : status}</dd></div>
      <div><dt>Reference</dt><dd>{voucher.reference || "—"}</dd></div>
      <div><dt>Narration</dt><dd>{entry?.narration || voucher.narration || "—"}</dd></div>
    </dl></section>
    <PanelTable title="Journal lines" headers={["Account","Party","Description","Debit (PKR)","Credit (PKR)","Current party balance"]}
      empty={!lines.length ? "No lines entered" : undefined}>
      {lines.map((line, index) => {
        const option = options.find((item) => item.accountId === line.accountId && item.partyId === line.partyId);
        const party = current.find((candidate) => candidate.id === line.partyId);
        return <tr key={index}><td>{line.account ?? option?.label ?? "Account"}</td><td>{line.party ?? party?.name ?? "—"}</td><td>{line.description || "—"}</td>
          <Money value={line.debit} /><Money value={line.credit} /><td>{party ? sided(party.balance) : "—"}</td></tr>;
      })}
      <tr><td colSpan={3}><strong>Totals</strong></td><Money value={total("debit")} /><Money value={total("credit")} /><td /></tr>
    </PanelTable>
    {(canPost || canVoid || canRestore || (managed && status === "draft" && !voucher.doc?.submittedBy && settings.voucherApproval && permissions.includes("edit"))) &&
      <section className="panel print-hide"><h2>Transaction actions</h2>
        {settings.voucherApproval && status === "draft" && !voucher.doc?.submittedBy && permissions.includes("edit") && <Transition screen={screen} id={id} version={version} operation="submit" label="Submit for approval" />}
        {canPost && <Transition screen={screen} id={id} version={version} operation="post" label={settings.voucherApproval ? "Approve and post" : "Post voucher"} />}
        {canVoid && <Transition screen={screen} id={id} version={version} operation="delete" label="Void voucher" />}
        {canRestore && <Transition screen={screen} id={id} version={version} operation="restore" label="Restore voucher" />}
      </section>}
    {needsRepair.length > 0 && permissions.includes("edit") && permissions.includes("post") && approvalRight &&
      <section className="panel print-hide"><h2>Link existing party voucher</h2>
        <p className="muted mt-2">Confirm the party for each unlinked control line using the original paperwork. The journal amounts and document number stay the same.</p>
        <FinanceForm action={repairPartyAction} companyId={companyId} submit={[{ label: "Confirm and link parties" }]}>
          <input type="hidden" name="voucherId" value={id} />
          <div className="form-grid mt-4">
            {needsRepair.map((line) => <label className="field" key={line.id}>{line.account} · line {line.lineNo}
              <select name="repair" required defaultValue=""><option value="">Choose a party</option>
                {current.filter((party) => party.active && party.type === (line.control === "receivable" ? "customer" : "supplier"))
                  .map((party) => <option key={party.id} value={`${line.lineNo}:${party.id}`}>{party.name}</option>)}
              </select></label>)}
            <label className="field">Evidence or reason<input name="reason" required minLength={3} maxLength={500} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="confirmed" value="true" required /> I verified the selected parties against source evidence</label>
          </div>
        </FinanceForm>
      </section>}
    <section className="panel print-hide"><h2>Transaction history</h2>
      {history.rows.length ? history.rows.map((item) => <details className="finance-history" key={item.id}>
        <summary>{item.reason} · {item.actor} · {displayDate(item.date.slice(0, 10))} {item.date.slice(11, 16)}</summary>
        <div className="form-grid mt-3">
          <div><strong>Before</strong><HistorySummary value={item.previous} /></div>
          <div><strong>After</strong><HistorySummary value={item.next} /></div>
        </div>
      </details>) : <p className="muted mt-2">No recorded changes.</p>}
    </section>
  </>;
}

function HistorySummary({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return <p className="muted">—</p>;
  const row = value as {
    status?: string; date?: string; reference?: string; number?: string; posting?: { header?: { narration?: string }; lines?: EntryLine[] };
    draft?: { entry?: VoucherInput }; header?: { date?: string; status?: string; number?: string; narration?: string }; lines?: EntryLine[];
  };
  const lines = row.posting?.lines ?? row.draft?.entry?.lines ?? row.lines;
  return <div className="mt-2">
    <p>{row.number ?? row.header?.number ?? "Draft"} · {row.status ?? row.header?.status ?? "—"} · {displayDate(row.date ?? row.header?.date ?? "")}</p>
    {row.reference && <p>Reference {row.reference}</p>}
    <p>{row.posting?.header?.narration ?? row.draft?.entry?.narration ?? row.header?.narration}</p>
    {lines?.map((line, index) => <p className="muted text-sm" key={index}>
      Line {index + 1} · {line.partyId ? `Party ${line.partyId} · ` : ""} Account {line.accountId} ·
      {new Exact(line.debit).gt(0) ? ` Dr ${formatMoney(line.debit)}` : ` Cr ${formatMoney(line.credit)}`} {line.description}
    </p>)}
  </div>;
}

function Transition({ screen, id, version, operation, label }: {
  screen: Screen; id: string; version: number; operation: "post" | "submit" | "delete" | "restore"; label: string;
}) {
  return <details className="finance-history"><summary>{label}</summary>
    <FinanceForm action={transitionVoucherAction} companyId={screen.companyId} id={id} version={version}
      submit={[{ label: `Confirm ${label.toLowerCase()}`, variant: operation === "delete" ? "danger" : "outline" }]}>
      <input type="hidden" name="operation" value={operation} />
      <label className="field mt-2">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
    </FinanceForm>
  </details>;
}

export async function AccountDetail(screen: Screen, id?: string) {
  const { companyId, companyName, base, permissions } = screen;
  const rows = await getDb().select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code);
  const account = rows.find((row) => row.id === id);
  if (id && !account || !id && !permissions.includes("create")) notFound();
  return <>
    <PageHeading title={account ? `${account.code} · ${account.name}` : "Add account"} company={companyName} toolbar={account && <>
      <Button variant="outline" asChild><Link href={`${base}/ledger/${account.id}`}>View account ledger</Link></Button>
      {!["receivable", "payable", "opening_equity"].includes(account.control ?? "") && <Button variant="outline" asChild><a href={`${base}/opening?target=${account.id}`}>Opening balance</a></Button>}
    </>} />
    <section className="panel">
      {permissions.includes(id ? "edit" : "create") ? <AccountForm companyId={companyId} account={account} heads={rows} base={base} /> :
        <dl className="finance-detail"><div><dt>Classification</dt><dd className="capitalize">{account?.type}</dd></div>
          <div><dt>Status</dt><dd>{account?.active ? "Active" : "Inactive"}</dd></div>
          <div><dt>Parent account</dt><dd>{rows.find((row) => row.id === account?.parentId)?.name ?? "Main head"}</dd></div></dl>}
    </section>
  </>;
}

export async function PartyDetail(screen: Screen, id?: string) {
  const { companyId, companyName, base, permissions } = screen;
  const db = getDb();
  const [[party], opening] = await Promise.all([
    id ? db.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, id))) : [],
    id ? openingRows(db, companyId) : [],
  ]);
  if (id && !party || !id && !permissions.includes("create")) notFound();
  return <>
    <PageHeading title={party?.name ?? "Add party"} company={companyName} toolbar={id && <>
      <Button asChild variant="outline"><Link href={`${base}/party-ledger/${id}`}>View party ledger</Link></Button>
      <Button asChild variant="outline"><Link href={`${base}/allocations/${id}`}>Payments and allocations</Link></Button>
    </>} />
    <section className="panel">
      {permissions.includes(id ? "edit" : "create") ? <PartyForm companyId={companyId} base={base} party={party}
        opening={opening.find((row) => row.targetId === id)} today={karachiToday()} canPost={permissions.includes("post")} /> :
        <dl className="finance-detail">{[
          ["Classification", party?.type], ["Contact person", party?.contact], ["Phone", party?.phone], ["Email", party?.email],
          ["Billing address", party?.address], ["NTN", party?.ntn], ["STRN", party?.strn], ["Credit terms", `${party?.creditDays} days`],
          ["Credit limit (PKR)", party?.creditLimit], ["Status", party?.active ? "Active" : "Inactive"], ["Notes", party?.notes],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}</dl>}
    </section>
  </>;
}

export async function LedgerDetail(screen: Screen, id: string, kind: "account" | "party") {
  const { companyId, companyName, base, query } = screen;
  const db = getDb();
  const [head] = kind === "account"
    ? await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.id, id)))
    : await db.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, id)));
  if (!head) notFound();
  const range = resolveRange(query);
  const result = await readLedger(db, companyId, kind === "account" ? { accountId: id } : { partyId: id }, range.from, range.to);
  return <>
    <PageHeading title={head.name} company={companyName} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/${kind === "account" ? "chart" : "parties"}/${head.id}`}>{kind === "account" ? "Account details" : "Party details"}</Link></Button>
      {kind === "party" && <Button asChild variant="outline"><Link href={`${base}/allocations/${id}`}>Payments and allocations</Link></Button>}
    </>} />
    <DateFilters query={query} dateLabel={kind === "account" ? "Account ledger" : `${head.type === "customer" ? "Customer" : "Supplier"} ledger`} />
    <Ledger result={result} base={base} from={range.from} to={range.to} />
  </>;
}

export async function PartySettlement(screen: Screen, id: string) {
  const { companyId, companyName, base, query, permissions } = screen;
  const db = getDb();
  const [party] = await db.select().from(parties).where(and(eq(parties.companyId, companyId), eq(parties.id, id)));
  if (!party) notFound();
  const date = accountDate.safeParse(first(query.asOf));
  const asOf = date.success ? date.data : karachiToday();
  const { invoices, sources, active } = await db.transaction(async (tx) => ({
    invoices: await invoiceOutstanding(tx, companyId, asOf, id),
    sources: await paymentSources(tx, companyId, id, asOf),
    active: await activeAllocations(tx, companyId, id),
  }), { isolationLevel: "repeatable read", accessMode: "read only" });
  const available = sources.filter((row) => new Exact(row.unallocated).gt(0));
  const outstanding = invoices.filter((row) => new Exact(row.outstanding).gt(0));
  const canPost = permissions.includes("post");
  return <>
    <PageHeading title={`${party.name} · Payments and allocations`} company={companyName} toolbar={
      <Button variant="outline" asChild><Link href={`${base}/party-ledger/${id}`}>View party ledger</Link></Button>} />
    <DateFilters query={query} asOf={asOf} />
    <PanelTable title="Posted payments, credits and advances" headers={["Date","Voucher","Amount (PKR)","Allocated","Unallocated"]}
      empty={!sources.length ? "No eligible posted payments or advances" : undefined}>
      {sources.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td>
        <td><Link className="text-link" href={`${base}/vouchers/${row.documentId}`}>{row.number}</Link></td>
        <Money value={row.amount} /><Money value={row.allocated} /><Money value={row.unallocated} /></tr>)}
    </PanelTable>
    <InvoiceAging rows={invoices} />
    {canPost && available.length > 0 && outstanding.length > 0 && <section className="panel"><h2>Allocate a payment</h2>
      <p className="muted mt-2">FIFO applies by oldest invoice date, then invoice number. Any surplus stays unallocated.</p>
      <FinanceForm action={allocateAction} companyId={companyId} submit={[{ label: "Save allocation" }]}>
        <input type="hidden" name="partyId" value={id} />
        <div className="form-grid mt-4">
          <label className="field">Payment or advance<select name="lineId" required defaultValue="">
            <option value="">Choose a payment</option>{available.map((row) => <option key={row.id} value={row.id}>{row.number} · PKR {formatMoney(row.unallocated)} available</option>)}
          </select></label>
          <label className="field">Invoice allocation<select name="invoiceId" defaultValue="">
            <option value="">FIFO · Oldest invoice first</option>{outstanding.map((row) => <option key={row.id} value={row.id}>{row.number} · PKR {formatMoney(row.outstanding)} outstanding</option>)}
          </select></label>
          <label className="field">Allocation date<input type="date" name="date" defaultValue={asOf} required /></label>
          <label className="field">Amount (PKR)<input name="amount" inputMode="decimal" maxLength={21} required /></label>
        </div>
      </FinanceForm>
    </section>}
    <PanelTable title="Current active allocations" headers={["Date","Payment","Invoice","Amount (PKR)","Action"]}
      empty={!active.length ? "No active allocations" : undefined}>
      {active.map((row) => <tr key={row.id}><td>{displayDate(row.date)}</td><td>{row.payment}</td><td>{row.invoice}</td><Money value={row.amount} />
        <td>{canPost && permissions.includes("edit") ? <details><summary>Release allocation</summary>
          <FinanceForm action={releaseAction} companyId={companyId} id={row.id} submit={[{ label: "Confirm release", variant: "outline" }]}>
            <input type="hidden" name="partyId" value={id} />
            <label className="field">Release date<input name="date" type="date" defaultValue={asOf} required /></label>
            <label className="field mt-2">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
          </FinanceForm>
        </details> : "—"}</td></tr>)}
    </PanelTable>
  </>;
}
