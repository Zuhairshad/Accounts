import type { Database,Transaction } from "@/db";
import { z } from "zod";
import { accountDate, AccountingError } from "@/lib/engine/model";
import { first, type Query } from "@/lib/range";
import { karachiToday } from "@/lib/validation";
import { balanceSheet,journalDetail,profitLoss,summaryReport,trialBalance } from "./financial";
import { adjustmentsReport,agingReport,inventoryReport,invoiceReport,partiesReport,voucherReport } from "./operational";
import { registerReport } from "./register";
import { salesExecutiveReport } from "./sales";
import { isRegister,reportTitles,type ReportDocument,type ReportFilter,type ReportId } from "./model";

export type ReportCompany={id:string;name:string;details?:string[]};
type Reader=Database|Transaction;
const uuid=z.uuid();
const cutoff=z.iso.datetime({offset:true});
const field=(q:Query,k:string)=>first(q[k])?.trim().slice(0,120) || undefined;

export function filters(query:Query, defaultPerspective:"cash"|"bank"|"manual", year?:{startsOn:string;endsOn:string}):ReportFilter {
  const today=karachiToday();
  const single=field(query,"day");
  const from=single ?? (field(query,"from") || year?.startsOn || `${today.slice(0,7)}-01`);
  const to=single ?? (field(query,"to") || year?.endsOn || today);
  if (!accountDate.safeParse(from).success || !accountDate.safeParse(to).success || from>to ||
    year && (from<year.startsOn || to>year.endsOn)) throw new AccountingError("Enter a valid range within the selected financial year.");
  const raw=field(query,"recordedAt");
  const stamp=raw && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00+05:00` : raw;
  if (stamp && !cutoff.safeParse(stamp).success) throw new AccountingError("Enter a valid historical system time.");
  const id=(value:string|undefined)=>value && uuid.safeParse(value).success ? value : undefined;
  const status=field(query,"status");
  const perspective=field(query,"perspective");
  return {
    from,to,perspective:perspective==="cash" || perspective==="bank" || perspective==="manual" ? perspective : defaultPerspective,
    mode:field(query,"mode") ?? "", account:id(field(query,"account")), main:id(field(query,"main")), party:id(field(query,"party")),
    item:id(field(query,"item")), group:field(query,"group"), voucher:field(query,"voucher"), invoice:field(query,"invoice"),
    voucherType:field(query,"voucherType"), classification:field(query,"classification"),
    status:status==="draft" || status==="void" || status==="all" ? status : "posted", recordedAt:stamp,
    includeOpening:field(query,"includeOpening")==="1", search:field(query,"q") ?? "", blank:field(query,"blank")==="1",
    deleted:field(query,"deleted")==="1",
  };
}

export async function buildReport(db:Reader,id:ReportId,home:string,companies:ReportCompany[],f:ReportFilter,yearStart?:string):Promise<ReportDocument> {
  if (!companies.length) throw new AccountingError("Choose an authorized company.");
  const primary=companies[0].id;
  const core={...f,account:undefined,main:undefined,party:undefined,voucher:undefined,voucherType:undefined,invoice:undefined,
    classification:undefined,search:"",group:undefined,recordedAt:undefined,status:"posted" as const};
  let view;
  if (isRegister(id)) view=await registerReport(db,companies,home,id,f);
  else if (id==="mis" && (f.mode==="vouchers" || f.status!=="posted")) view=await journalDetail(db,companies,f,id);
  else if (id==="mis" || id==="company-wise" || id==="combined-heads") view=await summaryReport(db,companies,f,id);
  else if (id==="trial-balance") view=await trialBalance(db,primary,{...core,mode:f.mode});
  else if (id==="profit-loss") view=await profitLoss(db,primary,core);
  else if (id==="balance-sheet") view=await balanceSheet(db,primary,core,yearStart);
  else if (id==="general-ledger" || id==="party-ledger" || id==="cash-bank") view=await journalDetail(db,companies,f,id);
  else if (id==="debtors" || id==="creditors" || id==="combined-parties") view=await partiesReport(db,companies,f,id);
  else if (id==="aging") view=await agingReport(db,primary,f);
  else if (id==="voucher-register") view=f.status==="posted" ? await voucherReport(db,primary,f) : await journalDetail(db,companies,f,"mis");
  else if (id==="invoice-register" || id==="sales" || id==="purchases" || id==="sales-returns" || id==="purchase-returns") view=await invoiceReport(db,primary,f,id);
  else if (id==="adjustments") view=await adjustmentsReport(db,primary,f);
  else if (id==="sales-executives") view=await salesExecutiveReport(db,primary,f);
  else view=await inventoryReport(db,primary,f,id);
  const notes=[...view.notes];
  if (f.recordedAt) notes.push(`Historical journal state at ${new Date(f.recordedAt).toISOString()}. Master labels can reflect later renames.`);
  return {id,title:id==="mis" && (f.mode==="vouchers" || f.status!=="posted") ? "Daily MIS · Voucher Number Wise Detail" : reportTitles[id],
    scope:companies.map((n)=>n.name),companyDetails:companies.length===1 ? companies[0].details ?? [] : [],from:f.from,to:f.to,
    generatedAt:new Date().toISOString(),...view,notes};
}
