import { isRegister,showCell,type ReportDocument,type ReportRow } from "./model";

export type PrintedRow = { row:ReportRow; height:number; content:string[] };
export type PrintPlan = { landscape:boolean;width:number;height:number;margin:number;widths:number[];font:number;header:PrintedRow;pages:PrintedRow[][] };

function segments(value:string,capacity:number) {
  if (!value) return [""];
  return value.split(/\r?\n/).flatMap((block)=>{
    if (!block) return [""];
    const result:string[]=[];
    let rest=block;
    while (rest.length>capacity) {
      const at=rest.lastIndexOf(" ",capacity);
      const split=at>=Math.ceil(capacity/2)?at:capacity;
      result.push(rest.slice(0,split));
      rest=rest.slice(split).trimStart();
    }
    result.push(rest);return result;
  });
}

export function printPlan(document:ReportDocument):PrintPlan {
  const register=isRegister(document.id);
  const layout=document.layout;
  const landscape=!register && document.columns.length>=8;
  const width=landscape ? 841.89 : 595.28;
  const height=landscape ? 595.28 : 841.89;
  const margin=layout?.margin ?? 28;
  const weights=layout?.widths ?? document.columns.map((col)=>
    /description|narration|head|account name/i.test(col) ? 1.7 : /company|party|customer/i.test(col) ? 1.35 : /date|status|type|code/i.test(col) ? 1 : 1.15);
  const total=weights.reduce((sum,w)=>sum+w,0);
  const widths=weights.map((w)=>w/total);
  const font=register ? 7.3 : document.columns.length>9 ? 7 : 8;
  const minimum=layout?.rowHeight ?? 19;
  const lineHeight=font*1.25;
  const build=(row:ReportRow):PrintedRow=>{
    let maxRows=1;
    const content=document.columns.map((_,i)=>{
      const value=row.cells[i] ? showCell(row.cells[i]) : "";
      const capacity=Math.max(4,Math.floor(((width-2*margin)*widths[i]-7)/(font*0.59)));
      const lines=segments(value,capacity);
      maxRows=Math.max(maxRows,lines.length);
      return lines.join("\n");
    });
    return {row,content,height:Math.max(minimum,Math.ceil(maxRows*lineHeight+5))};
  };
  const header=build({key:"header",cells:document.columns.map((label)=>({value:label}))});
  const reserved=register ? 36 : 122 + document.notes.length*14 + (document.warning ? 24 : 0);
  const available=height-2*margin-reserved-header.height;
  const limit=layout?.slots ?? Number.POSITIVE_INFINITY;
  const maxLines=Math.max(2,Math.floor((available-minimum-8)/lineHeight));
  const rows=document.rows.filter((row)=>!register || row.key!=="register-total").flatMap((row)=>{
    const full=build(row);
    const columns=full.content.map((value)=>value.split("\n"));
    const longest=Math.max(...columns.map((value)=>value.length));
    if (longest<=maxLines) return [full];
    const slices:PrintedRow[]=[];
    for(let offset=0;offset<longest;offset+=maxLines) {
      const content=columns.map((value)=>value.slice(offset,offset+maxLines).join("\n"));
      slices.push({row:{...row,key:`${row.key}-fragment-${offset}`},content,height:Math.max(minimum,Math.ceil(Math.min(maxLines,longest-offset)*lineHeight+5))});
    }
    return slices;
  });
  const bottom=register ? document.rows.find((row)=>row.key==="register-total") : undefined;
  const pages:PrintedRow[][]=[];
  let cursor=0;
  do {
    const sheet:PrintedRow[]=[];
    let used=0;
    while (cursor<rows.length && sheet.length<limit) {
      const row=rows[cursor];
      if (sheet.length && used+row.height+(bottom ? minimum : 0)>available) break;
      sheet.push(row);
      used+=row.height;
      cursor+=1;
    }
    if (register) {
      while (sheet.length<limit && used+minimum+(bottom ? minimum : 0)<=available) {
        sheet.push(build({key:`blank-${pages.length}-${sheet.length}`,cells:[]}));
        used+=minimum;
      }
      if (bottom && cursor===rows.length) sheet.push(build(bottom));
    }
    pages.push(sheet);
  } while (cursor<rows.length);
  return {landscape,width,height,margin,widths,font,header,pages};
}
