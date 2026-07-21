import Link from "next/link";
import { categoryHref, internationalCategories, type SeoCategory } from "@/lib/seo/categories";
import { formatDate, formatMoney, type Scholarship } from "@/lib/scholarship";

export function CategoryLanding({ category, scholarships, total }: { category: SeoCategory; scholarships: Scholarship[]; total: number }) {
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: category.faq.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })) };
  const list = { "@context": "https://schema.org", "@type": "CollectionPage", name: category.title, mainEntity: { "@type": "ItemList", numberOfItems: scholarships.length, itemListElement: scholarships.map((item, index) => ({ "@type": "ListItem", position: index + 1, url: `/scholarships/${item.id}`, name: item.title })) } };

  return <main className="category-page">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faq) }} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(list) }} />
    <section className="category-hero"><p className="eyebrow">Scholarship directory</p><h1>{category.title}</h1><p className="lede">{category.intro}</p><p className="category-count"><strong>{total.toLocaleString("en-US")}</strong> matching scholarship{total === 1 ? "" : "s"}</p></section>
    <section aria-label="Scholarship results">{scholarships.length ? <div className="category-list">{scholarships.map((scholarship) => <Link className="category-card" href={`/scholarships/${scholarship.id}`} key={scholarship.id}><div><h2>{scholarship.title}</h2><p>{scholarship.provider}</p></div><dl><div><dt>Award</dt><dd>{formatMoney(scholarship.award.maximum, scholarship.award.varies)}</dd></div><div><dt>Deadline</dt><dd>{formatDate(scholarship.deadline)}</dd></div></dl></Link>)}</div> : <p className="category-empty">We’re expanding this list. Check back soon, or browse all scholarships while we verify more international-student eligibility.</p>}</section>
    <section className="category-section"><h2>Frequently asked questions</h2>{category.faq.map((item) => <article key={item.question}><h3>{item.question}</h3><p>{item.answer}</p></article>)}</section>
    <nav aria-label="Related scholarship hubs" className="category-section category-related"><h2>Explore related scholarships</h2>{internationalCategories.filter((item) => item !== category).map((item) => <Link key={categoryHref(item)} href={categoryHref(item)}>{item.title}</Link>)}</nav>
  </main>;
}
