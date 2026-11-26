import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import { displayDate } from "@/lib/validation";
import { isRegister,type ReportDocument } from "./model";
import { printPlan,type PrintedRow } from "./print";

const accountingTime=(stamp:string)=>new Intl.DateTimeFormat("en-GB",{
  dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Karachi",
}).format(new Date(stamp));

export async function pdfReport(document:ReportDocument) {
  const paper=printPlan(document);
  const register=isRegister(document.id);
  const width=paper.width-2*paper.margin;
  const pdf=new PDFDocument({autoFirstPage:false,margin:0,info:{
    Title:document.title,Author:register ? "AZAM EASY ACCOUNTS" : document.scope.join(", "),
  }});
  function singleLine(text:string,x:number,y:number,maxWidth:number,size:number,alignment:"left"|"center"|"right"="left") {
    pdf.fontSize(size);
    const measured=pdf.widthOfString(text);
    if (measured>maxWidth) pdf.fontSize(size*maxWidth/measured);
    const gap=maxWidth-pdf.widthOfString(text);
    const offset=alignment==="right" ? gap : alignment==="center" ? gap/2 : 0;
    pdf.text(text,x+offset,y,{lineBreak:false});
  }
  function drawRow(printed:PrintedRow,y:number,heading=false) {
    const strong=heading || Boolean(printed.row.style);
    const textSize=paper.font;
    pdf.font(strong ? "Helvetica-Bold" : "Helvetica");
    let x=paper.margin;
    for (const [index,weight] of paper.widths.entries()) {
      const colWidth=width*weight;
      if (!register && strong) pdf.rect(x,y,colWidth,printed.height).fill("#eef2f7");
      pdf.rect(x,y,colWidth,printed.height).lineWidth(0.35).stroke("#111");
      pdf.fillColor("#000");
      const numeric=!heading && ["money","integer","quantity"].includes(printed.row.cells[index]?.kind ?? "");
      for (const [line,text] of printed.content[index].split("\n").entries()) {
        singleLine(text,x+3,y+2+line*textSize*1.25,colWidth-6,textSize,numeric ? "right" : "left");
      }
      x+=colWidth;
    }
  }
  function metadata(text:string,y:number) {
    pdf.font("Helvetica").fontSize(8);
    const options={width,lineGap:1};
    const height=pdf.heightOfString(text,options);
    pdf.text(text,paper.margin,y,options);
    return y+height+3;
  }
  for (const [index,rows] of paper.pages.entries()) {
    pdf.addPage({size:[paper.width,paper.height],margin:0});
    pdf.fillColor("#000").font("Helvetica-Bold");
    singleLine(document.title,paper.margin,paper.margin,width,register ? 16 : 18,register ? "center" : "left");
    let y=paper.margin+(register ? 30 : 23);
    if (!register) {
      y=metadata(document.scope.join(" · "),y);
      for (const part of document.companyDetails) y=metadata(part,y);
      y=metadata(`${displayDate(document.from)} to ${displayDate(document.to)} · Generated ${accountingTime(document.generatedAt)} PKT`,y);
      if (document.warning) y=metadata(document.warning,y);
      for (const note of document.notes) y=metadata(note,y);
      y+=4;
    }
    drawRow(paper.header,y,true);
    y+=paper.header.height;
    for (const row of rows) {
      drawRow(row,y);
      y+=row.height;
    }
    if (!register) {
      pdf.fillColor("#334155").font("Helvetica");
      singleLine(document.title,paper.margin,paper.height-22,width,8);
      singleLine(`${index+1} / ${paper.pages.length}`,paper.margin,paper.height-22,width,8,"right");
    }
  }
  pdf.end();
  return Readable.toWeb(pdf) as ReadableStream<Uint8Array>;
}
