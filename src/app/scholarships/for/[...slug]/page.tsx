import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CategoryLanding } from "@/components/CategoryLanding";
import { initialDirectory } from "@/lib/directory-initial";
import { getInternationalCategory, internationalCategories } from "@/lib/seo/categories";
import { isClosed, localDateString, type Scholarship } from "@/lib/scholarship";

interface CategoryProps { params: Promise<{ slug: string[] }> }
export const revalidate = 86400;

export function generateStaticParams() { return internationalCategories.map((category) => ({ slug: category.slug })); }

async function loadCategory(slug: string[]) {
  const category = getInternationalCategory(slug);
  if (!category) return null;
  const asOfDate = localDateString();
  const records = initialDirectory.records.filter((item: Scholarship) => {
    if (isClosed(item, asOfDate) || !item.eligibility.tags.includes("international-students")) return false;
    const tags = item.eligibility.tags.map((tag) => tag.toLowerCase());
    return (!category.secondaryTags || category.secondaryTags.every((tag) => tags.includes(tag))) && (!category.degreeLevels || category.degreeLevels.some((level) => item.eligibility.degreeLevels.some((value) => value.toLowerCase().includes(level))));
  });
  return { category, scholarships: records, total: records.length };
}

export async function generateMetadata({ params }: CategoryProps): Promise<Metadata> {
  const { slug } = await params;
  const data = await loadCategory(slug);
  if (!data) return {};
  const canonical = `/scholarships/for/${slug.join("/")}`;
  return { title: data.category.title, description: data.category.description, alternates: { canonical }, openGraph: { title: data.category.title, description: data.category.description }, robots: data.scholarships.length < 5 ? { index: false, follow: true } : undefined };
}

export default async function InternationalScholarshipsPage({ params }: CategoryProps) {
  const { slug } = await params;
  const data = await loadCategory(slug);
  if (!data) notFound();
  return <CategoryLanding {...data} />;
}
