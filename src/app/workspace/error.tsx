"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return <section className="panel adm-state adm-state-inline">
    <span className="stat-icon tone-red"><AlertTriangle size={22} aria-hidden /></span>
    <h1>Workspace temporarily unavailable</h1>
    <p className="muted">The server could not load this page. Try again in a moment.</p>
    <Button onClick={reset}>Try again</Button>
  </section>;
}
