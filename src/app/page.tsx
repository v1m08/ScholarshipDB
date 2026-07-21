import Link from "next/link";
import { AnnotatedCardGuide } from "@/components/AnnotatedCardGuide";
import { BuildPipeline } from "@/components/BuildPipeline";
import { directoryMetadata } from "@/lib/directory-initial";

export const revalidate = 300;

async function publishedScholarshipCount(): Promise<number | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return null;

  try {
    const response = await fetch(`${url}/rest/v1/scholarships?select=id&publication_status=eq.published`, {
      headers: { apikey: publishableKey, Prefer: "count=exact" },
      method: "HEAD",
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    const count = Number(response.headers.get("content-range")?.split("/").pop());
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const scholarshipCount = await publishedScholarshipCount();
  return (
    <main className="homepage">
      <section className="home-hero">
        <p className="eyebrow">OpenScholar Index</p>
        <h1>Finding Scholarships shouldn't be harder than winning them</h1>
        <p className="lede">
          Search, shortlist, and apply to thousands of scholarships.
          <br/>All in one place. For Free.
        </p>
        <Link className="button" href="/scholarships">
          {scholarshipCount
            ? `Search ${scholarshipCount.toLocaleString("en-US")} scholarships`
            : "Search scholarships"}
        </Link>
        <p><Link href="/scholarships/for/international-students">Browse scholarships for international students studying in the U.S.</Link></p>
      </section>

      <section className="home-strengths">
        <div className="home-section-heading">
          <p className="eyebrow">Why it is useful</p>
          <h2>One place to explore a much wider scholarship landscape.</h2>
          <p>The index is designed to make early research faster, clearer, and easier to organize.</p>
        </div>
        <div className="strength-grid">
          <article><strong>Broad discovery</strong><p>Search tens of thousands of source-linked opportunities across several public directories.</p></article>
          <article><strong>Comparable details</strong><p>Review deadlines, award amounts, eligibility, and provider information in one consistent layout.</p></article>
          <article><strong>Private shortlisting</strong><p>Select useful scholarships and export the list without creating an account.</p></article>
        </div>
      </section>

      <section className="home-help">
        <div className="home-section-heading">
          <p className="eyebrow">Ways to help</p>
          <h2>Help keep scholarship information useful.</h2>
          <p>Small corrections and firsthand knowledge make the directory better for the next student.</p>
        </div>
        <div className="strength-grid help-grid">
          <article>
            <strong>Report incorrect information</strong>
            <p>Open any scholarship and use the Report button to flag an outdated deadline, broken link, or other issue.</p>
            <Link className="help-link" href="/scholarships">Find a scholarship</Link>
          </article>
          <article>
            <strong>Share what you know</strong>
            <p>Scholarship winners and applicants can submit firsthand details and supporting sources for review.</p>
            <Link className="help-link" href="/contribute">Contribute information</Link>
          </article>
        </div>
      </section>

      <section className="home-development">
        <div className="home-section-heading">
          <p className="eyebrow">How it was built</p>
          <h2>From scattered public pages to one searchable index.</h2>
          <p>
            The current index was updated on {directoryMetadata.generatedOn}
          </p>
        </div>
        <BuildPipeline />
        <div className="source-panel">
          <div>
            <p className="eyebrow">Sources</p>
            <h3>Public pages used for discovery</h3>
          </div>
          <ul className="source-list">
            <li><a href="https://bigfuture.collegeboard.org/scholarships" rel="noreferrer" target="_blank">BigFuture Scholarship Search</a> - {directoryMetadata.bigFutureDiscoveredCount.toLocaleString("en-US")} discovered listings.</li>
            <li><a href="https://how2winscholarships.com/category/college-scholarships/" rel="noreferrer" target="_blank">How to Win Scholarships</a> - editorial discovery pages and linked opportunities.</li>
            <li><a href="https://cloudfront.careeronestop.org/toolkit/training/find-scholarships.aspx" rel="noreferrer" target="_blank">CareerOneStop Scholarship Finder</a> - public scholarship directory records.</li>
            <li><a href="https://scholarshipamerica.org/students/browse-scholarships/" rel="noreferrer" target="_blank">Scholarship America</a> - public browse and scholarship detail pages.</li>
          </ul>
        </div>
      </section>

      <section className="home-warning">
        <p className="eyebrow">Use with care</p>
        <p>
          This project collected scholarships using automated extraction, normalization, and enrichment across thousands of public pages. Deadlines may be outdated, some fields may be parsed incorrectly, and eligibility requirements may be missing/incorrect. Please open the original provider page and confirm the current deadline, award, eligibility, and application instructions before investing time or sharing personal information.
        </p>
      </section>

      <AnnotatedCardGuide />
    </main>
  );
}
