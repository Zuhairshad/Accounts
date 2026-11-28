import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import {
  ArrowLeft, Ban, BookOpen, CheckCircle2, FileText, Wallet, Copy, Download, History, Link2, Pencil, Printer, RotateCcw, Send, ShieldCheck,
} from "lucide-react";
import { getDb } from "@/db";
import { accounts, companySettings, parties, salesExecutives } from "@/db/schema";
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
import { Ledger, PageHeading, sided } from "./finance-ui";
import { AccCard, AccFilters, AccTable, Num, SidedFigure, StatCard, StatusPill, voucherTypes } from "./acc-ui";
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
      subtitle={id ? `Changing ${source?.number ?? "a draft voucher"}` : "Enter a balanced journal: total debits must equal total credits"}
      toolbar={<Button asChild variant="outline"><Link href={id ? `${base}/vouchers/${id}` : `${base}/vouchers`}>Cancel</Link></Button>} />
    <VoucherEditor companyId={companyId} base={base} options={options} version={id ? source!.version : 0} id={id}
      entry={entry ? { ...entry, date: copyId ? karachiToday() : entry.date } : {
        type: "JV", date: karachiToday(), reference: "", narration: "", mode: "party", lines: [],
      }} approval={settings.voucherApproval} canPost={permissions.includes("post")} isPosted={!!id && source?.status === "posted"} />
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
  const [executive] = voucher.doc?.salesExecutiveId ? await getDb().select({ name: salesExecutives.name }).from(salesExecutives)
    .where(and(eq(salesExecutives.companyId, companyId), eq(salesExecutives.id, voucher.doc.salesExecutiveId))) : [];
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
  const statusText = status === "void" ? "Voided" : status === "draft" && voucher.doc?.submittedBy ? "Awaiting approval" : status;
  const showSubmit = settings.voucherApproval && status === "draft" && !voucher.doc?.submittedBy && permissions.includes("edit");
  const actions = canPost || canVoid || canRestore || (managed && showSubmit);
  const repair = needsRepair.length > 0 && permissions.includes("edit") && permissions.includes("post") && approvalRight;
  return <>
    <PageHeading title={number ?? `${type} draft`} company={companyName} subtitle={`${voucherTypes[type] ?? type} · ${displayDate(date)}`} toolbar={<>
      <Button variant="outline" asChild><Link href={`${base}/vouchers`}><ArrowLeft size={16} /> Voucher register</Link></Button>
      {voucher.doc?.sourceId && ["invoice","inventory_adjustment"].includes(voucher.doc.source) &&
        <Button variant="outline" asChild><Link href={`/workspace/${companyId}/trade/${voucher.doc.source === "invoice" ? "invoices" : "adjustments"}/${voucher.doc.sourceId}`}>Originating document</Link></Button>}
      {entry && !voucher.readOnlyOrigin && permissions.includes("create") &&
        <Button variant="outline" asChild><a href={`${base}/vouchers/new?copy=${id}`}><Copy size={16} /> Duplicate as new</a></Button>}
      {permissions.includes("print") && <Button variant="outline" asChild><a href={`${pdf}?inline=1`} target="_blank" rel="noreferrer"><Printer size={16} /> Print voucher</a></Button>}
      {permissions.includes("export") && <Button variant="outline" asChild><a href={pdf}><Download size={16} /> Download PDF</a></Button>}
      {canEdit && <Button asChild><a href={`${base}/vouchers/${id}?edit=1`}><Pencil size={16} /> Edit voucher</a></Button>}
    </>} />
    <section className="panel acc-summary">
      <dl className="acc-facts">
        <div><dt>Accounting date</dt><dd>{displayDate(date)}</dd></div>
        <div><dt>Voucher type</dt><dd>{type}<small>{voucherTypes[type] ?? ""}</small></dd></div>
        <div><dt>Status</dt><dd><StatusPill status={statusText} className="capitalize" /></dd></div>
        <div><dt>Reference</dt><dd>{voucher.reference || "—"}</dd></div>
        {executive && <div><dt>Sales executive</dt><dd>{executive.name}</dd></div>}
        <div className="acc-fact-wide"><dt>Narration</dt><dd>{entry?.narration || voucher.narration || "—"}</dd></div>
      </dl>
      <div className="acc-summary-total"><span>Voucher total (PKR)</span><strong>{formatMoney(total("debit"))}</strong>
        <small>{lines.length} {lines.length === 1 ? "line" : "lines"}</small></div>
    </section>
    <AccTable title="Journal lines" subtitle="Debits and credits posted by this voucher"
      headers={["Account","Party","Description",{ label: "Debit (PKR)", num: true },{ label: "Credit (PKR)", num: true },{ label: "Current party balance", num: true }]}
      empty={!lines.length ? "No lines entered" : undefined}
      foot={<tr className="acc-total-row"><td colSpan={3}><strong>Totals</strong></td><Num value={total("debit")} strong /><Num value={total("credit")} strong /><td /></tr>}>
      {lines.map((line, index) => {
        const option = options.find((item) => item.accountId === line.accountId && item.partyId === line.partyId);
        const party = current.find((candidate) => candidate.id === line.partyId);
        const zero = (value: string) => new Exact(value).isZero();
        return <tr key={index}><td><strong>{line.account ?? option?.label ?? "Account"}</strong></td><td>{line.party ?? party?.name ?? <span className="muted">—</span>}</td>
          <td>{line.description || <span className="muted">—</span>}</td>
          <td className={`acc-num${zero(line.debit) ? " acc-zero" : ""}`}>{formatMoney(line.debit)}</td>
          <td className={`acc-num${zero(line.credit) ? " acc-zero" : ""}`}>{formatMoney(line.credit)}</td>
          <td className="acc-num">{party ? <SidedFigure value={sided(party.balance)} /> : <span className="muted">—</span>}</td></tr>;
      })}
    </AccTable>
    <div className={`acc-detail-grid${actions || repair ? "" : " acc-detail-single"}`}>
      {(actions || repair) && <div className="acc-detail-side">
        {actions && <AccCard title="Transaction actions" subtitle="Every change asks for a reason and is kept in the history" className="print-hide" icon={<ShieldCheck size={18} />}>
          <div className="acc-actions">
            {showSubmit && <Transition screen={screen} id={id} version={version} operation="submit" label="Submit for approval" />}
            {canPost && <Transition screen={screen} id={id} version={version} operation="post" label={settings.voucherApproval ? "Approve and post" : "Post voucher"} />}
            {canVoid && <Transition screen={screen} id={id} version={version} operation="delete" label="Void voucher" />}
            {canRestore && <Transition screen={screen} id={id} version={version} operation="restore" label="Restore voucher" />}
          </div>
        </AccCard>}
        {repair && <AccCard title="Link existing party voucher" className="print-hide" icon={<Link2 size={18} />}
          subtitle="Confirm the party for each unlinked control line using the original paperwork. The journal amounts and document number stay the same.">
          <FinanceForm action={repairPartyAction} companyId={companyId} submit={[{ label: "Confirm and link parties" }]}>
            <input type="hidden" name="voucherId" value={id} />
            <div className="form-grid acc-form-grid">
              {needsRepair.map((line) => <label className="field" key={line.id}>{line.account} · line {line.lineNo}
                <select name="repair" required defaultValue=""><option value="">Choose a party</option>
                  {current.filter((party) => party.active && party.type === (line.control === "receivable" ? "customer" : "supplier"))
                    .map((party) => <option key={party.id} value={`${line.lineNo}:${party.id}`}>{party.name}</option>)}
                </select></label>)}
              <label className="field">Evidence or reason<input name="reason" required minLength={3} maxLength={500} /></label>
              <label className="acc-check field-wide"><input type="checkbox" name="confirmed" value="true" required /> I verified the selected parties against source evidence</label>
            </div>
          </FinanceForm>
        </AccCard>}
      </div>}
      <AccCard title="Transaction history" subtitle={`${history.rows.length} recorded ${history.rows.length === 1 ? "change" : "changes"}`} className="print-hide" icon={<History size={18} />}>
        {history.rows.length ? <ol className="acc-timeline">{history.rows.map((item) => <li key={item.id}><details className="finance-history acc-history">
          <summary>{item.reason} · {item.actor} · {displayDate(item.date.slice(0, 10))} {item.date.slice(11, 16)}</summary>
          <div className="acc-history-diff">
            <div><strong>Before</strong><HistorySummary value={item.previous} /></div>
            <div><strong>After</strong><HistorySummary value={item.next} /></div>
          </div>
        </details></li>)}</ol> : <div className="table-empty acc-empty acc-empty-flat"><History size={20} aria-hidden /><strong>No recorded changes.</strong></div>}
      </AccCard>
    </div>
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
  const Icon = { post: CheckCircle2, submit: Send, delete: Ban, restore: RotateCcw }[operation];
  return <details className={`acc-action acc-action-${operation}`}><summary><span className="acc-action-icon" aria-hidden><Icon size={16} /></span>{label}</summary>
    <FinanceForm action={transitionVoucherAction} companyId={screen.companyId} id={id} version={version}
      submit={[{ label: `Confirm ${label.toLowerCase()}`, variant: operation === "delete" ? "danger" : "outline" }]}>
      <input type="hidden" name="operation" value={operation} />
      <label className="field">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
    </FinanceForm>
  </details>;
}

