import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const dummySalt = "azam-invalid-user-constant-salt";

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(24).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt-v1:${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored?: string) {
  const [algorithm, salt, hex] = stored?.split(":") ?? [];
  const valid = algorithm === "scrypt-v1" && /^[0-9a-f]{48}$/.test(salt) && /^[0-9a-f]{128}$/.test(hex);
  const actual = await derive(password, valid ? salt : dummySalt);
  return valid && timingSafeEqual(actual, Buffer.from(hex, "hex"));
}
