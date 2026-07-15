# OpenScholar Index

A free, open-source scholarship search directory. Students can search and filter scholarships, view vetted listings, and keep an account-free bookmark shortlist in browser memory.

> **Use with care:** Scholarship information changes. Always confirm the current deadline, award, eligibility, and application instructions on the original provider page before applying or sharing personal information.

## What the MVP includes

- Search, filters, sorting, and cursor pagination
- A vetted-only filter
- Source-linked scholarship details
- In-memory bookmarks with no accounts or student data
- A read-only Supabase production database
- A deterministic local snapshot for development and CI

It intentionally does not include authentication, submissions, public editing, or maintainer dashboards.

## Data included in Git

The repository contains a small sample dataset in `data/scholarships.json` so every contributor can run the app and tests. The full 42,000+ record working dataset, crawler profiles, enrichment caches, generated indexes, and import artifacts stay local and are excluded by `.gitignore`.

Production reads the full published catalog from Supabase. Run `npm run index` before publishing to rebuild `src/generated/catalog.json` from any full local data you have.

## Quick start

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Development automatically uses the sample snapshot when Supabase is not configured.

Useful checks:

```bash
npm test
npm run typecheck
```

To test a production build against the sample snapshot, set `ALLOW_SNAPSHOT_FALLBACK=true` for that command. Real deployments fail closed unless Supabase is configured.

## Supabase setup

The public app can read published scholarships and submit write-only issue reports. Row Level Security prevents public users from reading reports or changing moderation status, and the search function runs as security invoker.

### 1. Create and link a project

Create a project at [Supabase](https://supabase.com), then copy its project reference from the dashboard URL.

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

### 2. Apply the schema

The schema is versioned in `supabase/migrations/`.

```bash
npx supabase db push
```

For later database changes, create a new migration instead of editing the live database:

```bash
npx supabase migration new describe_your_change
```

### 3. Configure the app

Copy `.env.example` to `.env.local`. From the Supabase dashboard, copy the Project URL and publishable key from Project Settings > API Keys.

```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

The publishable key is safe to expose; database access is enforced by grants and Row Level Security.

### 4. Publish the catalog

First build the local catalog:

```bash
npm run index
```

Create or copy a Supabase secret key from Project Settings > API Keys and add it to `.env.local` only for the upload:

```dotenv
SUPABASE_SECRET_KEY=YOUR_LOCAL_ONLY_SECRET_KEY
```

Then publish and remove that line immediately afterward:

```bash
npm run db:publish
npm run prod:check
```

The publisher upserts in batches of 100. It also supports the legacy service-role key for existing projects, but privileged keys must never be added to a deployment or committed.

Verify the upload in the Supabase SQL editor:

```sql
select publication_status, count(*)
from public.scholarships
group by publication_status;
```

### Review submitted reports

Project members can open **Supabase Dashboard > Table Editor > scholarship_reports**. Contributors need an invitation to the Supabase project; reports are intentionally not public.

For a useful review queue, run this in the SQL Editor:

    select r.id, r.created_at, r.issue, r.status, s.title, s.source_url
    from public.scholarship_reports r
    join public.scholarships s on s.id = r.scholarship_id
    where r.status = 'open'
    order by r.created_at;

Set status to resolved or dismissed in the Table Editor after reviewing a report.

### 5. Deploy

Vercel is the shortest path:

1. Import the GitHub repository.
2. Add only `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. Do not add OpenRouter, Gemini, Supabase secret, or service-role keys.
4. Deploy. The production check rejects a missing database configuration or a privileged Supabase key.

## Optional data enrichment

Python is needed only for the enrichment pipeline.

```bash
python -m venv .venv-enrichment
# Activate the environment for your shell, then:
python -m pip install -r requirements-enrichment.txt
```

Add `OPENROUTER_KEY` or `GEMINI_API_KEY` to `.env.local`, then use the maintained entry points:

```bash
npm run data:status
npm run data:enrich
npm run data:audit
npm run test:enrichment
```

The enrichment command processes a bounded 100-record batch and checkpoints progress. Re-run it to continue. Local imports, caches, generated indexes, crawler profiles, and superseded one-off collectors are intentionally not published.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/app` | Next.js pages and read-only API routes |
| `src/components` | Search, filters, bookmarks, and shared UI |
| `src/lib` | Search contracts, snapshot search, and Supabase access |
| `data` | Public sample records, sources, and taxonomy contracts |
| `scripts/build-index.mjs` | Builds the local snapshot and search shards |
| `scripts/enrichment` | Maintained enrichment pipeline and its self-test |
| `supabase/migrations` | Versioned database schema |
| `tests` | Focused Node tests for data, search, and security boundaries |

## Security and privacy

- The app collects no account or student profile data.
- Bookmarks exist only in browser memory.
- Public routes are read-only and bound search input/result sizes.
- Production requires Supabase and does not silently fall back to bundled data.
- Secret files and full private working data are ignored.
- CI runs tests, type checking, and a production build.
- No software can promise zero vulnerabilities. Follow [SECURITY.md](SECURITY.md) for private reporting.

Before making the repository public, enable GitHub secret scanning, push protection, Dependabot alerts, private vulnerability reporting, and branch protection requiring the CI check.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Corrections should include the original provider URL and evidence. Keep pull requests focused and never commit secrets, generated indexes, crawler output, or the private full dataset.

## License

[MIT](LICENSE)