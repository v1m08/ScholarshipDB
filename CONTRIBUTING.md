# Contributing

Thanks for helping make scholarship information easier to find.

## Local setup

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm test
npm run typecheck
```

CI also builds the application with the development snapshot enabled.

## Good contributions

- Scholarship corrections backed by an original provider URL
- New public source records that follow the existing data contract
- Accessibility and usability fixes
- Focused search, performance, test, or documentation improvements

Use the data-correction issue form when the right implementation is uncertain.

## Data rules

The repository ships sample data, not the private 42,000+ record working set. Do not commit `src/generated/`, crawler profiles, imports, caches, logs, or enrichment outputs. The ignore rules cover these paths.

Do not guess missing scholarship facts. Leave an unknown field empty and include the provider source. Do not add personal applicant data.

## Database changes

Create a migration with the Supabase CLI:

```bash
npx supabase migration new describe_your_change
```

Keep public access read-only, preserve Row Level Security, and update the security tests when the database contract changes.

## Pull requests

Keep each pull request focused. Explain what changed, how it was verified, and any data source used. Never commit API keys or `.env.local`.