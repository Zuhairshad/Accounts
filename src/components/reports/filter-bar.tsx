import { CalendarDays,Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { first,type Query } from "@/lib/range";
import { voucherType } from "@/db/schema";
import { isRegister,type ReportId } from "@/lib/reports/model";
import type { loadReport } from "@/lib/reports/access";

export function ReportFilters({id,report,query}:{id:ReportId;report:Awaited<ReturnType<typeof loadReport>>;query:Query}) {
  const {filter,active,all,heads,contacts,stock,years,year,combined,cross}=report;
  const accountFilters=["mis","general-ledger","cash-bank"].includes(id) || id==="day-book";
  const ledgerFilters=["mis","general-ledger","cash-bank","party-ledger","voucher-register"].includes(id);
  const partyFilters=["mis","party-ledger","debtors","creditors","aging","combined-parties","invoice-register","sales","purchases","sales-returns","purchase-returns","sales-executives"].includes(id);
  const audit=ledgerFilters && report.selection.every((company)=>company.permissions.includes("approve"));
  const stockFilter=["stock-ledger","inventory-valuation","adjustments"].includes(id);
  const names=new Map(all.map((entry)=>[entry.id,entry.name]));
  const companyPrefix=(company:string)=>report.selection.length>1 ? `${names.get(company)} · ` : "";
  return <form method="get" className="panel report-filters rep-filters print-hide">
    <div className="rep-filters-head"><span className="rep-filters-title"><CalendarDays size={17} aria-hidden /><strong>Report filters</strong></span>
      <span className="muted">Applied dates {filter.from} to {filter.to}</span></div>
    <div className="report-filter-grid rep-filter-grid">
      <label className="field rep-field-company">Company<select name="company" defaultValue={cross?"all":report.selection[0].id}>
        {combined && active.permissions.includes("view_combined") && <option value="all">All authorized report companies</option>}
        {all.map((entry)=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>
      <label className="field">Single date<input name="day" type="date" defaultValue={first(query.day) ?? ""} /></label>
      <label className="field">From Date<input name="from" type="date" defaultValue={first(query.from) ?? ""} /></label>
      <label className="field">To Date<input name="to" type="date" defaultValue={first(query.to) ?? ""} /></label>
      {years.length>0 && <label className="field">Financial year<select name="year" defaultValue={year?.id ?? ""}>
        <option value="">Use date range</option>{years.map((entry)=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>}
      {id==="mis" && <label className="field">Report mode<select name="mode" defaultValue={filter.mode==="vouchers"?"vouchers":""}>
        <option value="">Account-wise summary</option><option value="vouchers">Voucher Number Wise Detail</option>
      </select></label>}
      {id==="trial-balance" && <label className="field">Balance basis<select name="mode" defaultValue={filter.mode}><option value="">Closing balances</option><option value="movement">Period movements</option></select></label>}
      {["mis","company-wise","combined-heads"].includes(id) && <label className="field">Opening-only accounts<select name="includeOpening" defaultValue={filter.includeOpening?"1":"0"}>
        <option value="0">With period activity</option><option value="1">Include opening balances</option></select></label>}
      {id==="day-book" && <label className="field">Day Book perspective<select name="perspective" defaultValue={filter.perspective}>
        <option value="manual">Register-only</option><option value="cash">Cash ledgers</option><option value="bank">Bank ledgers</option>
      </select></label>}
      {id==="sale-purchase" && <label className="field">Register view<select name="mode" defaultValue={filter.mode}>
        <option value="">Posted invoices</option><option value="manual">Register-only</option>
      </select></label>}
      {accountFilters && <label className="field">Individual account<select name="account" defaultValue={filter.account ?? ""}>
        <option value="">All applicable accounts</option>{heads.filter((head)=>!["cash-bank","day-book"].includes(id) || head.liquidity)
          .map((head)=><option key={head.id} value={head.id}>{companyPrefix(head.companyId)}{head.code} · {head.name}</option>)}
      </select></label>}
      {id==="mis" && <><label className="field">Main account head<select name="main" defaultValue={filter.main ?? ""}>
        <option value="">All heads</option>{heads.filter((head)=>!head.parentId).map((head)=><option key={head.id} value={head.id}>{companyPrefix(head.companyId)}{head.code} · {head.name}</option>)}
      </select></label><label className="field">Account classification<select name="classification" defaultValue={filter.classification ?? ""}>
        <option value="">All</option>{["asset","liability","equity","income","expense"].map((type)=><option key={type}>{type}</option>)}</select></label></>}
      {partyFilters && <label className="field">Customer or supplier<select name="party" defaultValue={filter.party ?? ""}>
        <option value="">All parties</option>{contacts.map((entry)=><option key={entry.id} value={entry.id}>{companyPrefix(entry.companyId)}{entry.name} · {entry.type}</option>)}
      </select></label>}
      {stockFilter && <label className="field">Inventory item<select name="item" defaultValue={filter.item ?? ""}>
        <option value="">All stock items</option>{stock.filter((entry)=>entry.kind==="stock").map((entry)=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>}
      {(ledgerFilters || isRegister(id)) && <label className="field">Voucher type<select name="voucherType" defaultValue={filter.voucherType ?? ""}>
        <option value="">All types</option>{voucherType.enumValues.map((value)=><option key={value}>{value}</option>)}
      </select></label>}
      {ledgerFilters && <label className="field">Voucher number<input name="voucher" defaultValue={filter.voucher ?? ""} maxLength={120} /></label>}
      {["mis","general-ledger","invoice-register","sales","purchases"].includes(id) && <label className="field">Invoice number<input name="invoice" defaultValue={filter.invoice ?? ""} maxLength={120} /></label>}
      {audit && <><label className="field">Transaction status<select name="status" defaultValue={filter.status}>
        <option value="posted">Posted only</option><option value="draft">Draft audit</option><option value="void">Voided audit</option><option value="all">All audit states</option>
      </select></label><label className="field">Historical system time (PKT)<input type="datetime-local" name="recordedAt"
        defaultValue={filter.recordedAt?new Date(new Date(filter.recordedAt).getTime()+5*3600000).toISOString().slice(0,16):""} /></label></>}
      {!["trial-balance","balance-sheet","profit-loss"].includes(id) && <label className="field rep-field-search">Search<input name="q" defaultValue={filter.search} maxLength={120} /></label>}
      <div className="rep-filter-submit"><Button type="submit" variant="outline"><Filter size={16} /> Apply filters</Button></div>
    </div>
  </form>;
}
