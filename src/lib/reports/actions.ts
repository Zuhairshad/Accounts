"use server";

import { and,eq,sql } from "drizzle-orm";
import { z } from "zod";
import { accounts,auditLogs,invoices,items,manualRegisterRows,reportAccountMappings,reportSettings,revisions } from "@/db/schema";
import { AccountingError,Exact,amount,manualType,reasonText } from "@/lib/engine/model";
import { entries,identifier,run,version,type FinanceState } from "@/lib/engine/mutation";
import { saveManual } from "@/lib/engine/vouchers";
import { invoiceSchema,quantityInput,rateInput } from "@/lib/trade/model";
import { saveInvoice } from "@/lib/trade/service";
import { cashViews,layoutSchema,type RegisterId } from "./model";
import { isComplete,registerPayload,signedAmounts } from "./register";

export async function registerConfigAction(_state:FinanceState,form:FormData) {
  return run(form,"reports.register_settings",()=>{
    const fields=entries(form);
    return {kind:z.enum(["day-book","sale-purchase"]).parse(fields.kind),version:version.parse(fields.version),
      layout:layoutSchema.parse({...fields,widths:String(fields.widths).split(",")}),
      perspective:z.enum(cashViews).parse(fields.perspective),
      direction:z.enum(["dr-cr","cr-dr"]).parse(fields.direction),
      initial:z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?$/).parse(fields.initial)};
  },async(tx,context,data,require)=>{
    require("manage_company");
    const {kind,version,...settings}=data;
    const {companyId,actorId}=context;
    const [before]=await tx.select().from(reportSettings).where(and(eq(reportSettings.companyId,companyId),eq(reportSettings.key,kind)));
    if ((before?.version ?? 0)!==version) throw new AccountingError("Settings changed. Reload and try again.");
    await tx.insert(reportSettings).values({companyId,key:kind,settings,version:version+1}).onConflictDoUpdate({
      target:[reportSettings.companyId,reportSettings.key],set:{settings,version:version+1},
    });
    await tx.insert(auditLogs).values({companyId,actorId,action:"register.settings",data:{kind,before,settings}});
    return {};
  });
}

export async function mappingAction(_state:FinanceState,form:FormData) {
  return run(form,"reports.mapping",()=>z.object({
    accountId:identifier,group:z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{0,50}$/),label:z.string().trim().max(120),
    otherExpense:z.enum(["true","false"]).transform((v)=>v==="true"),
  }).parse(entries(form)),async(tx,context,data,require)=>{
    require("manage_company");
    const {companyId,actorId}=context;
    const [account]=await tx.select().from(accounts).where(and(eq(accounts.companyId,companyId),eq(accounts.id,data.accountId)));
    if (!account) throw new AccountingError("Choose an account in this company.");
    if (data.group && !data.label) throw new AccountingError("Enter a display label for this explicit reporting group.");
    const values={companyId,accountId:account.id,groupKey:data.group || null,label:data.label,type:account.type,otherExpense:account.type==="expense" && data.otherExpense};
    await tx.insert(reportAccountMappings).values(values).onConflictDoUpdate({target:[reportAccountMappings.companyId,reportAccountMappings.accountId],set:values});
    await tx.insert(auditLogs).values({companyId,actorId,action:"report.account_mapped",data:values});
    return {};
  });
}

