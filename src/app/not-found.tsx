import Link from "next/link";

export default function NotFound() {
  return <main className="password-layout"><div className="panel"><h1>Page unavailable</h1><p className="muted mt-3">This page is unavailable for the current workspace.</p><Link href="/workspace" className="text-link block mt-5">Back to workspace</Link></div></main>;
}
