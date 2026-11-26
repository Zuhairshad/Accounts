import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "AZAM EASY ACCOUNTS", template: "%s | AZAM EASY ACCOUNTS" }, description: "Multi-company accounting workspace", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
