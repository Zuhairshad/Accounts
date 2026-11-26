import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Exact, accountDate, amount } from "@/lib/engine/model";
import { manualRegisterRows, reportSettings } from "@/db/schema";
import { companySql, type Reader } from "./journal";
import { tradeRows } from "./operational";
import { blankCell, dateCell, defaults, integerCell, layoutSchema, moneyCell, registerColumns, sum, textCell,
  type RegisterId, type ReportDocument, type ReportFilter, type ReportRow } from "./model";

const maybeAmount = z.union([amount,z.literal("")]);
const registerValue = z.union([z.string().regex(/^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,2})?$/),z.literal("")]);
export const registerPayload = z.object({
  date:z.union([accountDate,z.literal("")]), ref:z.string().trim().max(120), description:z.string().trim().max(240),
  type:z.string().trim().max(50), partyId:z.uuid().nullable(),
  first:registerValue, second:registerValue,
});
export type RegisterPayload = z.infer<typeof registerPayload>;
export const emptyRegister: RegisterPayload = { date:"",ref:"",description:"",type:"",partyId:null,first:"",second:"" };

export function signedAmounts(kind:RegisterId,input:RegisterPayload) {
  const first = new Exact(input.first || 0), second = new Exact(input.second || 0);
  if (kind==="sale-purchase" && input.type.endsWith("_return")) return [first.abs().negated(),second.abs().negated()] as const;
  return [first,second] as const;
}
export function isComplete(kind:RegisterId,input:RegisterPayload) {
  if (!input.date || !input.type || (!input.description && !input.partyId)) return false;
  const [first,second] = signedAmounts(kind,input);
  const onlyOne = first.isZero() !== second.isZero();
  if (kind==="day-book") return onlyOne && maybeAmount.safeParse(input.first).success && maybeAmount.safeParse(input.second).success;
  if (!["sale","sale_return","purchase","purchase_return"].includes(input.type)) return false;
  const chosen = input.type.startsWith("sale") ? second : first;
  return onlyOne && !chosen.isZero() && (input.type.endsWith("_return") ? chosen.lt(0) : chosen.gt(0));
}

export async function registerSetting(db:Reader,company:string,kind:RegisterId) {
  const [row] = await db.select().from(reportSettings).where(and(eq(reportSettings.companyId,company),eq(reportSettings.key,kind)));
  const raw = (row?.settings ?? {}) as {layout?:unknown;direction?:unknown;initial?:unknown;perspective?:unknown};
  const layout = layoutSchema.safeParse(raw.layout);
  const initial = typeof raw.initial==="string" && registerValue.safeParse(raw.initial).success && raw.initial ? raw.initial : "0";
  const perspective: "cash"|"bank"|"manual" = raw.perspective==="cash" || raw.perspective==="bank" ? raw.perspective : "manual";
  return { layout:layout.success ? layout.data : defaults[kind], direction:raw.direction==="cr-dr" ? "cr-dr" as const : "dr-cr" as const,
    initial, perspective, version:row?.version ?? 0 };
}

type Named = {id:string;name:string};
type Parts = Pick<ReportDocument,"columns"|"rows"|"notes"|"warning"|"layout">;
export type RegisterLine = { id:string; companyId:string; day:string; ref:string; description:string; type:string; first:string; second:string; balance?:string; time:Date; href?:string };
function rowCells(kind:RegisterId,source:RegisterLine,index:number):ReportRow {
  const serial=integerCell(index+1);
  if (kind==="day-book") return {key:source.id,cells:[serial,dateCell(source.day),textCell(source.type,source.href),textCell(source.description,source.href),
    moneyCell(source.first),moneyCell(source.second),moneyCell(source.balance ?? "0")]};
  return { key:source.id,cells:[serial,dateCell(source.day),textCell(source.ref,source.href),textCell(source.description,source.href),
    textCell(source.type),moneyCell(source.first),moneyCell(source.second)] };
}
const match = (row:RegisterLine,q:string) => !q || `${row.ref} ${row.description} ${row.type}`.toLowerCase().includes(q.toLowerCase());

export async function manualRows(db:Reader,ids:string[],kind:RegisterId,from:string,to:string,deleted=false,all=false) {
  return (await db.execute<{id:string;companyId:string;date:string|null;payload:RegisterPayload;status:string;version:number;createdAt:Date;party:string|null}>(sql`
    SELECT r.id,r.company_id AS "companyId",r.accounting_date::text AS date,r.payload,r.status,r.version,r.created_at AS "createdAt",p.name AS party
    FROM manual_register_rows r LEFT JOIN parties p ON p.company_id=r.company_id AND p.id::text=r.payload->>'partyId'
    WHERE r.company_id IN (${companySql(ids)}) AND r.register=${kind}
      AND (${deleted} AND r.status='void' OR NOT ${deleted} AND r.status IN ('draft','saved'))
      AND (r.accounting_date BETWEEN ${from}::date AND ${to}::date OR (${all} AND (r.accounting_date IS NULL OR r.status='draft')))
    ORDER BY r.accounting_date NULLS LAST,r.created_at,r.id
  `)).rows;
}

