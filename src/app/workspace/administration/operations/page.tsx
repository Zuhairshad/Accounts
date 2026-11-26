import { desc } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { operationHistory } from "@/db/schema";
import { getActor } from "@/lib/auth";

export const metadata = { title: "Migration and recovery history" };
export const dynamic = "force-dynamic";

const kinds: Record<string, string> = { legacy_import: "Legacy import", backup: "Scheduled backup", restore: "Restore" };

/** Read-only operator history. Rows are written only by the backup job and the terminal migration utility. */
export default async function Operations() {
  const actor = await getActor();
  if (!actor) redirect("/workspace");
  if (!actor.superAdmin) notFound();
  const rows = await getDb().select().from(operationHistory).orderBy(desc(operationHistory.createdAt)).limit(200);
  const lastBackup = rows.find((row) => row.kind === "backup" && row.status === "uploaded");
  const ageHours = lastBackup ? (Date.now() - lastBackup.createdAt.getTime()) / 3_600_000 : null;
  return <div className="page-stack">
    <div className="page-heading"><div><h1>Migration and recovery history</h1>
      <p className="muted">Independent backups, restore drills and legacy imports recorded by the operator tools. These operations run outside
        the web application with separate credentials. See BACKUP_AND_RECOVERY.md and LEGACY_MIGRATION.md.</p></div></div>
    <section className="panel" role="status">
      {ageHours === null ? <p className="form-error">No successful independent backup has been recorded. Configure the scheduled backup workflow.</p>
        : ageHours > 26 ? <p className="form-error">The latest successful independent backup is {Math.floor(ageHours)} hours old. Check the backup workflow.</p>
          : <p><span className="tag tag-pass">Current</span> Latest independent backup {Math.floor(ageHours)} hours ago ({lastBackup?.reference}).</p>}
    </section>
    <section className="panel data-panel"><div className="panel-heading"><h2>Recorded operations</h2></div>
      {rows.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Time (Asia/Karachi)</th><th scope="col">Operation</th>
        <th scope="col">Reference</th><th scope="col">Status</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}>
          <td>{row.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Karachi" })}</td><td>{kinds[row.kind] ?? row.kind}</td>
          <td>{row.reference}</td><td><span className={`tag ${["uploaded", "verified", "committed", "rolled_back"].includes(row.status) ? "tag-pass" : row.status === "failed" ? "tag-fail" : "tag-review"}`}>{row.status.replaceAll("_", " ")}</span></td>
        </tr>)}</tbody></table></div> : <div className="empty"><strong>No operations recorded</strong></div>}
    </section>
  </div>;
}
