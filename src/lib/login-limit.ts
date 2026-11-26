import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../db";

export async function takeLoginAttempt(username: string, ip?: string) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required");
  const buckets = [{ value: `account:${username}`, limit: 10 }];
  if (ip) buckets.push({ value: `ip:${ip}`, limit: 50 });
  return getDb().transaction(async (tx) => {
    let permitted = true;
    for (const bucket of buckets) {
      const key = createHmac("sha256", secret).update(bucket.value).digest("hex");
      const result = await tx.execute<{ hits: number }>(sql`
        INSERT INTO login_attempts (key, hits, expires_at)
        VALUES (${key}, 1, now() + interval '15 minutes')
        ON CONFLICT (key) DO UPDATE
          SET hits = CASE WHEN login_attempts.expires_at <= now() THEN 1 ELSE least(login_attempts.hits + 1, 1000000) END,
              expires_at = CASE WHEN login_attempts.expires_at <= now() THEN excluded.expires_at ELSE login_attempts.expires_at END
        RETURNING hits
      `);
      permitted = permitted && result.rows[0].hits <= bucket.limit;
    }
    return permitted;
  });
}
