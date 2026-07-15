import type { MetadataRoute } from "next";
import { loadFullCatalogIntoMemory } from "@/lib/directory-store";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const scholarships = await loadFullCatalogIntoMemory();
  const root = process.env.NEXT_PUBLIC_SITE_URL || "https://openscholar-index.vercel.app";
  return [
    { url: root, changeFrequency: "weekly", priority: 1 },
    { url: `${root}/scholarships`, changeFrequency: "daily", priority: 1 },
    ...scholarships.map((scholarship) => ({
      url: `${root}/scholarships/${scholarship.id}`,
      lastModified: scholarship.sourceCheckedAt,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];
}
