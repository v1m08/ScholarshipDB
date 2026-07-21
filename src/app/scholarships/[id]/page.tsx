import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import relatedScholarships from "@/generated/related-scholarships.json";
import { ScholarshipReportButton } from "@/components/ScholarshipReportButton";
import { notFound } from "next/navigation";
import { getPublishedScholarship } from "@/lib/supabase/search";
import { canUseSnapshotFallback, hasSupabaseConfig } from "@/lib/supabase/server";
import {
  effectiveVetting,
  formatDate,
  formatMoney,
  isClosed,
  localDateString,
  sourceMissingFields,
  type ScholarshipSummary,
  yesNoUnknown,
} from "@/lib/scholarship";

interface DetailProps {
  params: Promise<{ id: string }>;
}

const relatedByTag = relatedScholarships as Record<string, ScholarshipSummary[]>;

export const revalidate = 86400;

const loadScholarship = cache(async (id: string) => {
  if (hasSupabaseConfig()) return getPublishedScholarship(id);
  if (!canUseSnapshotFallback()) throw new Error("Supabase is required in production.");
  const { getScholarship } = await import("@/lib/catalog");
  return (await getScholarship(id)) || null;
});

export async function generateMetadata({ params }: DetailProps): Promise<Metadata> {
  const { id } = await params;
  const scholarship = await loadScholarship(id);
  if (!scholarship) return {};
  return {
    title: scholarship.title,
    description: `${formatMoney(scholarship.award.maximum, scholarship.award.varies)} from ${scholarship.provider}. Eligibility and source details.`,
    alternates: { canonical: `/scholarships/${scholarship.id}` },
    openGraph: {
      title: scholarship.title,
      description: `${formatMoney(scholarship.award.maximum, scholarship.award.varies)} from ${scholarship.provider}.`,
      type: "article",
    },
  };
}

function listOrUnknown(values: string[]): string {
  return values.length ? values.join(", ") : "Not published";
}

