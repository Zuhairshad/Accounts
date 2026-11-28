import Link from "next/link";
import { ArrowLeft,SearchX } from "lucide-react";
import { displayDate } from "@/lib/validation";
import { isRegister,type ReportDocument,type ReportRow } from "@/lib/reports/model";
import { printPlan } from "@/lib/reports/print";
import { PrintButton } from "./print-button";
import { ReportRows } from "./report-rows";

/** Statements whose plain account rows sit under section headings, so the screen view indents them. */
const statements=new Set(["profit-loss","balance-sheet","company-wise","combined-heads"]);

/** A column is right-aligned on screen when its figures are amounts, quantities or counts. */
const numericColumn=(rows:ReportRow[],index:number)=>rows.some((row)=>["money","quantity","integer"].includes(row.cells[index]?.kind ?? ""));

export function ReportTable({document,rows}:{document:ReportDocument;rows:ReportRow[]}) {
  const register=isRegister(document.id);
  return <section className={`panel data-panel ${register?"register-paper rep-paper":"rep-table-card"}`}>
    {register && <h2 className="register-title">{document.title}</h2>}
    <div className="table-scroll"><table className={register?"register-print-table":`report-data-table rep-table${statements.has(document.id)?" rep-statement":""}`}>
      {register && document.layout && <colgroup>{document.layout.widths.map((width,i)=><col key={i} style={{width:`${width/document.layout!.widths.reduce((a,b)=>a+b,0)*100}%`}} />)}</colgroup>}
      <thead><tr>{document.columns.map((col,i)=><th scope="col" key={col} className={!register && numericColumn(document.rows,i) ? "report-number" : undefined}>{col}</th>)}</tr></thead>
      <ReportRows columns={document.columns.length} rows={rows} />
      {register && rows.length===0 && <tbody>{Array.from({length:6},(_,i)=><tr key={i}>{document.columns.map((_,j)=><td key={j}>&nbsp;</td>)}</tr>)}</tbody>}
    </table></div>
    {!rows.length && !register && <div className="empty rep-empty"><span className="empty-icon" aria-hidden><SearchX size={19} /></span>
      <strong>No transactions match the selected filters</strong><p>Widen the dates or clear a filter to see more rows.</p></div>}
  </section>;
}

export function PrintableReport({document,returnHref}:{document:ReportDocument;returnHref:string}) {
  const paper=printPlan(document);
  const register=isRegister(document.id);
  return <div className="report-preview">
    <style>{`@page { size: A4 ${paper.landscape?"landscape":"portrait"}; margin:0; }`}</style>
    <div className="rep-preview-bar print-hide"><Link className="button button-outline button-small" href={returnHref}><ArrowLeft size={15} aria-hidden />Back to report</Link>
      <span className="muted">Print preview · {document.title}</span><PrintButton /></div>
    {paper.pages.map((rows,index)=><article key={index} className="report-preview-page" style={{width:`${paper.width}pt`,minHeight:`${paper.height}pt`,padding:`${paper.margin}pt`,fontSize:`${paper.font}pt`}}>
      <h1 className={register?"register-title":"report-preview-title"}>{document.title}</h1>
      {!register && <div className="report-preview-meta">
        <p>{document.scope.join(" · ")}</p>{document.companyDetails.map((value,i)=><p key={i}>{value}</p>)}
        <p>{displayDate(document.from)} to {displayDate(document.to)} · Generated {new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Karachi"}).format(new Date(document.generatedAt))} PKT</p>
        {document.warning && <p><strong>{document.warning}</strong></p>}
        {document.notes.map((note,i)=><p key={i}>{note}</p>)}
      </div>}
      <table className="register-print-table" style={{minWidth:0}}>
        <colgroup>{paper.widths.map((w,i)=><col key={i} style={{width:`${w*100}%`}} />)}</colgroup>
        <thead><tr style={{height:`${paper.header.height}pt`}}>{document.columns.map((col)=><th key={col} scope="col">{col}</th>)}</tr></thead>
        <tbody>{rows.map((row)=><tr key={row.row.key} style={{height:`${row.height}pt`}} className={row.row.style?`report-row-${row.row.style}`:undefined}>
          {document.columns.map((_,i)=><td key={i} className={row.row.cells[i]?.kind && ["money","quantity","integer"].includes(row.row.cells[i].kind!)?"report-number":undefined}>
            {row.content[i] || "\u00a0"}</td>)}
        </tr>)}</tbody>
      </table>
      {!register && <footer>{index+1} / {paper.pages.length}</footer>}
    </article>)}
  </div>;
}
