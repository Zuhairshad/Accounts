"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Bell, Building2, CalendarDays, ChevronDown, Keyboard, ReceiptText, Package, Files, ChartNoAxesCombined, CircleUserRound, ClipboardList, LayoutDashboard, LibraryBig, Menu, Search, Settings, X } from "lucide-react";
import { Brand } from "./brand";
import { Logout } from "./logout";

type Company = { id: string; name: string; active: boolean };
type Year = { name: string; startsOn: string; endsOn: string; closed: boolean } | null;
const dmy = (date: string) => date.split("-").reverse().join("-");

const shortcuts: { keys: string; action: string }[] = [
  { keys: "/", action: "Search company records" }, { keys: "g o", action: "Go to overview" }, { keys: "g v", action: "Go to vouchers" },
  { keys: "g i", action: "Go to invoices" }, { keys: "g s", action: "Go to inventory (stock)" }, { keys: "g r", action: "Go to reports" },
  { keys: "g c", action: "Go to financial reconciliation" }, { keys: "n v", action: "New voucher" }, { keys: "n s", action: "New sales invoice" },
  { keys: "n p", action: "New purchase invoice" }, { keys: "Enter", action: "In entry tables, move to the next field instead of submitting" },
  { keys: "?", action: "Show this list" }, { keys: "Esc", action: "Close dialogs and menus" },
];

