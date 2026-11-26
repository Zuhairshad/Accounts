import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts,reportAccountMappings } from "@/db/schema";
import { accountingAccess } from "@/lib/engine/access";
import { FinanceForm } from "@/components/accounting/finance-form";
import { PageHeading } from "@/components/accounting/finance-ui";
import { mappingAction,registerConfigAction } from "@/lib/reports/actions";
import { registerSetting } from "@/lib/reports/register";
import { reportTitles } from "@/lib/reports/model";

export async function ReportSettings({companyId}:{companyId:string}) {
  const {company}=await accountingAccess(companyId);
  if (!company.permissions.includes("manage_company")) notFound();
  const db=getDb();
  const [day,sale,heads,maps]=await Promise.all([
    registerSetting(db,companyId,"day-book"),registerSetting(db,companyId,"sale-purchase"),
    db.select().from(accounts).where(eq(accounts.companyId,companyId)).orderBy(accounts.code),
    db.select().from(reportAccountMappings).where(eq(reportAccountMappings.companyId,companyId)),
  ]);
  return <div className="page-stack">
    <PageHeading title="Report settings" company={company.name} toolbar={<Link className="text-link" href={`/workspace/${companyId}/reports`}>All reports</Link>} />
    <div className="admin-grid">{[["day-book",day],["sale-purchase",sale]].map(([kind,setting])=>{
      const key=kind as "day-book"|"sale-purchase";
      const config=setting as typeof day;
      return <section key={key} className="panel"><h2>{reportTitles[key]}</h2>
        <FinanceForm companyId={companyId} action={registerConfigAction} version={config.version} submit={[{label:"Save register settings"}]}>
          <input type="hidden" name="kind" value={key} />
          <div className="form-grid mt-4">
            <label className="field">Print margin (points)<input name="margin" type="number" min="18" max="70" defaultValue={config.layout.margin} required /></label>
            <label className="field">Minimum row height (points)<input name="rowHeight" type="number" min="12" max="32" defaultValue={config.layout.rowHeight} required /></label>
            <label className="field field-wide">Seven column widths (relative, comma-separated)<input name="widths" defaultValue={config.layout.widths.join(",")} required /></label>
            <label className="field">Rows per sheet<input name="slots" type="number" min="10" max="50" defaultValue={config.layout.slots} required /></label>
            {key==="day-book" ? <>
              <label className="field">Default perspective<select name="perspective" defaultValue={config.perspective}>
                <option value="manual">Register-only</option><option value="cash">Cash ledgers</option><option value="bank">Bank ledgers</option></select></label>
              <label className="field">Manual balance direction<select name="direction" defaultValue={config.direction}><option value="dr-cr">Dr minus Cr</option><option value="cr-dr">Cr minus Dr</option></select></label>
              <label className="field">Manual opening amount<input name="initial" inputMode="decimal" defaultValue={config.initial} required /></label>
            </> : <><input name="perspective" type="hidden" value="manual" /><input name="direction" type="hidden" value="dr-cr" /><input name="initial" type="hidden" value="0" /></>}
          </div>
        </FinanceForm>
      </section>;
    })}</div>
    <section className="panel"><h2>Combined account mapping</h2>
      <p className="muted mt-2">Use the same reporting group key and classification for equivalent accounts in each company. Permanent system tags provide built-in mappings.</p>
      {heads.map((account)=>{
        const current=maps.find((map)=>map.accountId===account.id);
        return <details className="role-detail" key={account.id}>
          <summary>{account.code} · {account.name} · {account.type}{current?.groupKey ? ` · ${current.groupKey}` : ""}</summary>
          <FinanceForm action={mappingAction} companyId={companyId} submit={[{label:"Save account mapping",variant:"outline"}]}>
            <input type="hidden" name="accountId" value={account.id} />
            <div className="form-grid mt-4">
              <label className="field">Group key<input name="group" defaultValue={current?.groupKey ?? ""} maxLength={50} /></label>
              <label className="field">Group display label<input name="label" defaultValue={current?.label ?? ""} maxLength={120} /></label>
              {account.type==="expense" ? <label className="field">Expense classification<select name="otherExpense" defaultValue={String(current?.otherExpense ?? false)}>
                <option value="false">Operating expense</option><option value="true">Other expense</option></select></label> : <input name="otherExpense" type="hidden" value="false" />}
            </div>
          </FinanceForm>
        </details>;
      })}
    </section>
  </div>;
}
