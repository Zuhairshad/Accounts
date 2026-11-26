import { Building2, FileCheck2, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/brand";
import { SignInForm } from "@/components/sign-in";

export const metadata = { title: "Sign in" };

export default function SignIn() {
  return <main className="sign-in-layout">
    <section className="sign-in-story">
      <Brand />
      <div>
        <h1>Company accounts,<br />in one workspace.</h1>
        <div className="sign-in-features">
          <span><Building2 size={19} /> Company-scoped books</span>
          <span><FileCheck2 size={19} /> Posted ledger reporting</span>
          <span><ShieldCheck size={19} /> Role-based access</span>
        </div>
      </div>
      <span className="sign-in-footer">AZAM EASY ACCOUNTS V4.0</span>
    </section>
    <section className="sign-in-content">
      <div className="sign-in-panel">
        <div className="mobile-brand"><Brand /></div>
        <h2>Sign in</h2>
        <p className="muted mt-2">Use your work account to open the accounting workspace.</p>
        <SignInForm />
      </div>
    </section>
  </main>;
}
