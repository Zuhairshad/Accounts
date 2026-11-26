import Link from "next/link";
import { accountingAccess } from "@/lib/engine/access";
import { PageHeading } from "@/components/accounting/finance-ui";
import { combinedIds,reportTitles,type ReportId } from "@/lib/reports/model";

const groups: { title:string; ids:ReportId[] }[]=[
  {title:"Financial statements",ids:["mis","trial-balance","profit-loss","balance-sheet","general-ledger","cash-bank"]},
  {title:"Sales, purchases and parties",ids:["invoice-register","sales","purchases","sales-returns","purchase-returns","party-ledger","debtors","creditors","aging"]},
  {title:"Stock and registers",ids:["inventory-valuation","stock-ledger","adjustments","voucher-register","day-book","sale-purchase"]},
  {title:"Company reports",ids:[...combinedIds]},
];

export default async function ReportHome({params}:{params:Promise<{companyId:string}>}) {
  const {companyId}=await params;
  const {company}=await accountingAccess(companyId);
  const base=`/workspace/${companyId}/reports`;
  return <div className="page-stack"><PageHeading title="Reports and registers" company={company.name} toolbar={
    company.permissions.includes("manage_company") ? <Link className="text-link" href={`${base}/settings`}>Report settings</Link> : undefined} />
    <div className="module-grid">{groups.filter((g)=>g.title!=="Company reports" || company.permissions.includes("view_combined")).map((group)=>
      <section key={group.title} className="panel"><h2>{group.title}</h2><ul className="module-list">
        {group.ids.map((id)=><li key={id}><Link className="text-link" href={`${base}/${id}`}>{reportTitles[id]}</Link></li>)}
      </ul></section>)}</div>
  </div>;
}