export async function financialRegisterAction(_state:FinanceState,form:FormData) {
  return run(form,"register.accounting",()=>z.object({
    id:identifier,version,kind:z.enum(["day-book","sale-purchase"]),operation:z.enum(["attach","create"]),
    existing:z.string().trim(),cashId:z.string().trim(),offsetId:z.string().trim(),itemId:z.string().trim(),
    quantity:z.string().trim(),rate:z.string().trim(),reason:reasonText,confirmed:z.literal("true"),
  }).parse(entries(form)),async(tx,context,data)=>{
    const {companyId,actorId}=context;
    context.require("edit");
    const [before]=await tx.select().from(manualRegisterRows).where(and(eq(manualRegisterRows.companyId,companyId),
      eq(manualRegisterRows.id,data.id),eq(manualRegisterRows.register,data.kind))).for("update");
    if (!before || before.version!==data.version || before.status!=="saved") throw new AccountingError("Save the complete row first or reload the latest version.");
    const record=registerPayload.parse(before.payload);
    if (!isComplete(data.kind,record)) throw new AccountingError("Fill in the required register columns before creating a link.");
    let linkedVoucherId:string|null=null;
    let linkedInvoiceId:string|null=null;
    if (data.operation==="attach") {
      const id=identifier.parse(data.existing);
      if (data.kind==="day-book") {
        const check=await tx.execute<{found:boolean}>(sql`
          SELECT EXISTS(SELECT 1 FROM effective_vouchers e JOIN voucher_documents d ON d.company_id=e.company_id AND d.id=e.document_id
            JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
            JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id AND a.liquidity IS NOT NULL
            WHERE e.company_id=${companyId} AND d.id=${id}) AS found`);
        if (!check.rows[0].found) throw new AccountingError("Choose an effective cash or bank voucher in this company.");
        linkedVoucherId=id;
      } else {
        const [invoice]=await tx.select().from(invoices).where(and(eq(invoices.companyId,companyId),eq(invoices.id,id),eq(invoices.status,"posted")));
        if (!invoice || invoice.type!==record.type) throw new AccountingError("Choose a posted invoice of the matching type in this company.");
        linkedInvoiceId=id;
      }
    } else if (data.kind==="day-book") {
      if (record.ref) {
        const occupied=await tx.execute<{found:boolean}>(sql`
          SELECT EXISTS (SELECT 1 FROM effective_vouchers
            WHERE company_id=${companyId} AND (lower(number)=lower(${record.ref}) OR lower(reference)=lower(${record.ref}))) AS found
        `);
        if (occupied.rows[0].found) throw new AccountingError("A posted voucher uses this reference. Attach the existing cash or bank voucher.");
      }
      context.require("post");
      const type=manualType.parse(record.type);
      const cashId=identifier.parse(data.cashId),offsetId=identifier.parse(data.offsetId);
      const [cash]=await tx.select().from(accounts).where(and(eq(accounts.companyId,companyId),eq(accounts.id,cashId)));
      if (!cash?.liquidity || !cash.active || cashId===offsetId) throw new AccountingError("Choose an active cash or bank account and a different offset account.");
      const [offset]=await tx.select().from(accounts).where(and(eq(accounts.companyId,companyId),eq(accounts.id,offsetId)));
      const control=offset?.control==="receivable" || offset?.control==="payable";
      const amounts=[record.first || "0",record.second || "0"].map((a)=>amount.parse(a));
      const voucher=await saveManual(tx,context,{
        intent:"post",version:0,reason:data.reason,entry:{type,date:record.date,reference:record.ref,narration:record.description,
          mode:control ? "party" : "direct",lines:[
            {accountId:cashId,partyId:null,description:"",debit:amounts[0],credit:amounts[1]},
            {accountId:offsetId,partyId:control ? record.partyId : null,description:"",debit:amounts[1],credit:amounts[0]},
          ]},
      });
      linkedVoucherId=voucher.id;
    } else {
      context.require("post");
      if (!["sale","purchase"].includes(record.type)) throw new AccountingError("Post returns through the original invoice, then attach the posted return to this row.");
      if (record.ref) {
        const occupied=await tx.execute<{found:boolean}>(sql`
          SELECT EXISTS (SELECT 1 FROM invoices WHERE company_id=${companyId} AND status='posted'
            AND (lower(number)=lower(${record.ref})
              OR (party_id=${record.partyId}::uuid AND lower(external_ref)=lower(${record.ref})))) AS found
        `);
        if (occupied.rows[0].found) throw new AccountingError("A posted invoice uses this reference. Attach the existing invoice.");
      }
      const itemId=identifier.parse(data.itemId);
      const [item]=await tx.select().from(items).where(and(eq(items.companyId,companyId),eq(items.id,itemId)));
      if (!item?.active || !record.partyId) throw new AccountingError("Choose an active item and the customer or supplier.");
      const quantity=quantityInput.parse(data.quantity),rate=rateInput.parse(data.rate);
      const [first,second]=signedAmounts(data.kind,record);
      const total=first.plus(second);
      if (!new Exact(quantity).times(rate).toDecimalPlaces(2,Exact.ROUND_HALF_UP).eq(total)) {
        throw new AccountingError("Quantity × rate must equal the register amount. For multi-line, tax or refund documents, post the full invoice and attach it.");
      }
      const input=invoiceSchema.parse({type:record.type,date:record.date,partyId:record.partyId,dueOn:"",externalRef:record.ref,poRef:"",
        narration:record.description,notes:"",reason:"",originalInvoiceId:null,exchangeReturnId:null,withholding:"0",duplicateReason:"",
        lines:[{itemId,description:record.description,quantity,rate,discount:"0",tax:"0",historicalCost:"0",originalLineNo:null,disposition:"saleable"}],
        payments:data.cashId ? [{accountId:identifier.parse(data.cashId),amount:total.toFixed(2)}] : []});
      const invoice=await saveInvoice(tx,context,{input,intent:"post",version:0,reason:data.reason});
      linkedInvoiceId=invoice.id;
    }
    const [after]=await tx.update(manualRegisterRows).set({status:"linked",linkedVoucherId,linkedInvoiceId,version:before.version+1})
      .where(eq(manualRegisterRows.id,before.id)).returning();
    await tx.insert(revisions).values({companyId,entityType:"register",entityId:before.id,version:after.version,actorId,
      previousData:before,nextData:after,reason:data.reason});
    await tx.insert(auditLogs).values({companyId,actorId,action:"register.linked",data:{id:before.id,linkedVoucherId,linkedInvoiceId,reason:data.reason}});
    return {id:before.id};
  });
}
