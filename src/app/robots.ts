import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const root = process.env.NEXT_PUBLIC_SITE_URL || "https://openscholar-index.vercel.app";
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${root}/sitemap.xml`,
  };
}
