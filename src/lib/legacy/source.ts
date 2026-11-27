import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/*
 * Read-only access to a legacy AZAM EASY ACCOUNTS SQLite database.
 *
 * The original Python source that defines the SQLite schema was not available while this importer was written, so no
 * table or column names are assumed. An operator supplies a mapping file, `inspect` shows the real schema to help write
 * it, and every mapped identifier is checked against the introspected schema before any query runs. Identifiers are
 * only ever taken from that introspection, never interpolated from the mapping directly.
 */

const column = z.string().min(1).max(128);
const optional = column.optional();
const table = <T extends z.ZodRawShape>(columns: T) => z.object({ table: column, columns: z.object(columns).strict() }).strict();

export const mappingSchema = z.object({
  profile: z.string().min(1).max(200),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(7),
  tables: z.object({
    companies: table({ id: column, name: column, active: optional }),
    accounts: table({ id: column, companyId: column, code: column, name: column, type: column }),
    parties: table({ id: column, companyId: column, type: column, name: column, phone: optional, address: optional }),
    items: table({ id: column, companyId: column, name: column, unit: optional, openingQty: optional, openingRate: optional, openingDate: optional }).optional(),
    vouchers: table({ id: column, companyId: column, number: column, date: column, type: column, narration: optional }),
    voucherLines: table({ id: optional, voucherId: column, accountId: column, partyId: optional, itemId: optional, debit: column, credit: column, description: optional, lineNo: optional }),
    invoiceRows: table({ id: optional, companyId: column, number: column, date: column, type: column, partyId: optional,
      itemId: column, qty: column, rate: column, amount: column, voucherId: column }).optional(),
  }).strict(),
  values: z.object({
    accountType: z.record(z.string(), z.enum(["asset", "liability", "equity", "income", "expense"])),
    partyType: z.record(z.string(), z.enum(["customer", "supplier"])),
    voucherType: z.record(z.string(), z.enum(["JV", "VR", "CPV", "CRV", "BPV", "BRV", "sale", "purchase", "sale_return", "purchase_return", "opening", "adjustment"])),
    invoiceType: z.record(z.string(), z.enum(["sale", "purchase", "sale_return", "purchase_return"])).default({}),
  }).strict(),
  /** Explicit company placement. Without one, a legacy company maps to a target of the alias-resolved legacy name. */
  companyTargets: z.record(z.string(), z.union([z.object({ companyId: z.uuid() }).strict(), z.object({ name: z.string().trim().min(1).max(160) }).strict()])).default({}),
}).strict();
export type Mapping = z.infer<typeof mappingSchema>;
export type Entity = keyof Mapping["tables"];
export type Row = Record<string, unknown>;

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export type SchemaReport = {
  sha256: string; bytes: number; sqliteVersion: string; userVersion: number;
  tables: { name: string; rows: number; columns: { name: string; type: string; notNull: boolean; pk: boolean }[] }[];
  signature: string;
};

export class LegacySource {
  readonly db: DatabaseSync;
  readonly sha256: string;
  readonly bytes: number;
  private constructor(readonly path: string) {
    const bytes = readFileSync(path);
    if (bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") throw new Error("The supplied file is not a SQLite 3 database.");
    this.bytes = bytes.byteLength;
    this.sha256 = sha256(bytes);
    // readOnly prevents writes; the file is fingerprinted before opening so the report identifies the exact source.
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec("PRAGMA query_only = ON");
  }
  static open(path: string) { return new LegacySource(path); }
  close() { this.db.close(); }

  schema(): SchemaReport {
    const names = (this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    const tables = names.map((name) => {
      const columns = (this.db.prepare("SELECT name,type,\"notnull\" AS \"notNull\",pk FROM pragma_table_info(?)").all(name) as
        { name: string; type: string; notNull: number; pk: number }[]).map((c) => ({ name: c.name, type: c.type, notNull: !!c.notNull, pk: c.pk > 0 }));
      const rows = Number((this.db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n);
      return { name, rows, columns };
    });
    const { v } = this.db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    const { user_version: userVersion } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    const signature = sha256(tables.map((t) => `${t.name}(${t.columns.map((c) => `${c.name}:${c.type}`).join(",")})`).join(";"));
    return { sha256: this.sha256, bytes: this.bytes, sqliteVersion: v, userVersion, tables, signature };
  }

  /** Every mapped table and column must exist exactly. Returns human-readable problems; empty means the mapping fits. */
  validate(mapping: Mapping) {
    const schema = this.schema();
    const problems: string[] = [];
    for (const [entity, spec] of Object.entries(mapping.tables) as [Entity, { table: string; columns: Record<string, string | undefined> }][]) {
      if (!spec) continue;
      const found = schema.tables.find((t) => t.name === spec.table);
      if (!found) { problems.push(`${entity}: table "${spec.table}" does not exist`); continue; }
      for (const [field, name] of Object.entries(spec.columns)) {
        if (name && !found.columns.some((c) => c.name === name)) problems.push(`${entity}.${field}: column "${spec.table}.${name}" does not exist`);
      }
    }
    return { schema, problems };
  }

  /** Read a mapped entity as canonical field names. Only call after validate() returned no problems. */
  read(mapping: Mapping, entity: Entity): Row[] {
    const spec = mapping.tables[entity] as { table: string; columns: Record<string, string | undefined> } | undefined;
    if (!spec) return [];
    const fields = Object.entries(spec.columns).filter((entry): entry is [string, string] => !!entry[1]);
    const select = fields.map(([field, name]) => `${quote(name)} AS ${quote(field)}`).join(", ");
    return this.db.prepare(`SELECT rowid AS "__rowid", ${select} FROM ${quote(spec.table)} ORDER BY rowid`).all() as Row[];
  }
}

/** Quote a SQLite identifier. Callers only pass names already verified against sqlite_schema / pragma_table_info. */
function quote(identifier: string) {
  if (identifier.includes("\u0000")) throw new Error("Invalid identifier");
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function loadMapping(path: string) {
  const text = readFileSync(path, "utf8");
  return { mapping: mappingSchema.parse(JSON.parse(text)), sha256: sha256(text) };
}