export function WorkspaceShell({ actor, companies, manageable, showCombined, notices, years, children }: {
  actor: { name: string; username: string; superAdmin: boolean };
  companies: Company[];
  manageable: string[];
  showCombined: boolean;
  notices: { id: string; description: string; date: string }[];
  years: Record<string, Year>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [pending, startTransition] = useTransition();
  const selected = companies.find((company) => pathname.split("/")[2] === company.id);
  const initial = selected?.id ?? companies.find((company) => company.active)?.id;
  const base = initial ? `/workspace/${initial}` : "/workspace";
  const destinations = [
    { title: "Overview", href: base, icon: LayoutDashboard, visible: true },
    { title: "Vouchers", href: `${base}/accounting/vouchers`, icon: ReceiptText, visible: !!initial },
    { title: "Invoices", href: `${base}/trade/invoices`, icon: Files, visible: !!initial },
    { title: "Inventory", href: `${base}/trade/inventory`, icon: Package, visible: !!initial },
    { title: "Reports and registers", href: `${base}/reports`, icon: ChartNoAxesCombined, visible: !!initial },
    { title: "Accounting modules", href: `${base}/modules`, icon: LibraryBig, visible: !!initial },
    { title: "Combined reports", href: "/workspace/combined", icon: ClipboardList, visible: showCombined },
    { title: "Company settings", href: selected && manageable.includes(selected.id) ? `${base}/settings` : "/workspace/administration", icon: Settings, visible: manageable.length > 0 || actor.superAdmin },
    { title: "Company directory", href: "/workspace/administration", icon: Building2, visible: true },
  ];
  const go = (id: string) => startTransition(() => router.push(`/workspace/${id}`));
  const help = useRef<HTMLDialogElement>(null);
  const year = selected ? years[selected.id] : null;

  useEffect(() => {
    let prefix: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const typing = (target: EventTarget | null) => target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Enter advances through entry-table fields; it never submits a financial form by accident.
      if (event.key === "Enter" && target instanceof HTMLInputElement && target.closest(".entry-table") && target.type !== "search") {
        const fields = [...(target.form ?? document).querySelectorAll<HTMLElement>(".entry-table input:not([type=hidden]):not([disabled]), .entry-table select:not([disabled])")];
        const next = fields[fields.indexOf(target) + 1];
        event.preventDefault();
        next?.focus();
        return;
      }
      if (typing(target)) return;
      if (event.key === "?") { event.preventDefault(); help.current?.showModal(); return; }
      if (event.key === "/") {
        const search = document.querySelector<HTMLInputElement>(".global-search input");
        if (search) { event.preventDefault(); search.focus(); }
        return;
      }
      if (!initial) return;
      const routes: Record<string, string> = {
        "g o": base, "g v": `${base}/accounting/vouchers`, "g i": `${base}/trade/invoices`, "g s": `${base}/trade/inventory`,
        "g r": `${base}/reports`, "g c": `${base}/reconciliation`, "n v": `${base}/accounting/vouchers/new`,
        "n s": `${base}/trade/invoices/new?type=sale`, "n p": `${base}/trade/invoices/new?type=purchase`,
      };
      if (prefix) {
        const route = routes[`${prefix} ${event.key.toLowerCase()}`];
        prefix = null;
        if (route) { event.preventDefault(); router.push(route); }
        return;
      }
      if (event.key === "g" || event.key === "n") {
        prefix = event.key;
        clearTimeout(timer);
        timer = setTimeout(() => { prefix = null; }, 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, [base, initial, router]);

  return <div className={`workspace ${collapsed ? "sidebar-collapsed" : ""} ${mobile ? "sidebar-open" : ""}`}>
    <a className="skip-link" href="#content">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-brand"><Brand /><button title="Close navigation" className="mobile-close icon-button" onClick={() => setMobile(false)}><X size={21} /></button></div>
      <div className="sidebar-menu">
        {destinations.filter((item) => item.visible).map(({ title, href, icon: Icon }) => {
          const active = pathname === href && (title !== "Company settings" || href.endsWith("/settings"));
          const Destination = href.endsWith("/settings") ? "a" : Link;
          return <Destination key={title} href={href} onClick={() => setMobile(false)} title={title} aria-current={active ? "page" : undefined}>
            <Icon size={19} /><span>{title}</span>
          </Destination>;
        })}
      </div>
      <div className="sidebar-footer"><span>V4.0</span></div>
    </aside>
    <div className="workspace-body">
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-button desktop-toggle" title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><Menu size={20} /></button>
          <button className="icon-button mobile-toggle" title="Open navigation" aria-expanded={mobile} onClick={() => setMobile(true)}><Menu size={20} /></button>
          <div className="company-select">
            <Building2 size={17} /><select aria-label="Switch company" value={selected?.active ? selected.id : ""} onChange={(event) => go(event.target.value)} disabled={pending}>
              <option value="" disabled>Select company</option>
              {companies.filter((company) => company.active).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select><ChevronDown size={15} />
          </div>
          {pending && <span role="status" className="sr-only">Switching company…</span>}
          {selected?.active && <span className={`period-badge ${year?.closed ? "period-closed" : ""}`} title="Current financial year for the selected company">
            <CalendarDays size={15} aria-hidden />{year ? <>{year.name}<small>{dmy(year.startsOn)} to {dmy(year.endsOn)}{year.closed ? " · closed" : ""}</small></>
              : <small>No financial year covers today</small>}
          </span>}
        </div>
        <div className="topbar-right">
          {selected?.active && <form className="global-search" action={`${base}/search`}><Search size={17} /><input aria-label="Global search" placeholder="Search company records" name="q" maxLength={100} required /></form>}
          <button className="icon-button" type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => help.current?.showModal()}><Keyboard size={20} /></button>
          <details className="top-menu"><summary className="icon-button" aria-label="Notifications"><Bell size={20} /></summary><div className="menu-panel">
            <strong>Notifications</strong>
            {notices.length ? <ul>{notices.map((notice) => <li key={notice.id}><span>{notice.description}</span><small>{notice.date}</small></li>)}</ul> : <p className="muted">No recent activity.</p>}
          </div></details>
          <details className="top-menu"><summary className="profile-summary" aria-label="User profile"><CircleUserRound size={23} /><span>{actor.name}</span><ChevronDown size={14} /></summary><div className="menu-panel">
            <strong>{actor.name}</strong><p className="muted">{actor.username}</p>
            <Link href="/password" className="text-link block my-3">Change password</Link><Logout />
          </div></details>
        </div>
      </header>
      <main id="content" className="content">{children}</main>
      <dialog ref={help} className="register-dialog shortcut-dialog" aria-labelledby="shortcut-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <h2 id="shortcut-title">Keyboard shortcuts</h2>
        <table><tbody>{shortcuts.map((s) => <tr key={s.keys}><th scope="row"><kbd>{s.keys}</kbd></th><td>{s.action}</td></tr>)}</tbody></table>
        <form method="dialog"><button className="button button-outline mt-4">Close</button></form>
      </dialog>
    </div>
  </div>;
}
