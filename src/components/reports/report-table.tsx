import Link from "next/link";
import { displayDate } from "@/lib/validation";
import { isRegister,type ReportDocument,type ReportRow } from "@/lib/reports/model";
import { printPlan } from "@/lib/reports/print";
import { PrintButton } from "./print-button";
import { ReportRows } from "./report-rows";

export function ReportTable({document,rows}:{document:ReportDocument;rows:ReportRow[]}) {
  const register=isRegister(document.id);
  return <section className={`panel data-panel ${register?"register-paper":""}`}>
    {register && <h2 className="register-title">{document.title}</h2>}
    <div className="table-scroll"><table className={register?"register-print-table":"report-data-table"}>
      {register && document.layout && <colgroup>{document.layout.widths.map((width,i)=><col key={i} style={{width:`${width/document.layout!.widths.reduce((a,b)=>a+b,0)*100}%`}} />)}</colgroup>}
      <thead><tr>{document.columns.map((col)=><th scope="col" key={col}>{col}</th>)}</tr></thead>
      <ReportRows columns={document.columns.length} rows={rows} />
      {register && rows.length===0 && <tbody>{Array.from({length:6},(_,i)=><tr key={i}>{document.columns.map((_,j)=><td key={j}>&nbsp;</td>)}</tr>)}</tbody>}
    </table></div>
    {!rows.length && !register && <div className="empty"><strong>No transactions match the selected filters</strong></div>}
  </section>;
}

export function PrintableReport({document,returnHref}:{document:ReportDocument;returnHref:string}) {
  const paper=printPlan(document);
  const register=isRegister(document.id);
  return <div className="report-preview">
    <style>{`@page { size: A4 ${paper.landscape?"landscape":"portrait"}; margin:0; }`}</style>
    <div className="finance-toolbar print-hide mb-4"><Link className="text-link" href={returnHref}>Back to report</Link><PrintButton /></div>
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
