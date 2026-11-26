import "server-only";
import { getServerSession, type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { users } from "../db/schema";
import { takeLoginAttempt } from "./login-limit";
import { verifyPassword } from "./password";
import { usernameSchema } from "./validation";

const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(128) });

declare module "next-auth" {
  interface Session {
    user: { id: string; name: string; version: number; issued: number };
  }
  interface User {
    version: number;
  }
}
declare module "next-auth/jwt" {
  interface JWT { version?: number; issued?: number }
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: "/sign-in" },
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  providers: [
    CredentialsProvider({
      name: "Password",
      credentials: { username: { label: "Username" }, password: { label: "Password", type: "password" } },
      async authorize(input, request) {
        const parsed = loginSchema.safeParse(input);
        const rawIp = process.env.VERCEL === "1" ? request.headers?.["x-vercel-forwarded-for"] : undefined;
        const ip = typeof rawIp === "string" ? rawIp.split(",")[0].trim() : undefined;
        if (!await takeLoginAttempt(parsed.success ? parsed.data.username : "invalid-input", ip && isIP(ip) ? ip : undefined)) return null;
        if (!parsed.success) return null;
        const { username, password } = parsed.data;
        const [user] = await getDb().select().from(users).where(eq(users.username, username));
        const verified = await verifyPassword(password, user?.passwordHash);
        if (!verified || !user?.active) return null;
        return { id: user.id, name: user.displayName, version: user.sessionVersion };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.version = user.version;
        token.issued = Math.floor(Date.now() / 1000);
      }
      return token;
    },
    session({ session, token }) {
      session.user = { id: token.sub ?? "", name: token.name ?? "", version: token.version ?? 0, issued: token.issued ?? 0 };
      return session;
    },
  },
};

export class AccessError extends Error {
  constructor(message = "This action is unavailable with your current permissions.") { super(message); }
}

export async function getActor(allowPasswordChange = false) {
  const session = await getServerSession(authOptions);
  if (!session?.user.id || Date.now() / 1000 - session.user.issued > 8 * 60 * 60) return null;
  const [user] = await getDb().select({
    id: users.id, username: users.username, displayName: users.displayName, superAdmin: users.superAdmin,
    active: users.active, version: users.sessionVersion, mustChangePassword: users.mustChangePassword,
  }).from(users).where(eq(users.id, session.user.id));
  if (!user?.active || user.version !== session.user.version || (user.mustChangePassword && !allowPasswordChange)) return null;
  return user;
}

export type Actor = NonNullable<Awaited<ReturnType<typeof getActor>>>;

export async function requireActor(allowPasswordChange = false) {
  const actor = await getActor(allowPasswordChange);
  if (!actor) throw new AccessError("Your session has expired. Sign in and try again.");
  return actor;
}
