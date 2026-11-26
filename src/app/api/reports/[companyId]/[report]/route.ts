import { loadReport } from "@/lib/reports/access";
import { csvReport,workbookReport } from "@/lib/reports/export";
import { pdfReport } from "@/lib/reports/pdf";
import { isReport } from "@/lib/reports/model";
import { AccessError } from "@/lib/auth";
import { AccountingError } from "@/lib/engine/model";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request,{params}:{params:Promise<{companyId:string;report:string}>}) {
  const {companyId,report}=await params;
  if (!isReport(report)) return new Response(null,{status:404});
  const query=Object.fromEntries(new URL(request.url).searchParams);
  const format=query.format ?? "pdf";
  if (!["pdf","xlsx","csv"].includes(format)) return new Response(null,{status:404});
  const inline=format==="pdf" && query.inline==="1";
  try {
    const {document}=await loadReport(companyId,report,query,inline?"print":"export");
    const body=format==="pdf" ? await pdfReport(document) : format==="xlsx" ? workbookReport(document) : csvReport(document);
    const content=format==="pdf" ? "application/pdf" : format==="xlsx" ?
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8";
    return new Response(body,{headers:{"Content-Type":content,"Content-Disposition":`${inline?"inline":"attachment"}; filename="${report}-${document.from}-${document.to}.${format}"`,
      "Cache-Control":"private, no-store"}});
  } catch(error) {
    if (error instanceof AccessError) return new Response(null,{status:404});
    if (error instanceof AccountingError) return new Response(error.message,{status:422});
    console.error("Report export failed");
    return new Response("The report could not be generated.",{status:503});
  }
}
