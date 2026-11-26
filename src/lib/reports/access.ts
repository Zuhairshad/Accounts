import "server-only";
import { eq,inArray,sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { accounts,companySettings,financialYears,items,parties } from "@/db/schema";
import { AccessError,getActor } from "@/lib/auth";
import { companyList } from "@/lib/companies";
import { AccountingError } from "@/lib/engine/model";
import { first,type Query } from "@/lib/range";
import { buildReport,filters } from "./build";
import { combinedIds,isRegister,type ReportId } from "./model";
import { manualRows,registerSetting } from "./register";

type Purpose="view"|"print"|"export";
export async function loadReport(home:string,id:ReportId,query:Query,purpose:Purpose,options=false) {
  if (!z.uuid().safeParse(home).success) throw new AccessError();
  const actor=await getActor();
  if (!actor) throw new AccessError();
  return getDb().transaction(async (tx)=>{
    const all=(await companyList(actor,tx)).filter((company)=>company.active && company.permissions.includes("view"));
    const active=all.find((company)=>company.id===home);
    if (!active) throw new AccessError();
    const combined=[...combinedIds,"day-book","sale-purchase","mis"].includes(id);
    const requested=first(query.company);
    const cross=requested==="all" || !requested && (combinedIds as readonly string[]).includes(id);
    let selection=all.filter((company)=>company.id===(requested && !cross ? requested : home));
    if (cross) {
      if (!combined || !active.permissions.includes("view_combined")) throw new AccessError();
      selection=all.filter((company)=>company.permissions.includes("view_combined"));
    }
    if (!selection.length || selection.some((company)=>!company.permissions.includes(purpose))) throw new AccessError();
    const ids=selection.map((company)=>company.id);
    if ((first(query.recordedAt) || ["draft","void","all"].includes(first(query.status) ?? "")) &&
      (!["mis","general-ledger","voucher-register","cash-bank","party-ledger"].includes(id) || selection.some((company)=>!company.permissions.includes("approve")))) {
      throw new AccessError("Historical and inactive journal views require approval permission for all selected companies.");
    }
    const fy=first(query.year);
    const years=ids.length===1 ? await tx.select().from(financialYears).where(eq(financialYears.companyId,ids[0])).orderBy(financialYears.startsOn) : [];
    const year=years.find((entry)=>entry.id===fy);
    if (fy && !year) throw new AccountingError("Choose a financial year for the selected company.");
    const settings=isRegister(id) ? await registerSetting(tx,home,id) : null;
    const filter=filters(query,settings?.perspective ?? "manual",year);
    const yearStart=years.find((entry)=>entry.startsOn<=filter.to && entry.endsOn>=filter.to)?.startsOn;
    const org=ids.length===1 ? (await tx.select().from(companySettings).where(eq(companySettings.companyId,ids[0])))[0] : null;
    const companyInfo=selection.map((entry)=>({id:entry.id,name:entry.name,details:org ?
      [org.address,[org.phone,org.email].filter(Boolean).join(" · "),[org.ntn && `NTN ${org.ntn}`,org.strn && `STRN ${org.strn}`].filter(Boolean).join(" · ")].filter(Boolean):[]}));
    const document=await buildReport(tx,id,home,companyInfo,filter,yearStart);
    const heads=options ? await tx.select().from(accounts).where(inArray(accounts.companyId,ids)).orderBy(accounts.code) : [];
    const contacts=options ? await tx.select().from(parties).where(inArray(parties.companyId,ids)).orderBy(parties.name) : [];
    const stock=options && ["stock-ledger","inventory-valuation","adjustments","sale-purchase"].includes(id) ?
      await tx.select().from(items).where(inArray(items.companyId,ids)).orderBy(items.name) : [];
    const drafts=options && isRegister(id) && ids.length===1 && ids[0]===home ?
      await manualRows(tx,ids,id,filter.from,filter.to,filter.deleted,true) : [];
    const linkable=options && isRegister(id) && ids.length===1 && ids[0]===home ? (await tx.execute<{id:string;name:string}>(id==="day-book" ? sql`
      SELECT e.document_id AS id,concat_ws(' · ',e.number,e.accounting_date::text,e.narration) AS name
      FROM effective_vouchers e JOIN voucher_documents d ON d.company_id=e.company_id AND d.id=e.document_id
      WHERE e.company_id=${home} AND e.accounting_date BETWEEN ${filter.from}::date AND ${filter.to}::date
        AND EXISTS(SELECT 1 FROM journal_lines l JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
          WHERE l.company_id=e.company_id AND l.voucher_id=e.id AND a.liquidity IS NOT NULL)
      ORDER BY e.accounting_date DESC,e.created_at DESC,e.document_id LIMIT 500` : sql`
      SELECT i.id,concat_ws(' · ',i.number,i.accounting_date::text,p.name) AS name FROM invoices i JOIN parties p ON p.company_id=i.company_id AND p.id=i.party_id
      JOIN effective_vouchers e ON e.company_id=i.company_id AND e.id=i.voucher_id
      WHERE i.company_id=${home} AND i.status='posted' AND i.accounting_date BETWEEN ${filter.from}::date AND ${filter.to}::date
      ORDER BY i.accounting_date DESC,i.created_at DESC,i.id LIMIT 500`)).rows : [];
    return {document,filter,active,all,selection,heads,contacts,stock,years,year,settings,drafts,linkable,combined,cross};
  }, {isolationLevel:"repeatable read",accessMode:"read only"});
}
