import { randomUUID } from "node:crypto";
import { eq,sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import ExcelJS from "exceljs";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import type { Database,Transaction } from "../src/db";
import * as schema from "../src/db/schema";
import { insertCompany } from "../src/db/seed";
import { idempotently } from "../src/lib/accounting";
import { changeVoucher,saveManual,type FinanceContext } from "../src/lib/engine/vouchers";
import { saveInvoice,saveItem } from "../src/lib/trade/service";
import type { InvoiceInput } from "../src/lib/trade/model";
import { buildReport,filters } from "../src/lib/reports/build";
import { csvReport,workbookReport } from "../src/lib/reports/export";
import { defaults,registerColumns,showCell,type ReportDocument,type ReportId } from "../src/lib/reports/model";
import { pdfReport } from "../src/lib/reports/pdf";
import { printPlan } from "../src/lib/reports/print";
import { RegisterConflict,registerWrite } from "../src/lib/reports/register-write";

const testDb=process.env.AZAM_TEST_DATABASE_URL;
const feb={from:"2024-02-29",to:"2024-02-29",includeOpening:"1"};
const table=(doc:ReportDocument,key:string)=>doc.rows.find((r)=>r.key===key)?.cells.map((c)=>c.value);

describe.skipIf(!testDb)("Phase 4 reporting against PostgreSQL",()=>{
  let pool:Pool, db:Database;
  beforeAll(async ()=>{
    if (!testDb || !new URL(testDb).pathname.endsWith("_test")) throw new Error("Use an isolated _test database.");
    pool=new Pool({connectionString:testDb});db=drizzle(pool,{schema});
  });
  afterAll(async ()=>{await pool?.end();});

  async function fixture(label:string) {
    const result=await db.transaction(async (tx)=>{
      const tag=randomUUID();
      const company=await insertCompany(tx,`${label} ${tag}`);
      const companyId=company.id;
      const [actor]=await tx.insert(schema.users).values({username:`reports-${tag}`,displayName:"Report tester",passwordHash:"test-only"}).returning();
      for(const year of [2023,2024]) {
        const [book]=await tx.insert(schema.financialYears).values({companyId,name:String(year),startsOn:`${year}-01-01`,endsOn:`${year}-12-31`}).returning();
        await tx.insert(schema.periods).values({companyId,yearId:book.id,startsOn:book.startsOn,endsOn:book.endsOn});
      }
      const heads=Object.fromEntries((await tx.select().from(schema.accounts).where(eq(schema.accounts.companyId,companyId))).map((n)=>[n.control ?? n.code,n.id]));
      const ctx:FinanceContext={companyId,actorId:actor.id,require:()=>undefined};
      const item=await saveItem(tx,ctx,{sku:"PH4-1",name:"Report stock",unit:"unit",kind:"stock",category:"",description:"",reorder:"0",active:true,purchaseAccountId:null},undefined,0);
      const [customer,supplier]=await tx.insert(schema.parties).values([{companyId,name:"Report customer",type:"customer"},{companyId,name:"Report supplier",type:"supplier"}]).returning();
      return {company,companyId,actor,heads,item:item.id,customer:customer.id,supplier:supplier.id,ctx};
    });
    const lock=<T,>(fn:(tx:Transaction)=>Promise<T>)=>db.transaction(async(tx)=>{
      await tx.execute(sql`SELECT id FROM companies WHERE id=${result.companyId} FOR UPDATE`);return fn(tx);
    });
    const post=(day:string,dr:string,cr:string,value:string)=>lock((tx)=>saveManual(tx,result.ctx,{intent:"post",version:0,reason:"Reporting fixture",entry:{
      type:"JV",date:day,reference:"MIS-R",narration:"Report fixture voucher",mode:"direct",lines:[
        {accountId:result.heads[dr],partyId:null,debit:value,credit:"0",description:""},
        {accountId:result.heads[cr],partyId:null,debit:"0",credit:value,description:""},
      ],
    }}));
    const inspect=(id:ReportId,query:Record<string,string>=feb,companies=[result.company])=>
      buildReport(db,id,result.companyId,companies,filters(query,"manual"),"2024-01-01");
    async function trade(type:InvoiceInput["type"],day:string,qty:string,rate:string,orig:string|null=null,repeat=false) {
      const line={itemId:result.item,description:"Report line",quantity:qty,rate,discount:"0",tax:"0",historicalCost:"0",
        originalLineNo:orig?1:null,disposition:"saleable" as const};
      return lock((tx)=>saveInvoice(tx,result.ctx,{intent:"post",version:0,reason:"Report trade fixture",input:{
        type,date:day,partyId:type.startsWith("sale")?result.customer:result.supplier,dueOn:"",externalRef:"",poRef:"",
        narration:"Trade report voucher",notes:"",reason:"Accepted return",originalInvoiceId:orig,exchangeReturnId:null,
        withholding:"0",duplicateReason:"",lines:repeat?[line,line]:[line],payments:[],
      }}));
    }
    return {...result,lock,post,trade,inspect};
  }

  it("reconciles month-end and leap-day statements without double counting income or inventory",async()=>{
    const f=await fixture("Financial report");
    await f.post("2023-12-30","cash","capital","10000");
    await f.post("2023-12-30","cash","sales","25");
    await f.post("2023-12-31","sales","retained_earnings","25");
    await f.trade("purchase","2024-02-01","10","1000");
    const sale=await f.trade("sale","2024-02-29","2","1500",null,true);
    await f.trade("sale_return","2024-02-29","1","0",sale.id);
    await f.post("2024-02-29","5100","cash","15");
    await f.post("2024-03-01","cash","sales","400");
    const report=await f.inspect("profit-loss");
    expect(table(report,"Gross Sales")?.at(-1)).toBe("6000.00");
    expect(table(report,"Net Sales")?.at(-1)).toBe("4500.00");
    expect(table(report,"Cost of Goods Sold")?.at(-1)).toBe("3000.00");
    expect(table(report,"Operating Expenses")?.at(-1)).toBe("15.00");
    expect(table(report,"Net Profit / Loss")?.at(-1)).toBe("1485.00");
    const balance=await f.inspect("balance-sheet");
    expect(table(balance,"Reconciliation difference")?.at(-1)).toBe("0.00");
    expect(table(balance,"current")?.at(-1)).toBe("1485.00");
    expect(table(balance,"earlier")?.at(-1)).toBe("0.00");
    const trial=await f.inspect("trial-balance",{...feb,mode:"movement"});
    expect(trial.warning).toBeUndefined();
    expect(table(trial,"total")?.at(-1)).toBe(table(trial,"total")?.at(-2));
    const valuation=await f.inspect("inventory-valuation");
    expect(table(valuation,"total")?.at(-1)).toBe("7000.00");
    expect(table(valuation,"inventory-gl")?.at(-1)).toBe("7000.00");
    expect(valuation.warning).toBeUndefined();
    expect(table(await f.inspect("debtors"),f.customer)?.[6]).toBe("4500.00");
    const sales=await f.inspect("sales");
    expect(sales.rows.length).toBe(3);
    expect(table(sales,"total")?.at(-1)).toBe("4500.00");
    const mis=await f.inspect("mis");
    expect(table(mis,f.heads.capital)?.slice(-6)).toEqual(["0.00","10000.00","0.00","0.00","0.00","10000.00"]);
    expect((await f.inspect("mis",{...feb,mode:"vouchers",invoice:sale.id})).rows.filter((r)=>r.group).length).toBeGreaterThan(2);
    expect(()=>filters({day:"2023-02-29"},"manual")).toThrow(/valid range/);
  });

  it("renders a historical posted voucher once across void and restored revisions",async()=>{
    const f=await fixture("Historical");
    const posted=await f.post("2024-02-29","cash","sales","430");
    const [root]=await db.select().from(schema.voucherDocuments).where(eq(schema.voucherDocuments.id,posted.id));
    const captured=(await db.execute<{stamp:string}>(sql`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp
    `)).rows[0].stamp;
    await f.lock((tx)=>changeVoucher(tx,f.ctx,{id:root.id,version:root.version,operation:"delete",reason:"Audit history test"}));
    expect((await f.inspect("mis",{...feb,mode:"vouchers"})).rows).toHaveLength(0);
    const voided=await f.inspect("mis",{...feb,mode:"vouchers",status:"void"});
    expect(voided.rows.every((r)=>r.cells[voided.columns.indexOf("Status")]?.value==="void")).toBe(true);
    expect(table(await f.inspect("mis",{...feb,recordedAt:captured}),"total")?.slice(5,7)).toEqual(["430.00","430.00"]);
    await f.lock((tx)=>changeVoucher(tx,f.ctx,{id:root.id,version:root.version+1,operation:"restore",reason:"Restore verified original"}));
    expect(table(await f.inspect("mis"),"total")?.slice(5,7)).toEqual(["430.00","430.00"]);
    expect((await f.inspect("voucher-register")).rows.length).toBe(2);
  });

  it("merges only mapped matching classifications and keeps company subtotals",async()=>{
    const a=await fixture("Combined A");const b=await fixture("Combined B");
    await a.post("2024-02-29","cash","4100","90");await b.post("2024-02-29","cash","4100","10");
    const names=[a.company,b.company];
    const before=await a.inspect("combined-heads",feb,names);
    expect(before.rows.filter((r)=>r.key.startsWith("unmapped")).length).toBe(2);
    await db.insert(schema.reportAccountMappings).values([
      {companyId:a.companyId,accountId:a.heads["4100"],groupKey:"misc-income",type:"income",label:"Shared income"},
      {companyId:b.companyId,accountId:b.heads["4100"],groupKey:"misc-income",type:"income",label:"Shared income"},
    ]);
    const after=await a.inspect("combined-heads",feb,names);
    expect(table(after,"mapping:misc-income:income")?.[6]).toBe("100.00");
    expect((await a.inspect("company-wise",feb,names)).rows.filter((r)=>r.key.endsWith("-total")).length).toBe(2);
  });

  it("preserves drafts and version conflicts, deduplicates retries, and excludes informational rows from the journal",async()=>{
    const f=await fixture("Register");
    const id=randomUUID();
    const payload={date:"2024-02-29",ref:"TEST-REF",description:"Manual entry",type:"JV",partyId:null,first:"85.00",second:""};
    const first=await f.lock((tx)=>registerWrite(tx,f.ctx,{id,version:0,kind:"day-book",operation:"save",payload:{...payload,description:""}}));
    expect(first.status).toBe("draft");
    const idem={companyId:f.companyId,operation:"register.day-book",key:randomUUID(),actorId:f.actor.id,requestHash:"verified-test-body"};
    const update=()=>f.lock((tx)=>idempotently(tx,idem,()=>registerWrite(tx,f.ctx,{id,version:1,kind:"day-book",operation:"save",payload})));
    const [newer,duplicate]=await Promise.all([update(),update()]);
    expect(newer).toEqual({id,version:2,status:"saved"});
    expect(duplicate).toEqual(newer);
    await expect(f.lock((tx)=>registerWrite(tx,f.ctx,{id,version:1,kind:"day-book",operation:"save",payload}))).rejects.toBeInstanceOf(RegisterConflict);
    expect(table(await f.inspect("day-book"),id)?.at(-1)).toBe("85.00");
    expect((await f.inspect("voucher-register")).rows).toHaveLength(0);
    await f.lock((tx)=>registerWrite(tx,f.ctx,{id,version:2,kind:"day-book",operation:"void",reason:"Verify deletion"}));
    expect((await f.inspect("day-book")).rows).toHaveLength(0);
    await f.lock((tx)=>registerWrite(tx,f.ctx,{id,version:3,kind:"day-book",operation:"restore",reason:"Verify restore"}));
    expect((await f.inspect("day-book")).rows).toHaveLength(1);
  });
});

describe("Phase 4 file formats and print pagination",()=>{
  const dataset:ReportDocument={id:"sale-purchase",title:"Sale / Purchase",scope:["Test company"],companyDetails:[],from:"2024-02-01",to:"2024-02-29",
    generatedAt:"2024-02-29T15:00:00Z",columns:registerColumns["sale-purchase"],layout:defaults["sale-purchase"],notes:[],
    rows:[{key:"example",cells:[{value:"1",kind:"integer"},{value:"2024-02-29",kind:"date"},{value:"PI-1"},{value:"=HYPERLINK(evil)"},{value:"Purchase"},{value:"125.75",kind:"money"},{value:"0.00",kind:"money"}]},
      {key:"register-total",style:"total",cells:[{value:""},{value:""},{value:""},{value:"Total:"},{value:""},{value:"125.75",kind:"money"},{value:"0.00",kind:"money"}]}]};
  it("preserves column order and exact values in valid CSV, Excel and PDF",async()=>{
    const csv=await new Response(csvReport(dataset)).text();
    expect(csv).toContain('\"Sr #\",\"Date\",\"Vr/Inv #\"');
    expect(csv).toContain('"125.75"');
    expect(csv).toContain("'=HYPERLINK");
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(await new Response(workbookReport(dataset)).arrayBuffer() as ExcelJS.Buffer);
    expect(book.worksheets[0].getRow(2).getCell(7).value).toBe("Sale Amount");
    expect(book.worksheets[0].getRow(4).getCell(6).value).toBe(125.75);
    const pdf=await new Response(await pdfReport(dataset)).arrayBuffer();
    expect(Buffer.from(pdf).subarray(0,4).toString()).toBe("%PDF");
    const planned=printPlan(dataset);
    expect(planned.pages[0].at(-1)?.content[3]).toBe("Total:");
    expect(planned.pages[0][0].content[5]).toBe(showCell(dataset.rows[0].cells[5]));
  });
  it("keeps all rows in a large spreadsheet and repeats page structure without duplicating the total",async()=>{
    const rows=Array.from({length:1800},(_,i)=>({...dataset.rows[0],key:String(i)}));
    const big={...dataset,rows:[...rows,dataset.rows[1]]};
    const plan=printPlan(big);
    expect(plan.pages.length).toBeGreaterThan(50);
    expect(plan.pages.flat().filter((r)=>r.row.key==="register-total")).toHaveLength(1);
    expect(plan.pages.flat().filter((r)=>!/blank|total/.test(r.row.key))).toHaveLength(1800);
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(await new Response(workbookReport(big)).arrayBuffer() as ExcelJS.Buffer);
    expect(book.worksheets[0].getRow(1803).getCell(6).value).toBe(125.75);
    const pdf=Buffer.from(await new Response(await pdfReport(big)).arrayBuffer()).toString("latin1");
    expect(pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(plan.pages.length);
  });
});
