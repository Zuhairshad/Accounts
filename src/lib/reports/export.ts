import ExcelJS from "exceljs";
import { PassThrough,Readable } from "node:stream";
import { Exact } from "@/lib/engine/model";
import { displayDate } from "@/lib/validation";
import { isRegister,showCell,type Cell,type ReportDocument } from "./model";

function exactExcelValue(cell:Cell) {
  if (!cell.value) return "";
  if (cell.kind==="money" || cell.kind==="quantity" || cell.kind==="integer") {
    const number=Number(cell.value);
    const significant=cell.value.replace(/^-?0*\.?0*/,"").replace(".","").replace(/0+$/,"").length;
    if (Number.isFinite(number) && significant<=15 && new Exact(String(number)).eq(cell.value)) return number;
    return cell.value;
  }
  return showCell(cell);
}

export function workbookReport(document:ReportDocument) {
  const pass=new PassThrough();
  const book=new ExcelJS.stream.xlsx.WorkbookWriter({stream:pass,useStyles:true,useSharedStrings:false});
  const sheet=book.addWorksheet(document.title.replace(/[\\/:*?\[\]]/g,"-").slice(0,31),{views:[{state:"frozen",ySplit:isRegister(document.id)?2:4}]});
  sheet.columns=document.columns.map((col)=>({width:Math.min(52,Math.max(16,col.length+4))}));
  const commit=(cells:(string|number)[],bold=false)=>{
    const row=sheet.addRow(cells);
    if (bold) row.font={bold:true};
    row.commit();
  };
  void (async()=>{
    commit([document.title],true);
    if (!isRegister(document.id)) {
      commit([document.scope.join(" · "),...document.companyDetails]);
      commit([`${displayDate(document.from)} to ${displayDate(document.to)}`,document.generatedAt]);
    }
    commit(document.columns,true);
    for (const data of document.rows) {
      const row=sheet.addRow(document.columns.map((_,index)=>data.cells[index]?exactExcelValue(data.cells[index]):""));
      for (let i=0;i<data.cells.length;i++) {
        if (data.cells[i].kind==="money" && typeof row.getCell(i+1).value==="number") row.getCell(i+1).numFmt='#,##0.00;[Red]-#,##0.00';
      }
      if (data.style) row.font={bold:true};
      row.commit();
    }
    if (!isRegister(document.id)) {
      if (document.warning) commit([document.warning],true);
      for (const note of document.notes) commit([note]);
    }
    sheet.commit();
    await book.commit();
  })().catch((error)=>pass.destroy(error instanceof Error ? error : new Error("Workbook export failed")));
  return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
}

function csvValue(cell:Cell) {
  const raw=cell.kind==="money" || cell.kind==="quantity" || cell.kind==="integer" ? cell.value : showCell(cell);
  const value=!cell.kind && /^[\s\uFEFF]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${value.replaceAll('"','""')}"`;
}

export function csvReport(document:ReportDocument) {
  return Readable.toWeb(Readable.from((function*(){
    yield Buffer.from("\uFEFF");
    yield Buffer.from(document.columns.map((value)=>csvValue({value})).join(",")+"\r\n");
    for (const row of document.rows) yield Buffer.from(document.columns.map((_,i)=>csvValue(row.cells[i] ?? {value:""})).join(",")+"\r\n");
  })())) as ReadableStream<Uint8Array>;
}
