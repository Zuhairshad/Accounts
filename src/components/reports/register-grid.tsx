"use client";

import { useEffect,useRef,useState,type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus,RefreshCw } from "lucide-react";
import { FinanceForm } from "@/components/accounting/finance-form";
import { Button } from "@/components/ui/button";
import { financialRegisterAction } from "@/lib/reports/actions";
import { registerColumns,type RegisterId } from "@/lib/reports/model";
import type { RegisterPayload } from "@/lib/reports/register";

type Data={id:string;version:number;status:string;payload:RegisterPayload};
type Phase="Unsaved changes"|"Saving"|"Saved"|"Save failed"|"Conflict detected";
type Grid=Data & {phase:Phase;message?:string;sequence:number};
type Operation={id:string;version:number;requestKey:string;operation:"save"|"void"|"restore";payload?:RegisterPayload;reason?:string;sequence:number};
type Option={id:string;name:string};
const fresh=(row:Data):Grid=>({...row,phase:"Saved",sequence:0});
const nextDelay=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));

export function RegisterGrid({companyId,kind,rows,contacts,accounts,stock,linkable,balances,rights,today,deleted}:{
  companyId:string;kind:RegisterId;rows:Data[];contacts:Option[];
  accounts:(Option&{liquidity:string|null})[];stock:Option[];linkable:Option[];balances:Record<string,string>;
  rights:{create:boolean;edit:boolean;delete:boolean;restore:boolean;post:boolean};today:string;deleted:boolean;
}) {
  const [items,setItems]=useState<Grid[]>(()=>rows.map(fresh));
  const [chosen,setChosen]=useState<string>();
  const [entryMode,setEntryMode]=useState("attach");
  const rowsRef=useRef(items);
  const timers=useRef(new Map<string,ReturnType<typeof setTimeout>>());
  const pending=useRef(new Map<string,Operation>());
  const busy=useRef(new Set<string>());
  const dialog=useRef<HTMLDialogElement>(null);
  const table=useRef<HTMLTableElement>(null);
  const router=useRouter();
  const isDay=kind==="day-book";
  const form=items.find((row)=>row.id===chosen);
  useEffect(()=>{if (chosen && !form && dialog.current?.open) dialog.current.close();},[chosen,form]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{
      if (rowsRef.current.some((row)=>row.phase==="Unsaved changes" || row.phase==="Saving" || row.phase==="Save failed")) event.preventDefault();
    };
    window.addEventListener("beforeunload",warn);
    const activeTimers=timers.current;
    return ()=>{
      window.removeEventListener("beforeunload",warn);
      for (const timer of activeTimers.values()) clearTimeout(timer);
    };
  },[]);
  useEffect(()=>{
    const incoming=new Map(rows.map((row)=>[row.id,row]));
    const current=rowsRef.current.flatMap((row)=>{
      const data=incoming.get(row.id);
      incoming.delete(row.id);
      if (row.phase!=="Saved" || !row.version) return [row];
      if (!data && !busy.current.has(row.id)) return [];
      return [data && data.version>row.version ? fresh(data) : row];
    });
    rowsRef.current=[...current,...[...incoming.values()].map(fresh)];
    setItems(rowsRef.current);
  },[rows]);
  function editRow(id:string,patch:Partial<Grid>) {
    rowsRef.current=rowsRef.current.map((row)=>row.id===id ? {...row,...patch} : row);
    setItems(rowsRef.current);
  }
  function schedule(id:string,ms=450) {
    const current=timers.current.get(id);
    if (current) clearTimeout(current);
    timers.current.set(id,setTimeout(()=>{
      timers.current.delete(id);
      void save(id);
    },ms));
  }
  async function save(id:string) {
    const row=rowsRef.current.find((entry)=>entry.id===id);
    if (!row || busy.current.has(id) || row.phase==="Conflict detected") return;
    const op=pending.current.get(id) ?? {id,version:row.version,requestKey:crypto.randomUUID(),operation:"save",payload:row.payload,sequence:row.sequence};
    pending.current.set(id,op);
    busy.current.add(id);
    editRow(id,{phase:"Saving",message:undefined});
    try {
      let failure="The server did not confirm this save.";
      for (let attempt=0;attempt<3;attempt++) {
        if (attempt) await nextDelay(attempt*550);
        let response:Response;
        try {
          response=await fetch(`/api/register/${companyId}/${kind}`,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify(op),signal:AbortSignal.timeout(6000)});
        } catch {continue;}
        const data=await response.json().catch(()=>({message:"The server did not confirm this save."}));
        if (response.ok) {
          pending.current.delete(id);
          const latest=rowsRef.current.find((entry)=>entry.id===id);
          if (op.operation!=="save") {
            rowsRef.current=rowsRef.current.filter((entry)=>entry.id!==id);
            setItems(rowsRef.current);
          } else {
            const more=latest && latest.sequence!==op.sequence;
            editRow(id,{version:data.version,status:data.status,phase:more ? "Unsaved changes" : "Saved"});
            if (more) schedule(id,0);
          }
          router.refresh();
          return;
        }
        failure=data.message ?? failure;
        if (response.status<500) {
          pending.current.delete(id);
          editRow(id,{phase:response.status===409 ? "Conflict detected" : "Save failed",message:failure});
          return;
        }
      }
      editRow(id,{phase:"Save failed",message:failure});
    } finally {busy.current.delete(id);}
  }
  function change(row:Grid,key:keyof RegisterPayload,value:string) {
    const current=rowsRef.current.find((entry)=>entry.id===row.id);
    if (!current) return;
    editRow(row.id,{payload:{...current.payload,[key]:key==="partyId" ? value || null : value},sequence:current.sequence+1,
      phase:current.phase==="Conflict detected" ? current.phase : "Unsaved changes"});
    if (current.phase!=="Conflict detected") schedule(row.id);
  }
  function add() {
    const id=crypto.randomUUID();
    const row:Grid={id,version:0,status:"draft",payload:{date:today,type:isDay?"JV":"purchase",ref:"",description:"",partyId:null,first:"",second:""},
      sequence:1,phase:"Unsaved changes"};
    rowsRef.current=[...rowsRef.current,row];
    setItems(rowsRef.current);
    schedule(id);
    // Move to the new row's first cell only if focus has not moved since "Add row" was pressed. Otherwise a slow frame
    // would pull focus away from a field the user is already typing in, and the next keystrokes would land elsewhere.
    const opener=document.activeElement;
    requestAnimationFrame(()=>{
      const active=document.activeElement;
      if (active!==opener && active!==document.body && active!==null) return;
      table.current?.querySelector<HTMLInputElement>(`[data-row="${id}"][data-column="1"]`)?.focus();
    });
  }
  function lifecycle(row:Grid,operation:"void"|"restore") {
    if (row.phase!=="Saved") return;
    const reason=window.prompt(operation==="void" ? "Reason for deleting this row" : "Reason for restoring this row")?.trim();
    if (!reason) return;
    if (reason.length<3 || reason.length>500) {
      editRow(row.id,{message:"Enter a reason of 3 to 500 characters."});return;
    }
    pending.current.set(row.id,{id:row.id,version:row.version,requestKey:crypto.randomUUID(),operation,reason,sequence:row.sequence});
    void save(row.id);
  }
  function navigate(event:KeyboardEvent<HTMLElement>) {
    const target=event.target as HTMLElement;
    const row=target.dataset.row, column=Number(target.dataset.column);
    if (!row || !Number.isFinite(column)) return;
    const index=items.findIndex((item)=>item.id===row);
    const key=event.key;
    const tag=target.tagName;
    const vertical=key==="Enter" && tag!=="SELECT" || ["ArrowUp","ArrowDown"].includes(key) && (event.ctrlKey || tag==="INPUT" && (target as HTMLInputElement).type==="text");
    const horizontal=event.ctrlKey && ["ArrowLeft","ArrowRight"].includes(key);
    if (!vertical && !horizontal) return;
    const next=vertical ? items[index+(key==="ArrowUp" || event.shiftKey ? -1 : 1)]?.id : row;
    const nextColumn=horizontal ? column+(key==="ArrowLeft" ? -1 : 1) : column;
    const cell=next && table.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-column="${nextColumn}"]`);
    if (cell) {event.preventDefault();cell.focus();}
  }
  return <section className="panel print-hide">
    <div className="page-heading">
      <div><h2>{deleted ? "Deleted register rows" : "Register-only entries and drafts"}</h2>
        <p className="muted mt-2">Edits save automatically. Use Enter or Control with the arrow keys to move between cells.</p></div>
      {rights.create && !deleted && <Button onClick={add}><Plus size={16} /> Add row</Button>}
    </div>
    <div className="table-scroll mt-4"><table className="entry-table register-entry" ref={table} onKeyDown={navigate}>
      <thead><tr>{registerColumns[kind].map((name)=><th key={name}>{name}</th>)}<th>Save status and actions</th></tr></thead>
      <tbody>{items.map((row,index)=>{
        const disabled=deleted || !(row.version?rights.edit:rights.create);
        const input=(field:keyof RegisterPayload,column:number,variant="text")=><input aria-label={`${field} row ${index+1}`}
          data-row={row.id} data-column={column} value={row.payload[field] ?? ""} onChange={(event)=>change(row,field,event.target.value)}
          type={variant} inputMode={field==="first" || field==="second" ? "decimal" : undefined} disabled={disabled} />;
        const description=<>{input("description",3)}<select aria-label={`Party row ${index+1}`} value={row.payload.partyId ?? ""}
          data-row={row.id} data-column={7} disabled={disabled} onChange={(event)=>change(row,"partyId",event.target.value)}>
          <option value="">Select party</option>{contacts.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></>;
        const tradeType=<select aria-label={`type row ${index+1}`} data-row={row.id} data-column={4} value={row.payload.type} disabled={disabled}
          onChange={(event)=>change(row,"type",event.target.value)}>{["purchase","sale","purchase_return","sale_return"].map((type)=>
            <option key={type} value={type}>{type.replaceAll("_"," ")}</option>)}</select>;
        return <tr key={row.id}><td>{index+1}</td><td>{input("date",1,"date")}</td>
          {isDay ? <><td>{input("type",2)}</td><td>{description}{input("ref",8)}</td><td>{input("first",4)}</td>
            <td>{input("second",5)}</td><td>{balances[row.id] ?? "—"}</td></> : <>
            <td>{input("ref",2)}</td><td>{description}</td><td>{tradeType}</td><td>{input("first",5)}</td><td>{input("second",6)}</td></>}
          <td><div className="finance-toolbar">
            <span role={row.phase==="Conflict detected" || row.phase==="Save failed"?"alert":"status"} className={row.phase==="Save failed" || row.phase==="Conflict detected"?"form-error":"muted"}>
              {row.phase}{row.phase==="Saved" && row.status==="draft" ? " · Draft" : ""}</span>
            {row.phase==="Save failed" && <Button type="button" variant="outline" onClick={()=>void save(row.id)}><RefreshCw size={15} /> Retry</Button>}
            {row.phase==="Conflict detected" && <Button variant="outline" onClick={()=>window.location.reload()}>Reload</Button>}
            {!deleted && row.phase==="Saved" && row.status==="saved" && rights.edit && <Button variant="outline"
              onClick={()=>{setEntryMode("attach");setChosen(row.id);dialog.current?.showModal();}}>Accounting entry</Button>}
            {!deleted && rights.delete && row.version>0 && row.phase==="Saved" && <Button variant="outline" onClick={()=>lifecycle(row,"void")}>Delete row</Button>}
            {deleted && rights.restore && row.phase==="Saved" && <Button variant="outline" onClick={()=>lifecycle(row,"restore")}>Restore row</Button>}
            {row.message && <small className="form-error">{row.message}</small>}
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    {!items.length && <p className="muted mt-4">{deleted ? "No deleted rows for this selection." : "Add a row to start an informational entry."}</p>}
    <dialog className="register-dialog" ref={dialog} onClose={()=>setChosen(undefined)}>
      <div className="page-heading"><h2>Accounting entry</h2><Button variant="outline" onClick={()=>dialog.current?.close()}>Close</Button></div>
      {form && <FinanceForm key={form.id} action={financialRegisterAction} companyId={companyId} id={form.id} version={form.version} submit={[{label:"Confirm accounting link"}]}>
        <input type="hidden" name="kind" value={kind} />
        <label className="field">Workflow<select name="operation" value={entryMode} onChange={(event)=>setEntryMode(event.target.value)}>
          <option value="attach">Link an existing posted document</option>{rights.post && <option value="create">Create and post a new document</option>}
        </select></label>
        <div className="form-grid mt-4">
          {entryMode==="attach" ? <label className="field field-wide">Existing posted document<select name="existing" required defaultValue="">
            <option value="">Select document in this period</option>{linkable.map((source)=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label> : <input type="hidden" name="existing" value="" />}
          {entryMode==="create" ? <label className="field">{isDay?"Cash or bank account":"Payment account"}<select name="cashId" required={isDay} defaultValue="">
            <option value="">{isDay?"Select cash or bank":"On credit"}</option>{accounts.filter((a)=>a.liquidity).map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label> : <input type="hidden" name="cashId" value="" />}
          {isDay && entryMode==="create" ? <label className="field">Offset account<select name="offsetId" required defaultValue="">
            <option value="">Select offset</option>{accounts.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label> : <input type="hidden" name="offsetId" value="" />}
          {!isDay && entryMode==="create" ? <>
            <label className="field">Product or service<select name="itemId" required defaultValue="">
              <option value="">Select item</option>{stock.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="field">Quantity<input name="quantity" inputMode="decimal" required /></label>
            <label className="field">Rate<input name="rate" inputMode="decimal" required /></label>
          </> : <><input type="hidden" name="itemId" value="" /><input type="hidden" name="quantity" value="" /><input type="hidden" name="rate" value="" /></>}
          <label className="field field-wide">Reason<input name="reason" required minLength={3} maxLength={500} /></label>
          <label className="flex gap-2 items-center field-wide"><input type="checkbox" name="confirmed" value="true" required />
            {isDay && entryMode==="create" ? "The entered Dr or Cr applies to the selected cash or bank account." : "I verified the source document and register amounts."}</label>
        </div>
      </FinanceForm>}
    </dialog>
  </section>;
}
