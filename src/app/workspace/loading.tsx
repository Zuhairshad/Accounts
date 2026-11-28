import { LoaderCircle } from "lucide-react";

export default function Loading() {
  return <div className="panel loading adm-loading" role="status"><LoaderCircle className="animate-spin" size={20} /> Loading workspace…</div>;
}
