import Link from "next/link";
import {
  ArrowLeftRight, ArrowRight, Banknote, BookOpen, BookText, Boxes, Briefcase, Building2, CalendarDays, ChartColumn, ChartLine, ChartPie,
  ClipboardList, FileSpreadsheet, HandCoins, Hourglass, Landmark, Layers, NotebookPen, Package, Receipt, Redo2, Scale, ScrollText,
  ShieldCheck, ShoppingCart, SlidersHorizontal, Undo2, UsersRound, Warehouse, type LucideIcon,
} from "lucide-react";
import { accountingAccess } from "@/lib/engine/access";
import { PageHeading } from "@/components/accounting/finance-ui";
import { Button } from "@/components/ui/button";
import { combinedIds,reportTitles,type ReportId } from "@/lib/reports/model";

const groups: { title:string; note:string; icon:LucideIcon; ids:ReportId[] }[]=[
  {title:"Financial statements",note:"Ledgers, balances and period results",icon:Landmark,ids:["mis","trial-balance","profit-loss","balance-sheet","general-ledger","cash-bank"]},
  {title:"Sales, purchases and parties",note:"Invoices, returns and party balances",icon:ShoppingCart,ids:["invoice-register","sales","sales-executives","purchases","sales-returns","purchase-returns","party-ledger","debtors","creditors","aging"]},
  {title:"Stock and registers",note:"Inventory, vouchers and digital registers",icon:Warehouse,ids:["inventory-valuation","stock-ledger","adjustments","voucher-register","day-book","sale-purchase"]},
  {title:"Company reports",note:"Across every company you can combine",icon:Building2,ids:[...combinedIds]},
];

/** Card icon and one-line summary shown for each report on the index. */
const cards: Record<ReportId,{icon:LucideIcon;note:string}>={
  mis:{icon:CalendarDays,note:"Account-wise summary or voucher number wise detail"},
  "trial-balance":{icon:Scale,note:"Closing balances or period movements by account"},
  "profit-loss":{icon:ChartLine,note:"Sales, cost of sales, expenses and net result"},
  "balance-sheet":{icon:Landmark,note:"Assets, liabilities and equity at a date"},
  "general-ledger":{icon:BookOpen,note:"Every posted journal line by account"},
  "cash-bank":{icon:Banknote,note:"Cash and bank ledgers with running balances"},
  "invoice-register":{icon:Receipt,note:"Posted sales and purchase invoices"},
  sales:{icon:ChartColumn,note:"Sales invoices by customer and date"},
  "sales-executives":{icon:Briefcase,note:"Sales and receipts per sales executive"},
  purchases:{icon:ShoppingCart,note:"Purchase invoices by supplier and date"},
  "sales-returns":{icon:Undo2,note:"Customer returns against sales"},
  "purchase-returns":{icon:Redo2,note:"Returns sent back to suppliers"},
  "party-ledger":{icon:BookText,note:"Statement of account for a customer or supplier"},
  debtors:{icon:HandCoins,note:"Customer balances receivable"},
  creditors:{icon:UsersRound,note:"Supplier balances payable"},
  aging:{icon:Hourglass,note:"Open invoices grouped by days overdue"},
  "inventory-valuation":{icon:Package,note:"Stock on hand and its value"},
  "stock-ledger":{icon:Boxes,note:"Item movements in and out"},
  adjustments:{icon:SlidersHorizontal,note:"Stock gains, losses and revaluations"},
  "voucher-register":{icon:ClipboardList,note:"Vouchers with type, status and amount"},
  "day-book":{icon:NotebookPen,note:"Editable day book register and print sheet"},
  "sale-purchase":{icon:FileSpreadsheet,note:"Editable sale and purchase register"},
  "company-wise":{icon:Layers,note:"Account heads grouped by type per company"},
  "combined-heads":{icon:ChartPie,note:"Mapped account groups across companies"},
  "combined-parties":{icon:ArrowLeftRight,note:"Debtors and creditors across companies"},
};

export default async function ReportHome({params}:{params:Promise<{companyId:string}>}) {
  const {companyId}=await params;
  const {company}=await accountingAccess(companyId);
  const base=`/workspace/${companyId}/reports`;
  return <div className="page-stack rep-page"><PageHeading title="Reports and registers" company={company.name} toolbar={<>
    {company.permissions.includes("export") && <Button asChild variant="outline"><Link href={`/workspace/${companyId}/reconciliation`}><ShieldCheck size={16} aria-hidden />Financial reconciliation</Link></Button>}
    {company.permissions.includes("manage_company") && <Button asChild variant="outline"><Link href={`${base}/settings`}><ScrollText size={16} aria-hidden />Report settings</Link></Button>}</>} />
    {groups.filter((g)=>g.title!=="Company reports" || company.permissions.includes("view_combined")).map((group)=>
      <section key={group.title} className="panel rep-group" aria-labelledby={`rep-${group.ids[0]}`}>
        <header className="rep-group-head">
          <span className="stat-icon tone-green" aria-hidden><group.icon size={19} /></span>
          <div><h2 id={`rep-${group.ids[0]}`}>{group.title}</h2><p>{group.note}</p></div>
          <span className="pill">{group.ids.length} reports</span>
        </header>
        <ul className="rep-card-grid">
          {group.ids.map((id)=>{
            const Icon=cards[id].icon;
            return <li key={id}><Link className="rep-card" href={`${base}/${id}`} aria-labelledby={`rep-card-${id}`} aria-describedby={`rep-note-${id}`}>
              <span className="rep-card-icon" aria-hidden><Icon size={17} /></span>
              <span className="rep-card-text"><strong id={`rep-card-${id}`}>{reportTitles[id]}</strong><small id={`rep-note-${id}`}>{cards[id].note}</small></span>
              <ArrowRight className="rep-card-arrow" size={15} aria-hidden />
            </Link></li>;
          })}
        </ul>
      </section>)}
  </div>;
}
