import type { Metadata } from "next";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "OpenScholar Index | Search scholarships freely",
    template: "%s | OpenScholar Index",
  },
  description: "A free, open and source-linked directory of scholarships for U.S. students.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://openscholar-index.vercel.app"),
  openGraph: {
    title: "OpenScholar Index",
    description: "Search public, source-linked scholarships without creating an account.",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/">
            <span>OpenScholar</span> Index
          </Link>
          <SiteNav />
        </header>
        {children}
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
