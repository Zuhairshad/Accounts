import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

// Self-hosted at build time, so the font satisfies the font-src 'self' content security policy.
const sans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = { title: { default: "AZAM EASY ACCOUNTS", template: "%s | AZAM EASY ACCOUNTS" }, description: "Multi-company accounting workspace", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={sans.variable}><body>{children}</body></html>;
}
