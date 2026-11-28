import { Building2, FileCheck2, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { SignInForm } from "@/components/sign-in";

export const metadata = { title: "Sign in" };

const features = [
  { icon: Building2, title: "Company-scoped books", detail: "Separate ledgers, years and members for every company." },
  { icon: FileCheck2, title: "Posted ledger reporting", detail: "Trial balance, P&L and registers straight from posted vouchers." },
  { icon: ShieldCheck, title: "Role-based access", detail: "Each user sees only the companies and actions they are granted." },
];

export default function SignIn() {
  return <main className="sign-in-layout adm-sign-in">
    <section className="sign-in-story adm-story">
      <Brand />
      <div>
        <p className="adm-story-eyebrow">Multi-company accounting</p>
        <h1>Company accounts,<br /><span>in one workspace.</span></h1>
        <ul className="sign-in-features adm-story-features">
          {features.map(({ icon: Icon, title, detail }) => <li key={title}>
            <span className="adm-story-icon"><Icon size={18} aria-hidden /></span>
            <div><strong>{title}</strong><small>{detail}</small></div>
          </li>)}
        </ul>
      </div>
      <span className="sign-in-footer">AZAM EASY ACCOUNTS V4.0</span>
    </section>
    <section className="sign-in-content adm-sign-in-content">
      <div className="sign-in-panel adm-sign-in-panel">
        <div className="mobile-brand"><Brand /></div>
        <h2>Sign in</h2>
        <p className="muted mt-2">Use your work account to open the accounting workspace.</p>
        <SignInForm />
        <p className="adm-sign-in-note"><ShieldCheck size={14} aria-hidden /> Accounts are provisioned by your administrator.</p>
      </div>
    </section>
  </main>;
}
