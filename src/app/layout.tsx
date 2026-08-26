import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from "next/font/google";
import "./globals.css";

/**
 * Fonts are self-hosted rather than linked from Google's CDN.
 *
 * `next/font` fetches the files at build time and serves them from this origin,
 * so a running deployment makes no outbound request at all. That matters more
 * here than convenience: this app holds an admin-scoped API key, and "no calls
 * to anything we do not control" is easier to promise when it is literally
 * true. It also removes the render-blocking stylesheet and the FOUT.
 */

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-display",
  display: "swap",
});

const body = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "soif — water ledger",
  description: "How much freshwater your organization's LLM usage consumed.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
