import type { MetadataRoute } from "next";
import { categoryHref, internationalCategories } from "@/lib/seo/categories";
import sitemapJson from "@/generated/sitemap.json";
import categoryCounts from "@/generated/category-counts.json";

const SCHOLARSHIPS_PER_SITEMAP = 10_000;

export function generateSitemaps() {
  return Array.from({ length: Math.ceil(sitemapJson.length / SCHOLARSHIPS_PER_SITEMAP) }, (_, id) => ({ id }));
}

export default function sitemap({ id }: { id: number }): MetadataRoute.Sitemap {
  const root = process.env.NEXT_PUBLIC_SITE_URL || "https://openscholar-index.vercel.app";
  const scholarships = sitemapJson.slice(id * SCHOLARSHIPS_PER_SITEMAP, (id + 1) * SCHOLARSHIPS_PER_SITEMAP);
  return [
    ...(id === 0 ? [{ url: root, changeFrequency: "weekly" as const, priority: 1 }, { url: `${root}/scholarships`, changeFrequency: "daily" as const, priority: 1 }, ...internationalCategories.filter((category) => categoryCounts[category.slug.join("/") as keyof typeof categoryCounts] >= 5).map((category) => ({ url: `${root}${categoryHref(category)}`, changeFrequency: "weekly" as const, priority: category.slug.length === 1 ? 0.9 : 0.7 }))] : []),
    ...scholarships.map((scholarship) => ({
      url: `${root}/scholarships/${scholarship.id}`,
      lastModified: scholarship.lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];
}
