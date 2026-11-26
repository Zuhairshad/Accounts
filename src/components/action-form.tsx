"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "./ui/button";
import type { ActionState } from "@/lib/actions";

export function ActionForm({ action, label, children, danger, className, compact }: {
  action: (previous: ActionState, form: FormData) => Promise<ActionState>;
  label: string;
  children: React.ReactNode;
  className?: string;
  danger?: boolean;
  compact?: boolean;
}) {
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(action, { status: "idle", message: "" });
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "saved") formRef.current?.reset();
  }, [state]);
  return <form ref={formRef} onSubmit={(event) => {
    event.preventDefault();
    if (!ready || pending) return;
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  }} className={className}>
    <fieldset disabled={!ready} className="form-fields">{children}</fieldset>
    <div className={compact ? "flex flex-wrap items-center gap-2" : "mt-5 flex flex-wrap items-center gap-3"}>
      <Button type="submit" variant={danger ? "danger" : compact ? "outline" : "primary"} disabled={!ready || pending}>
        {pending && <LoaderCircle className="animate-spin" size={16} />}
        {pending ? "Saving…" : label}
      </Button>
      {state.status !== "idle" && <span role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "form-error" : "form-success"}>{state.message}</span>}
    </div>
  </form>;
}