async function informational(db:Reader,names:Named[],kind:RegisterId,f:ReportFilter) {
  const ids=names.map((n)=>n.id);
  const entries=await manualRows(db,ids,kind,kind==="day-book" ? "1900-01-01" : f.from,f.to);
  const balance=new Map<string,InstanceType<typeof Exact>>();
  const direction=new Map<string,number>();
  if (kind==="day-book") {
    for (const name of names) {
      const settings=await registerSetting(db,name.id,kind);
      balance.set(name.id,new Exact(settings.initial));
      direction.set(name.id,settings.direction==="cr-dr" ? -1 : 1);
    }
  }
  return entries.filter((r)=>r.status==="saved").flatMap((r):RegisterLine[]=>{
    const [first,second]=signedAmounts(kind,r.payload);
    const previous=balance.get(r.companyId);
    const closing=previous?.plus(first.minus(second).times(direction.get(r.companyId) ?? 1));
    if (closing) balance.set(r.companyId,closing);
    if (!r.date || r.date<f.from) return [];
    return [{id:r.id,companyId:r.companyId,day:r.date,ref:r.payload.ref,type:r.payload.type,first:first.toFixed(2),second:second.toFixed(2),
      balance:closing?.toFixed(2),description:[r.payload.description,r.party].filter(Boolean).join(" · "),time:r.createdAt}];
  });
}

async function postedDay(db:Reader,ids:string[],f:ReportFilter) {
  const rows=(await db.execute<RegisterLine>(sql`
    WITH book AS (
      SELECT e.document_id AS id,e.company_id AS "companyId",e.accounting_date AS day,e.number AS ref,e.type::text AS type,
        e.created_at AS time,concat_ws(' · ',nullif(e.narration,''),max(coalesce(p.name,linked.names))) AS description,sum(l.debit) AS dr,sum(l.credit) AS cr
      FROM effective_vouchers e JOIN journal_lines l ON l.company_id=e.company_id AND l.voucher_id=e.id
      JOIN accounts a ON a.company_id=l.company_id AND a.id=l.account_id
      LEFT JOIN invoices i ON i.company_id=e.company_id AND i.voucher_id=e.id
      LEFT JOIN parties p ON p.company_id=i.company_id AND p.id=i.party_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT party.name,' / ' ORDER BY party.name) AS names
        FROM journal_lines entry JOIN parties party ON party.company_id=entry.company_id AND party.id=entry.party_id
        WHERE entry.company_id=e.company_id AND entry.voucher_id=e.id
      ) linked ON i.id IS NULL
      WHERE e.company_id IN (${companySql(ids)}) AND e.accounting_date<=${f.to}::date AND a.liquidity=${f.perspective}
        AND (${f.account ?? null}::uuid IS NULL OR a.id=${f.account ?? null}::uuid)
      GROUP BY e.document_id,e.company_id,e.accounting_date,e.number,e.type,e.created_at,e.narration
    ), running AS (
      SELECT *,sum(dr-cr) OVER (PARTITION BY "companyId" ORDER BY day,time,id) AS bal FROM book
    )
    SELECT id,"companyId",day::text,ref,type,time,description,dr::text AS first,cr::text AS second,bal::text AS balance
    FROM running WHERE day>=${f.from}::date ORDER BY day,time,"companyId",id
  `)).rows;
  return rows.map((row)=>({...row,href:`/workspace/${row.companyId}/accounting/vouchers/${row.id}`}));
}

export async function registerReport(db:Reader,names:Named[],home:string,kind:RegisterId,f:ReportFilter):Promise<Parts> {
  const settings=await registerSetting(db,home,kind);
  const columns=registerColumns[kind];
  const ids=names.map((n)=>n.id);
  const manual=kind==="day-book" ? f.perspective==="manual" : f.mode==="manual";
  const source: RegisterLine[] = f.blank ? [] : manual ? await informational(db,names,kind,f) : kind==="day-book"
    ? await postedDay(db,ids,f)
    : (await tradeRows(db,ids,f)).map((row)=>{
      const value=new Exact(row.total).times(row.type.endsWith("_return") ? -1 : 1).toFixed(2);
      return {id:row.id,companyId:row.companyId,day:row.day,ref:row.number,type:row.type.replaceAll("_"," "),
        description:[row.narration,row.party].filter(Boolean).join(" · "),first:row.type.startsWith("purchase") ? value : "0",
        second:row.type.startsWith("sale") ? value : "0",time:row.postedAt,href:`/workspace/${row.companyId}/trade/invoices/${row.id}`};
    });
  const visible=source.filter((row)=>match(row,f.search) && (!f.voucherType || row.type.replaceAll(" ","_")===f.voucherType))
    .map((row)=>names.length>1 ? {...row,description:`${names.find((n)=>n.id===row.companyId)?.name} · ${row.description}`} : row)
    .sort((a,b)=>a.day.localeCompare(b.day) || a.time.getTime()-b.time.getTime() || a.companyId.localeCompare(b.companyId) || a.id.localeCompare(b.id));
  const rows=visible.map((row,index)=>rowCells(kind,row,index));
  if (kind==="sale-purchase") rows.push({key:"register-total",style:"total",cells:[blankCell(),blankCell(),blankCell(),textCell("Total:"),blankCell(),
    f.blank ? blankCell() : moneyCell(sum(visible,(row)=>row.first)),f.blank ? blankCell() : moneyCell(sum(visible,(row)=>row.second))]});
  return {columns,rows,layout:settings.layout,notes:manual ? [
    kind==="day-book" ? "Register-only rows are informational. Each company has its own opening and balance direction." : "Register-only entries are informational. Returns reduce purchase or sale totals.",
  ] : [
    kind==="day-book" ? "Posted cash or bank figures use the selected account perspective. Debit increases the balance, and credit decreases it. Combined registers keep separate running balances by company." :
      "Posted invoices appear once. Sale and purchase returns reduce their own columns. Totals include applicable invoice tax.",
  ]};
}
