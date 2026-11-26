import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const globalDatabase = globalThis as typeof globalThis & { azamPool?: Pool };

export function createPool(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 7_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 12_000,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on("error", () => console.error("An idle PostgreSQL connection was interrupted."));
  return pool;
}

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  globalDatabase.azamPool ??= createPool(url);
  return drizzle(globalDatabase.azamPool, { schema });
}

export type Database = ReturnType<typeof getDb>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