export default async function ScholarshipPage({ params }: DetailProps) {
  const { id } = await params;
  const scholarship = await loadScholarship(id);
  if (!scholarship) notFound();
  const asOfDate = localDateString();
  const vetting = effectiveVetting(scholarship);
  const missingFields = sourceMissingFields(scholarship);
  const related = scholarship.eligibility.tags
    .flatMap((tag) => relatedByTag[tag] || [])
    .filter((item, index, items) => item.id !== scholarship.id && items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3);

  return (
    <main className="detail-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "/" }, { "@type": "ListItem", position: 2, name: "Scholarships", item: "/scholarships" }, { "@type": "ListItem", position: 3, name: scholarship.title, item: `/scholarships/${scholarship.id}` }] }) }} />
      <Link className="back" href="/scholarships">Back to all scholarships</Link>
      {scholarship.eligibility.tags.includes("international-students") && <Link className="back" href="/scholarships/for/international-students">See all international student scholarships</Link>}
      <article className={isClosed(scholarship, asOfDate) ? "detail closed-card" : "detail open-card"}>
        <div className="detail-head">
          <div className="badge-row">
            <p className={isClosed(scholarship, asOfDate) ? "status closed" : "status open"}>
              {isClosed(scholarship, asOfDate) ? "Past deadline" : "Active deadline"}
            </p>
            {vetting.status !== "unvetted" && (
              <span className="vetting-ribbon human-vetted">
                ✓ Vetted{vetting.vettedAt ? ` ${formatDate(vetting.vettedAt)}` : ""}
              </span>
            )}
            {scholarship.institutionSpecific && (
              <span
                aria-label="College-specific"
                className="institution-badge"
                title={`College-specific${scholarship.institutionName ? `: ${scholarship.institutionName}` : ""}`}
              >
                Institution
              </span>
            )}
          </div>
          <h1>{scholarship.title}</h1>
          <p className="provider">{scholarship.provider}</p>
          <div className="detail-featured">
            <strong>{formatMoney(scholarship.award.maximum, scholarship.award.varies)}</strong>
            <span>Deadline: {formatDate(scholarship.deadline)}</span>
          </div>
          <p>{scholarship.description}</p>
          <a className="button" href={scholarship.applicationUrl} rel="noreferrer" target="_blank">
            View original listing
          </a>
          <ScholarshipReportButton scholarshipId={scholarship.id} />
        </div>
        <section>
          <h2>Eligibility</h2>
          <dl className="detail-grid">
            <div><dt>Location</dt><dd>{listOrUnknown(scholarship.eligibility.states.length ? scholarship.eligibility.states : scholarship.eligibility.countries)}</dd></div>
            <div><dt>Grade</dt><dd>{listOrUnknown(scholarship.eligibility.grades)}</dd></div>
            <div><dt>Degree</dt><dd>{listOrUnknown(scholarship.eligibility.degreeLevels)}</dd></div>
            <div><dt>Fields</dt><dd>{listOrUnknown(scholarship.eligibility.fields)}</dd></div>
            <div><dt>Minimum GPA</dt><dd>{scholarship.eligibility.minimumGpa ?? "Not published"}</dd></div>
            <div><dt>Minimum age</dt><dd>{scholarship.eligibility.minimumAge ?? "Not published"}</dd></div>
            <div><dt>Citizenship</dt><dd>{listOrUnknown(scholarship.eligibility.citizenship)}</dd></div>
          </dl>
          {!!scholarship.eligibility.other.length && (
            <ul className="requirements-list">
              {scholarship.eligibility.other.map((value) => <li key={value}>{value}</li>)}
            </ul>
          )}
        </section>
        <section>
          <h2>Application facts</h2>
          <dl className="detail-grid compact">
            <div><dt>Essay required</dt><dd>{yesNoUnknown(scholarship.requirements.essay)}</dd></div>
            <div><dt>Need-based</dt><dd>{yesNoUnknown(scholarship.requirements.needBased)}</dd></div>
            <div><dt>Merit-based</dt><dd>{yesNoUnknown(scholarship.requirements.meritBased)}</dd></div>
            <div><dt>Application fee</dt><dd>{yesNoUnknown(scholarship.requirements.fee)}</dd></div>
          </dl>
          <p className="unknown-note">
            "Not published" means this field was not visible in the public indexed source,
            not that the requirement does not exist.
          </p>
        </section>
        {!!related.length && (
          <section>
            <h2>Related scholarships</h2>
            <ul className="requirements-list">
              {related.map((item) => <li key={item.id}><Link href={`/scholarships/${item.id}`}>{item.title}</Link> — {item.provider}</li>)}
            </ul>
          </section>
        )}
        <section className="provenance">
          <h2>Source</h2>
          <p>
            Original source: <a href={scholarship.sourceUrl} rel="noreferrer" target="_blank">{scholarship.sourceName}</a>.
            {" "}This record was last checked on {formatDate(scholarship.sourceCheckedAt)}.
            Confirm current deadlines and complete rules before applying.
          </p>
          {vetting.status !== "unvetted" && (
            <p>
              Vetted
              {vetting.vettedAt ? ` on ${formatDate(vetting.vettedAt)}` : ""}.
              {typeof vetting.confidence === "number" ? ` Confidence score: ${Math.round(vetting.confidence * 100)}%.` : ""}
            </p>
          )}
          <p>
            Fields not fully fetched: {missingFields.length ? missingFields.join(", ") : "none currently flagged"}.
          </p>
          {(scholarship.sourceUrls?.length || 0) > 1 && (
            <p>
              Also found in {scholarship.sourceUrls!.length - 1} additional source page
              {scholarship.sourceUrls!.length === 2 ? "" : "s"} from this index provider.
            </p>
          )}
        </section>
      </article>
    </main>
  );
}
