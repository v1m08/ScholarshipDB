# Contributing

Thanks for helping make scholarship information easier to find.

## Local setup

Requirements: Node.js 20+. Before opening a pull request, run:

```bash
npm test
```

## Good contributions

- Scholarship corrections backed by an original provider URL
- New public source records that follow the existing data contract
- Focused crawler, extraction, test, or documentation improvements

Use the data-correction issue form when the right implementation is uncertain.

## Data rules

Do not commit raw crawled pages (`data/raw/`), caches, logs, or secrets. The ignore rules cover these paths.

Do not guess missing scholarship facts. Leave an unknown field empty and include the provider source. Do not add personal applicant data.

## Database changes

Create a migration with the Supabase CLI:

```bash
npx supabase migration new describe_your_change
```

Keep scholarship data publicly read-only. Anonymous report submissions must remain insert-only, bounded by database constraints, and unreadable to public roles. Preserve Row Level Security.

## Pull requests

Keep each pull request focused. Explain what changed, how it was verified, and any data source used. Never commit API keys or `.env` files.