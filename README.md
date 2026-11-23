# ScholarshipDB

The data backend for a scholarship directory: it finds where scholarships are published, fetches and stores those pages, extracts each listing into one record format, and owns the database schema that a separate website reads from.

> Scholarship information changes. Records always link to the original provider page, which stays the source of truth.

## Layout

| Path | Purpose |
| --- | --- |
| `data/registry/platforms.json` | Scholarship platforms (AcademicWorks, ScholarshipUniverse, AwardSpring and others), their address patterns, and what has been verified about each |
| `data/registry/institutions.json` | Every active U.S. institution from the federal IPEDS file |
| `data/registry/portals.json` | Institution portals found on each platform |
| `data/gold/gold-set.json` | Hand-checked reference records; defines the record format and is what extraction is scored against |
| `data/scholarships.json`, `data/taxonomy/` | Sample records and tag vocabulary from the earlier pipeline, kept for reference |
| `scripts/portal-scan.mjs` | Rebuilds `portals.json` by testing each institution against each platform |
| `crawler/` | Fetch-and-store jobs for the crawl server, with their own dependencies |
| `supabase/migrations/` | Database schema; the published catalog is served through Supabase |
| `tests/` | Node tests for the scanner, crawler helpers and gold set |

## Commands

Requirements: Node.js 20+. The root package has no dependencies.

```bash
npm test
npm run portal-scan
```

The crawler needs a headless browser, installed once inside `crawler/`:

```bash
cd crawler && npm install && npm run browser
```

Then run a job. Output goes to `data/raw/` (git-ignored) and is resumable:

```bash
node survey-portals.mjs --limit 40
```

On the crawl server, `crawler/run-job.sh` runs a job, copies `data/raw/` to the S3 bucket named in `RAW_BUCKET`, and powers the machine off when `SHUTDOWN_WHEN_DONE=1`.

## Status

- Done: platform registry, institution list, portal scan (1,327 portals), 20-record gold set, portal survey job.
- Next: run the survey, crawl listings from portals that are public, extract into the gold-set format, publish to the database.

The website that used to live in this repository is preserved at the `website-v1` tag.

## Security

- No secrets belong in this repository. Copy `.env.example` to `.env` (git-ignored) on the machine that needs it.
- The crawler identifies itself, spaces out requests per platform, and only reads pages a signed-out visitor can see.
- Follow [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

[MIT](LICENSE)
