"use client";

import { Button } from "@/components/ui/button";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  return <section className="panel"><h1>Workspace temporarily unavailable</h1><p className="muted mt-3">The server could not load this page. Try again in a moment.</p><Button className="mt-5" onClick={reset}>Try again</Button></section>;
}
