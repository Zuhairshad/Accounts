import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft,CalendarDays,ChevronLeft,ChevronRight,Download,FileSpreadsheet,FileText,Info,Printer,TriangleAlert } from "lucide-react";
import { AccessError } from "@/lib/auth";
import { accountingAccess } from "@/lib/engine/access";
import { AccountingError } from "@/lib/engine/model";
import { first,type Query } from "@/lib/range";
import { displayDate } from "@/lib/validation";
import { loadReport } from "@/lib/reports/access";
import { isRegister,isReport,showCell } from "@/lib/reports/model";
import { PageHeading } from "@/components/accounting/finance-ui";
import { Button } from "@/components/ui/button";
import { ReportFilters } from "@/components/reports/filter-bar";
import { PrintableReport,ReportTable } from "@/components/reports/report-table";
import { RegisterGrid } from "@/components/reports/register-grid";
import { ReportSettings } from "@/components/reports/settings";

export const dynamic="force-dynamic";

export default async function ReportPage({params,searchParams}:{params:Promise<{companyId:string;report:string}>;searchParams:Promise<Query>}) {
  const {companyId,report:id}=await params;
  const query=await searchParams;
  const root=`/workspace/${companyId}/reports`;
  await accountingAccess(companyId);
  if (id==="settings") return <ReportSettings companyId={companyId} />;
  if (!isReport(id)) notFound();
  const preview=first(query.preview)==="1";
  const href=(changes:Record<string,string|undefined>,api=false)=>{
    const fields=new URLSearchParams();
    for(const [key,val] of Object.entries(query)) {
      if (!["page","preview","format","inline"].includes(key) && first(val)) fields.set(key,first(val)!);
    }
    for(const [key,val] of Object.entries(changes)) if (val!==undefined) fields.set(key,val);else fields.delete(key);
    return `${api ? `/api/reports/${companyId}` : root}/${id}?${fields}`;
  };
  let data;
  try {data=await loadReport(companyId,id,query,preview?"print":"view",!preview);}
  catch(error) {
    if (error instanceof AccessError) notFound();
    if (error instanceof AccountingError) return <section className="panel rep-alert">
      <span className="stat-icon tone-red" aria-hidden><TriangleAlert size={19} /></span>
      <div><h1>Report filters need attention</h1><p role="alert" className="form-error">{error.message}</p>
        <Button asChild variant="outline" className="button-small"><Link href={`${root}/${id}`}>Reset report filters</Link></Button></div></section>;
    throw error;
  }
  const {document,filter,active,selection}=data;
  if (preview) return <PrintableReport document={document} returnHref={href({blank:undefined})} />;
  const can=(permission:"print"|"export")=>selection.every((company)=>company.permissions.includes(permission));
  const register=isRegister(id);
  const pageSize=100;
  const pages=Math.max(1,Math.ceil(document.rows.length/pageSize));
  const page=Math.min(pages,Math.max(1,Number.parseInt(first(query.page)??"1",10)||1));
  const manual=register && (id==="day-book" ? filter.perspective==="manual" : filter.mode==="manual");
  const rights={create:active.permissions.includes("create"),edit:active.permissions.includes("edit"),delete:active.permissions.includes("delete"),
    restore:active.permissions.includes("restore"),post:active.permissions.includes("post")};
  const local=selection.length===1 && selection[0].id===companyId;
  const balances=register ? Object.fromEntries(document.rows.map((row)=>[row.key, row.cells[6] ? showCell(row.cells[6]) : ""])) : {};
  return <div className="page-stack rep-page">
    <PageHeading title={document.title} company={document.scope.join(" · ")} toolbar={<>
      <Button asChild variant="ghost" className="button-small"><Link href={root}><ArrowLeft size={15} aria-hidden />All reports</Link></Button>
      {can("print") && <Button asChild variant="outline" className="button-small"><a href={href({preview:"1"})}><Printer size={15} /> Print Preview</a></Button>}
      {can("export") && <>
        <Button asChild variant="outline" className="button-small"><a href={href({format:"pdf"},true)}><Download size={15} /> Download PDF</a></Button>
        <Button asChild variant="outline" className="button-small"><a href={href({format:"xlsx"},true)}><FileSpreadsheet size={15} /> Download Excel</a></Button>
        <Button asChild variant="outline" className="button-small"><a href={href({format:"csv"},true)}><FileText size={15} /> Download CSV</a></Button>
      </>}
    </>} />
    <ReportFilters id={id} report={data} query={query} />
    <div className="finance-toolbar rep-meta print-hide">
      <span className="rep-period"><CalendarDays size={14} aria-hidden />{displayDate(document.from)} to {displayDate(document.to)}</span>
      {register && can("print") && <Link className="text-link" href={href({preview:"1",blank:"1"})}>Blank template preview</Link>}
      {register && can("export") && <a className="text-link" href={href({format:"pdf",blank:"1"},true)}>Blank template PDF</a>}
      {register && !manual && <Link className="text-link" href={href(id==="day-book"?{perspective:"manual"}:{mode:"manual"})}>Register-only entry</Link>}
      {manual && local && <Link className="text-link" href={href({deleted:filter.deleted?undefined:"1"})}>{filter.deleted?"Active register rows":"Deleted register rows"}</Link>}
      {document.warning && <p className="form-error" role="alert">{document.warning}</p>}
      {id==="balance-sheet" && document.warning && <Link className="text-link" href={`${root}/trial-balance?${new URLSearchParams({from:document.from,to:document.to})}`}>Open reconciliation trial balance</Link>}
    </div>
    {manual && local && !filter.blank && register && <RegisterGrid key={`${id}:${filter.deleted}:${filter.from}:${filter.to}`}
      companyId={companyId} kind={id} rows={data.drafts} contacts={data.contacts} accounts={data.heads.filter((r)=>r.active)}
      stock={data.stock.filter((r)=>r.active)} linkable={data.linkable} balances={balances}
      rights={rights} today={filter.to} deleted={filter.deleted} />}
    {!filter.deleted && <ReportTable document={document} rows={document.rows.slice((page-1)*pageSize,page*pageSize)} />}
    {pages>1 && !filter.deleted && <nav className="rep-pager print-hide">
      {page>1 && <Button asChild variant="outline" className="button-small"><Link href={href({page:String(page-1)})}><ChevronLeft size={15} aria-hidden />Previous page</Link></Button>}
      <span className="muted">Page {page} of {pages}. Downloads include every filtered row.</span>
      {page<pages && <Button asChild variant="outline" className="button-small"><Link href={href({page:String(page+1)})}>Next page<ChevronRight size={15} aria-hidden /></Link></Button>}
    </nav>}
    {document.notes.length>0 && <div className="rep-notes print-hide"><Info size={15} aria-hidden /><div>{document.notes.map((note,i)=><p key={i}>{note}</p>)}</div></div>}
  </div>;
}
