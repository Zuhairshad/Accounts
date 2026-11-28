import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Brand } from "@/components/brand";
import { Logout } from "@/components/logout";
import { changePassword } from "@/lib/actions";
import { getActor } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change password" };

export default async function Password() {
  const actor = await getActor(true);
  if (!actor) redirect("/sign-in");
  return <main className="password-layout adm-center">
    <div className="adm-center-brand"><Brand /></div>
    <section className="panel adm-center-card adm-password">
      <header className="adm-card-head">
        <span className="stat-icon tone-green"><KeyRound size={20} aria-hidden /></span>
        <div><h1>Change password</h1>
          <p className="muted">{actor.mustChangePassword ? "Set your own password to activate access to the workspace." : "Updating your password ends your existing sessions."}</p></div>
      </header>
      <ActionForm action={changePassword} label="Save password" className="adm-stack-form">
        <label className="field">Current password<input type="password" name="current" autoComplete="current-password" required maxLength={128} /></label>
        <div className="adm-field-group">
          <label className="field">New password<input type="password" name="password" autoComplete="new-password" required minLength={15} maxLength={128} /></label>
          <p className="adm-hint">At least 15 characters. A short passphrase works well.</p>
        </div>
        <label className="field">Confirm new password<input type="password" name="confirm" autoComplete="new-password" required maxLength={128} /></label>
      </ActionForm>
      <footer className="adm-card-foot">
        <Link href="/sign-in" className="text-link">Go to sign-in</Link><Logout />
      </footer>
    </section>
  </main>;
}
