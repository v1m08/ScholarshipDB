# ScholarshipDB

The data backend for a scholarship directory: it finds where scholarships are published, fetches and stores those pages, extracts each listing into one record format, and owns the database schema that a separate website reads from.

> Scholarship information changes. Records always link to the original provider page, which stays the source of truth.

## Layout

| Path | Purpose |
| --- | --- |
| `crawler/site.mjs` | Give it a scholarship site: finds the relevant pages, groups them per scholarship, condenses them, and fills metadata by keyword rules with the source line for every value |
| `crawler/eval-gold.mjs` | Scores that output field by field against the gold set |
| `crawler/survey-portals.mjs` | Visits every institution portal once and records what a signed-out visitor can see |
| `crawler/collect-portal-links.mjs` | Walks every open portal's award lists and records each award link |
| `crawler/collect-scholarship-america.mjs` | Lists Scholarship America's program pages from its sitemap |
| `crawler/collect-listing-sites.mjs` | Takes leads (name, provider, provider's address) from college-agnostic listing sites |
| `crawler/read-portal-awards.mjs` | Opens each AcademicWorks award page and turns it into a record |
| `crawler/scrape-schools.mjs` | Starts at each school's financial aid page, follows its scholarship pages and records the named scholarships on them |
| `crawler/scrape-links.mjs` | Runs the site scraper over every not-yet-scraped provider link in the links list |
| `scripts/build-links.mjs` | Merges every source into `data/links/links.json` and removes duplicates |
| `data/links/links.json` | The links list: one entry per known scholarship with the page it is officially published on, which sources pointed to it, and whether it has been scraped |
| `crawler/lib/` | Page discovery, cleaning, digest and rules, fetching (plain HTTP with a headless-browser fallback), storage |
| `crawler/run-job.sh` | Runs a job on the crawl server, copies output to S3, and can power the machine off |
| `scripts/portal-scan.mjs` | Rebuilds `portals.json` by testing each institution against each platform |
| `data/registry/` | Scholarship platforms, every active U.S. institution (federal IPEDS file), and the institution portals found on each platform |
| `data/gold/gold-set.json` | Hand-checked reference records; defines the record format |
| `data/scholarships.json`, `data/taxonomy/` | Sample records and tag vocabulary from the earlier pipeline, kept for reference |
| `supabase/migrations/` | Database schema; the published catalog is served through Supabase |
| `tests/` | Node tests for the scraper rules, crawler helpers and gold set |

## Commands

Requirements: Node.js 20+. The root package has no dependencies.

```bash
npm test
```

Analyze one scholarship site (works without the browser for most sites):

```bash
cd crawler && node site.mjs https://www.jkcf.org/
```

Add `--quiet` to print only the metadata. Results are saved under `data/raw/sites/` (git-ignored).

Score the rules against the gold set:

```bash
cd crawler && node eval-gold.mjs
```

Sites that render with JavaScript need the headless browser, installed once:

```bash
cd crawler && npm install && npm run browser
```

On the crawl server, `crawler/run-job.sh` runs a job, copies `data/raw/` to the S3 bucket named in `RAW_BUCKET`, and powers the machine off when `SHUTDOWN_WHEN_DONE=1`.

## How listings are gathered

Sources only tell us that a scholarship exists and where it is published. Every detail in a record is read from that original page, never copied from an aggregator.

1. **Collect links** from each source: institution portals (`collect-portal-links.mjs`), Scholarship America, the gold set, and listing sites that are not tied to one college (`collect-listing-sites.mjs`: BigFuture, Scholarships360, Access Scholarships, Sallie, Peterson's, JLV's weekly posts). From a listing site only the name, the provider and the provider's own address are taken. Each site's robots.txt is obeyed; sites that disallow or refuse crawlers (AwardSpring portals, Bold.org, CareerOneStop, Scholarships.com) are left out.
2. **Merge** them into `data/links/links.json` (`node scripts/build-links.mjs`). The same scholarship found through several sources becomes one entry; a name without an address is kept as `needs-url`.
3. **Scrape** each entry's page into a record. AcademicWorks award pages share one layout and have their own reader (`read-portal-awards.mjs`); other addresses go through the site scraper.

## How the scraper decides

1. **Find pages.** Read the site's sitemaps and the links on the start page.
2. **Keep the relevant ones.** Score each address and link text: "eligibility", "how to apply" and "FAQ" score high; news, donation and legal pages are dropped.
3. **Group per scholarship.** One site often runs several programs, so pages are bundled by the folder they sit in.
4. **Clean and condense.** Strip menus, scripts and footers, then keep only lines that carry dates, amounts, eligibility or application facts.
5. **Fill metadata.** Keyword rules read those lines. Only the first application round is described, award amounts above $70,000 are flagged for manual entry, and anything doubtful is listed under `doubts`.

The crawler identifies itself, honors a site's requested crawl delay, and records sites that block automated visitors as blocked; it does not work around them.

## Status

Against the 20-record gold set the keyword rules get about 65% of fields right, and about 85% of the values they do give are correct. Dates are the weakest field. The rules were tuned on those same sites, so expect lower numbers on unseen ones.

The website that used to live in this repository is preserved at the `website-v1` tag and is being rebuilt in its own repository.

## Security

- No secrets belong in this repository. Copy `.env.example` to `.env` (git-ignored) on the machine that needs it.
- The crawler identifies itself, spaces out requests per platform, and only reads pages a signed-out visitor can see.
- Follow [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

[MIT](LICENSE)