export async function AccountDetail(screen: Screen, id?: string) {
  const { companyId, companyName, base, permissions } = screen;
  const rows = await getDb().select().from(accounts).where(eq(accounts.companyId, companyId)).orderBy(accounts.code);
  const account = rows.find((row) => row.id === id);
  if (id && !account || !id && !permissions.includes("create")) notFound();
  return <>
    <PageHeading title={account ? `${account.code} · ${account.name}` : "Add account"} company={companyName}
      subtitle={account ? <><span className={`acc-class acc-class-${account.type}`}>{account.type}</span> account head</> : "Create an account head in the chart of accounts"} toolbar={<>
      <Button variant="outline" asChild><Link href={`${base}/chart`}><ArrowLeft size={16} /> Chart of accounts</Link></Button>
      {account && <Button variant="outline" asChild><Link href={`${base}/ledger/${account.id}`}>View account ledger</Link></Button>}
      {account && !["receivable", "payable", "opening_equity"].includes(account.control ?? "") && <Button variant="outline" asChild><a href={`${base}/opening?target=${account.id}`}>Opening balance</a></Button>}
    </>} />
    <AccCard title="Account details" subtitle="Code, name, classification and where the head sits in the chart" icon={<BookOpen size={18} />}>
      {permissions.includes(id ? "edit" : "create") ? <AccountForm companyId={companyId} account={account} heads={rows} base={base} /> :
        <dl className="acc-facts"><div><dt>Classification</dt><dd className="capitalize">{account?.type}</dd></div>
          <div><dt>Status</dt><dd>{account?.active ? "Active" : "Inactive"}</dd></div>
          <div><dt>Parent account</dt><dd>{rows.find((row) => row.id === account?.parentId)?.name ?? "Main head"}</dd></div></dl>}
    </AccCard>
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
    <PageHeading title={party?.name ?? "Add party"} company={companyName}
      subtitle={party ? <><span className={`acc-class acc-class-${party.type}`}>{party.type}</span> {party.active ? "active party" : "inactive party"}</> : "Create a customer or supplier"} toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/parties`}><ArrowLeft size={16} /> Party master</Link></Button>
      {id && <Button asChild variant="outline"><Link href={`${base}/party-ledger/${id}`}>View party ledger</Link></Button>}
      {id && <Button asChild variant="outline"><Link href={`${base}/allocations/${id}`}>Payments and allocations</Link></Button>}
    </>} />
    <section className="panel acc-card acc-form-card">
      {permissions.includes(id ? "edit" : "create") ? <PartyForm companyId={companyId} base={base} party={party}
        opening={opening.find((row) => row.targetId === id)} today={karachiToday()} canPost={permissions.includes("post")} /> :
        <dl className="acc-facts">{[
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
    <PageHeading title={head.name} company={companyName}
      subtitle="Posted entries with a running balance" toolbar={<>
      <Button asChild variant="outline"><Link href={`${base}/${kind === "account" ? "chart" : "parties"}/${head.id}`}>{kind === "account" ? "Account details" : "Party details"}</Link></Button>
      {kind === "party" && <Button asChild variant="outline"><Link href={`${base}/allocations/${id}`}>Payments and allocations</Link></Button>}
    </>} />
    <AccFilters query={query} dateLabel={kind === "account" ? "Account ledger" : `${head.type === "customer" ? "Customer" : "Supplier"} ledger`} />
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
  const unallocated = available.reduce((sum, row) => sum.plus(row.unallocated), new Exact(0)).toFixed(2);
  const due = outstanding.reduce((sum, row) => sum.plus(row.outstanding), new Exact(0)).toFixed(2);
  return <>
    <PageHeading title={`${party.name} · Payments and allocations`} company={companyName} subtitle="Match posted payments and advances to open invoices" toolbar={
      <Button variant="outline" asChild><Link href={`${base}/party-ledger/${id}`}>View party ledger</Link></Button>} />
    <AccFilters query={query} asOf={asOf} />
    <section className="stat-row acc-stat-row" aria-label="Allocation summary">
      <StatCard icon={<Wallet size={20} />} title="Available to allocate" subtitle={`${available.length} ${available.length === 1 ? "payment" : "payments"} with an unallocated amount`}
        value={<><small className="acc-unit">PKR </small>{formatMoney(unallocated)}</>} />
      <StatCard icon={<FileText size={20} />} tone="red" title="Outstanding invoices" subtitle={`${outstanding.length} open ${outstanding.length === 1 ? "invoice" : "invoices"}`}
        value={<><small className="acc-unit">PKR </small>{formatMoney(due)}</>} />
      <StatCard icon={<Link2 size={20} />} tone="blue" title="Active allocations" subtitle="Payments already matched to invoices" value={active.length} />
    </section>
    <AccTable title="Posted payments, credits and advances" subtitle={`As of ${displayDate(asOf)}`}
      headers={["Voucher","Date",...["Amount (PKR)","Allocated","Unallocated"].map((label) => ({ label, num: true }))]}
      empty={!sources.length ? "No eligible posted payments or advances" : undefined}>
      {sources.map((row) => <tr key={row.id}>
        <td><Link className="acc-strong-link" href={`${base}/vouchers/${row.documentId}`}>{row.number}</Link></td><td className="acc-nowrap">{displayDate(row.date)}</td>
        <Num value={row.amount} /><Num value={row.allocated} /><Num value={row.unallocated} strong /></tr>)}
    </AccTable>
    <InvoiceAging rows={invoices} />
    {canPost && available.length > 0 && outstanding.length > 0 && <AccCard title="Allocate a payment" icon={<Link2 size={18} />}
      subtitle="FIFO applies by oldest invoice date, then invoice number. Any surplus stays unallocated.">
      <FinanceForm action={allocateAction} companyId={companyId} submit={[{ label: "Save allocation" }]}>
        <input type="hidden" name="partyId" value={id} />
        <div className="form-grid acc-form-grid acc-cols-4">
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
    </AccCard>}
    <AccTable title="Current active allocations" headers={["Date","Payment","Invoice",{ label: "Amount (PKR)", num: true },"Action"]}
      empty={!active.length ? "No active allocations" : undefined}>
      {active.map((row) => <tr key={row.id}><td className="acc-nowrap">{displayDate(row.date)}</td><td><strong>{row.payment}</strong></td><td>{row.invoice}</td><Num value={row.amount} />
        <td>{canPost && permissions.includes("edit") ? <details className="acc-inline-action"><summary>Release allocation</summary>
          <FinanceForm action={releaseAction} companyId={companyId} id={row.id} submit={[{ label: "Confirm release", variant: "outline" }]}>
            <input type="hidden" name="partyId" value={id} />
            <label className="field">Release date<input name="date" type="date" defaultValue={asOf} required /></label>
            <label className="field mt-2">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
          </FinanceForm>
        </details> : "—"}</td></tr>)}
    </AccTable>
  </>;
}
