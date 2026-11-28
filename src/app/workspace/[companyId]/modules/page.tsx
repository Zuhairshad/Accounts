import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  ArrowLeftRight, BarChart3, BookOpen, Boxes, Building2, CalendarCheck, ChevronRight, ClipboardList, DatabaseBackup, FileInput, FileOutput, FilePlus2,
  FileSpreadsheet, FileText, History, Landmark, Link2, ListTree, Lock, PackageSearch, Receipt, RotateCcw, Scale, Settings2, SlidersHorizontal,
  TrendingUp, UserRound, Users, Wallet, type LucideIcon,
} from "lucide-react";
import { AccessError, getActor } from "@/lib/auth";
import { requireCompany } from "@/lib/companies";
import { modules } from "@/lib/modules";

export const metadata = { title: "Accounting modules" };

/** Presentation only: an icon per module title, and a tint and icon per category. */
const icons: Record<string, LucideIcon> = {
  "General ledger": BookOpen, "Chart of accounts": ListTree, "New voucher": FilePlus2, "Voucher register": ClipboardList, "Opening balances": Landmark,
  "Day Book": CalendarCheck, "Customers and suppliers": Users, "Party ledger": UserRound, "Legacy party voucher linking": Link2,
  "Payments, receipts and allocations": ArrowLeftRight, "Payment received": Wallet, "Sales executives": TrendingUp, "Sales invoice": FileOutput,
  "Purchase invoice": FileInput, "Sale returns": RotateCcw, "Purchase returns": RotateCcw, "Invoice settings": Settings2, "Invoice register": Receipt,
  "Sale / Purchase Register": FileSpreadsheet, "Inventory items": Boxes, "Stock ledger and valuation": PackageSearch, "Inventory adjustments": SlidersHorizontal,
  "Trial balance": Scale, "Profit & loss": TrendingUp, "Balance sheet": Landmark, "Daily MIS": BarChart3, "Debtors report and aging": FileText,
  "Creditors report and aging": FileText, "Combined debtors and creditors": Users, "Sales Executive wise Sale Report": BarChart3,
  "Company-wise and consolidated reports": Building2, "Financial reconciliation": Scale, "Audit, revisions and restoration": History,
  "Period close and approvals": Lock, "Migration and recovery history": DatabaseBackup,
};
const categoryStyle: Record<string, { tone: string; icon: LucideIcon; note: string }> = {
  Accounting: { tone: "tone-green", icon: BookOpen, note: "Ledgers, vouchers and opening balances" },
  Trade: { tone: "tone-blue", icon: Receipt, note: "Parties, invoices, receipts and allocations" },
  Inventory: { tone: "adm-tone-amber", icon: Boxes, note: "Items, stock movement and valuation" },
  Reports: { tone: "adm-tone-violet", icon: BarChart3, note: "Financial statements and analysis" },
  Administration: { tone: "adm-tone-slate", icon: Settings2, note: "Audit, period control and recovery" },
};

export default async function Modules({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!z.uuid().safeParse(companyId).success) notFound();
  const company = await requireCompany(actor, companyId, "view").catch((error: unknown) => {
    if (error instanceof AccessError) notFound();
    throw error;
  });
  const categories = [...new Set(modules.map((module) => module.category))];
  const href = (module: (typeof modules)[number]) => "path" in module && module.path && (module.path !== "vouchers/new" || company.permissions.includes("create"))
    ? `/workspace/${companyId}/accounting/${module.path}`
    : "tradePath" in module && module.tradePath && (module.tradePath !== "settings" || company.permissions.includes("manage_company"))
      ? `/workspace/${companyId}/trade/${module.tradePath}`
      : "workspacePath" in module && module.workspacePath && company.permissions.includes("export")
        ? `/workspace/${companyId}/${module.workspacePath}`
        : "adminPath" in module && module.adminPath && actor.superAdmin
          ? module.adminPath
          : "reportPath" in module && module.reportPath && (!["company-wise","combined-parties"].includes(module.reportPath) || company.permissions.includes("view_combined"))
            ? `/workspace/${companyId}/reports/${module.reportPath}`
            : null;
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">{company.name}</p><h1>Accounting modules</h1><p className="muted">Open an accounting module for this company.</p></div></div>
    {categories.map((category) => {
      const style = categoryStyle[category] ?? categoryStyle.Administration;
      const CategoryIcon = style.icon;
      const items = modules.filter((module) => module.category === category);
      return <section key={category} className="panel adm-module-section" aria-labelledby={`modules-${category}`}>
        <header className="adm-module-head"><span className={`stat-icon ${style.tone}`}><CategoryIcon size={18} aria-hidden /></span>
          <div><h2 id={`modules-${category}`}>{category}</h2><p className="muted">{style.note}</p></div><span className="pill">{items.length} modules</span></header>
        <ul className="adm-module-grid">{items.map((module) => {
          const Icon = icons[module.title] ?? FileText;
          const target = href(module);
          return <li key={module.title}>{target
            ? <Link className="adm-module" href={target}><span className={`adm-module-icon ${style.tone}`}><Icon size={17} aria-hidden /></span><span className="adm-module-title">{module.title}</span><ChevronRight size={16} className="adm-module-go" aria-hidden /></Link>
            : <div className="adm-module adm-module-locked"><span className="adm-module-icon"><Lock size={16} aria-hidden /></span><span className="adm-module-title">{module.title}</span><span className="tag">Restricted</span></div>}</li>;
        })}</ul>
      </section>;
    })}
  </div>;
}
