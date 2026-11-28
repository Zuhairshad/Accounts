import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import * as schema from "../src/db/schema";
import type { Database } from "../src/db";
import { runLegacyDelta } from "../src/lib/legacy/delta";
import { runLegacyImport, withdrawImport, type Approval } from "../src/lib/legacy/load";
import { LegacySource, loadMapping } from "../src/lib/legacy/source";

/*
 * Administrator-only legacy SQLite migration. Runs from a trusted terminal with the migration owner connection
 * (DATABASE_MIGRATION_URL). It is not exposed through the web application.
 *
 *   inspect  --source legacy.db                                   read-only schema and row counts
 *   dry-run  --source legacy.db --mapping m.json --actor admin    full import + verification, always rolled back
 *   import   ... --approval approval.json --confirm-database NAME commit after documented approval
 *   withdraw --import <id> --actor admin --reason "..."           deactivate companies created by an import
 *   delta-dry-run --base imported.db --source newer.db --mapping m.json --actor admin
 *                                                                  merge only what a newer backup added, always rolled back
 *   delta-import  ... --approval approval.json --confirm-database NAME
 */

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" }, base: { type: "string" }, mapping: { type: "string" }, actor: { type: "string" }, approval: { type: "string" },
    out: { type: "string" }, import: { type: "string" }, reason: { type: "string" }, "confirm-database": { type: "string" },
  },
});
const command = positionals[0];
const fail = (message: string): never => { console.error(message); process.exit(2); };

if (command === "inspect") {
  const source = LegacySource.open(values.source ?? fail("--source is required"));
  const report = source.schema();
  source.close();
  const text = JSON.stringify(report, null, 2);
  if (values.out) writeFileSync(values.out, text, { mode: 0o600 });
  console.log(text);
  process.exit(0);
}

const url = process.env.DATABASE_MIGRATION_URL ?? fail("DATABASE_MIGRATION_URL is required (migration owner connection).");
const pool = new Pool({ connectionString: url, max: 2, statement_timeout: 0 });
const db = drizzle(pool, { schema }) as unknown as Database;
const actor = values.actor ?? fail("--actor <super admin username> is required");

try {
  if (command === "withdraw") {
    const id = z.uuid().parse(values.import);
    console.log(JSON.stringify(await withdrawImport(db, id, actor, values.reason ?? ""), null, 2));
  } else if (command === "delta-dry-run" || command === "delta-import") {
    const base = LegacySource.open(values.base ?? fail("--base is required (the backup that was already imported)"));
    const source = LegacySource.open(values.source ?? fail("--source is required"));
    const { mapping, sha256 } = loadMapping(values.mapping ?? fail("--mapping is required"));
    let approval: Approval | undefined;
    if (command === "delta-import") {
      const { rows } = await pool.query<{ name: string }>("SELECT current_database() AS name");
      if (values["confirm-database"] !== rows[0].name) fail(`Pass --confirm-database ${rows[0].name} to import into this database.`);
      approval = JSON.parse(readFileSync(values.approval ?? fail("--approval is required"), "utf8")) as Approval;
    }
    const result = await runLegacyDelta(db, base, source, mapping, sha256, { mode: command === "delta-import" ? "import" : "dry-run", actor, approval });
    base.close();
    source.close();
    const output = JSON.stringify(result, null, 2);
    if (values.out) writeFileSync(values.out, output, { mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, reportSha256: result.reportSha256, reasons: result.reasons, importId: result.importId,
      outcome: result.report.outcome, issues: result.report.issues, revisions: result.report.revisions, inventory: result.report.inventory,
      reconciliation: Object.fromEntries(Object.entries(result.report.verification.reconciliation)
        .map(([company, checks]) => [company, checks.filter((c) => c.status !== "pass").map((c) => `${c.key}: ${c.status}`)])),
      unexplainedDifferences: result.report.verification.unexplained }, null, 2));
    process.exitCode = result.status === "dry-run" || result.status === "committed" ? 0 : 1;
  } else if (command === "dry-run" || command === "import") {
    const source = LegacySource.open(values.source ?? fail("--source is required"));
    const { mapping, sha256 } = loadMapping(values.mapping ?? fail("--mapping is required"));
    let approval: Approval | undefined;
    if (command === "import") {
      const { rows } = await pool.query<{ name: string }>("SELECT current_database() AS name");
      if (values["confirm-database"] !== rows[0].name) fail(`Pass --confirm-database ${rows[0].name} to import into this database.`);
      approval = JSON.parse(readFileSync(values.approval ?? fail("--approval is required"), "utf8")) as Approval;
    }
    const result = await runLegacyImport(db, source, mapping, sha256, { mode: command, actor, approval });
    source.close();
    const output = JSON.stringify(result, null, 2);
    if (values.out) writeFileSync(values.out, output, { mode: 0o600 });
    console.log(JSON.stringify({ status: result.status, reportSha256: result.reportSha256, reasons: result.reasons, importId: result.importId,
      issues: result.report.issues, unexplainedDifferences: result.report.verification.unexplained }, null, 2));
    process.exitCode = result.status === "dry-run" || result.status === "committed" ? 0 : 1;
  } else fail("Usage: legacy-migrate <inspect|dry-run|import|withdraw|delta-dry-run|delta-import> [options]. See LEGACY_MIGRATION.md.");
} finally {
  await pool.end();
}
