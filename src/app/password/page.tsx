import Link from "next/link";
import { redirect } from "next/navigation";
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
  return <main className="password-layout">
    <section className="panel max-w-xl w-full">
      <Brand />
      <h1 className="mt-6">Change password</h1>
      <p className="muted mt-2">{actor.mustChangePassword ? "Set your own password to activate access to the workspace." : "Updating your password ends your existing sessions."}</p>
      <ActionForm action={changePassword} label="Save password" className="mt-6 space-y-4">
        <label className="field">Current password<input type="password" name="current" autoComplete="current-password" required maxLength={128} /></label>
        <label className="field">New password<input type="password" name="password" autoComplete="new-password" required minLength={15} maxLength={128} /></label>
        <label className="field">Confirm new password<input type="password" name="confirm" autoComplete="new-password" required maxLength={128} /></label>
      </ActionForm>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <Link href="/sign-in" className="text-link">Go to sign-in</Link><Logout />
      </div>
    </section>
  </main>;
}
