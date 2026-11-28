import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return <main className="password-layout adm-center">
    <div className="adm-center-brand"><Brand /></div>
    <div className="panel adm-center-card adm-state">
      <span className="stat-icon tone-red"><SearchX size={22} aria-hidden /></span>
      <p className="eyebrow">Error 404</p>
      <h1>Page unavailable</h1>
      <p className="muted">This page is unavailable for the current workspace.</p>
      <Link href="/workspace" className="button button-primary"><ArrowLeft size={16} aria-hidden /> Back to workspace</Link>
    </div>
  </main>;
}
