"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import type { FinanceState } from "@/lib/engine/actions";
import { Button } from "../ui/button";

type Action = (previous: FinanceState, data: FormData) => Promise<FinanceState>;
type Submit = { label: string; value?: string; variant?: "primary" | "outline" | "danger" };

export function FinanceForm({ action, companyId, submit, children, successTo, id, version, className }: {
  action: Action; companyId: string; submit: Submit[]; children?: React.ReactNode; successTo?: string;
  id?: string; version?: number; className?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, { status: "idle", message: "" } as FinanceState);
  const [ready, setReady] = useState(false);
  const key = useRef<string | undefined>(undefined);
  const router = useRouter();
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (state.status !== "idle" && !state.retry) key.current = undefined;
    if (state.status === "saved" && successTo && state.id) router.push(successTo.replace("{id}", state.id));
  }, [router, state, successTo]);
  return <form className={className} onSubmit={(event) => {
    event.preventDefault();
    if (!ready || pending) return;
    const data = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter);
    key.current ??= crypto.randomUUID();
    data.set("requestKey", key.current);
    startTransition(() => dispatch(data));
  }}>
    <input name="companyId" type="hidden" value={companyId} />
    {id && <input type="hidden" name="id" value={id} />}
    {version !== undefined && <input type="hidden" name="version" value={version} />}
    <fieldset disabled={!ready || pending} className="form-fields">{children}</fieldset>
    <div className="finance-submit">
      {submit.map((button) => <Button key={button.label} type="submit" name={button.value ? "intent" : undefined} value={button.value}
        disabled={!ready || pending} variant={button.variant ?? "primary"}>
        {pending && <LoaderCircle size={16} className="animate-spin" />}{button.label}
      </Button>)}
      {state.status !== "idle" && <span role={state.status === "error" ? "alert" : "status"}
        className={state.status === "error" ? "form-error" : "form-success"}>{state.message}</span>}
    </div>
  </form>;
}
