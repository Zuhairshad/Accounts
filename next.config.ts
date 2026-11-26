import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";
// Next.js App Router emits inline bootstrap scripts, so 'unsafe-inline' is required for scripts without per-request
// nonces. Everything else is restricted to this origin: no third-party scripts, no cross-origin fetches or form posts.
const csp = [
  "default-src 'self'", `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "font-src 'self' data:", `connect-src 'self'${production ? "" : " ws:"}`, "frame-src 'self' blob:",
  "worker-src 'self' blob:", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join("; ");

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pdfkit"],
  outputFileTracingRoot: process.cwd(),
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: csp },
        ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    }];
  },
};
export default config;
