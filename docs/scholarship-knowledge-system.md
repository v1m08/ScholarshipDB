# Phase A: BigFuture baseline restoration

Phase A is a read-only audit of the repository's BigFuture source export against the current generated catalog. It creates a restoration plan but does not write to Supabase or alter production records.

## Run it

```powershell
npm run phase-a:bigfuture
```

Generated files are written to `data/phase-a/` and ignored by Git:

- `bigfuture-baseline.jsonl`: normalized, BigFuture-only canonical candidates.
- `restoration-plan.jsonl`: field-level changes that are safe to restore automatically.
- `review-queue.jsonl`: missing records, missing BigFuture values, and conflicting duplicate rows.
- `audit-report.json` and `audit-report.md`: counts and validation results.
- `manifest.json`: SHA-256 hashes for reproducibility.

## Resolution rules

1. Preserve `data/imports/bigfuture/records.jsonl` as the immutable raw source.
2. Validate the BigFuture ID, source host, dates, URLs, booleans, numbers, and structured arrays before producing a plan.
3. Collapse records only when the existing catalog fingerprint matches exactly: lower-cased title, lower-cased provider, and application URL (or source URL when no application URL exists).
4. Keep all source URLs when exact duplicates collapse.
5. Give supported BigFuture fields priority 100 and confidence `0.99`.
6. Never erase a current value when BigFuture has no value. Retain it at confidence `0.50` and send it to review.
7. Send disagreements inside duplicate BigFuture groups to review and exclude those fields from automatic restoration.
8. Send missing or ambiguous catalog matches to review.
9. Preserve source tags for inspection, but do not restore them automatically. Taxonomy work belongs to Phase B.

Each planned field decision records the field name, source name and priority, raw/normalized/current/chosen values, reason, confidence, and source observation date.

## Private Supabase schema

`supabase/migrations/20260721112950_scholarship_knowledge_system.sql` is an unapplied staging migration for a future Supabase staging environment. It contains only Phase A storage:

- raw and normalized source records;
- restoration runs and proposed entities;
- field-level provenance decisions;
- pre-apply snapshots;
- review items and audit events.

The schema is `internal`, is not exposed by the project API configuration, has row-level security enabled, and grants nothing to `public`, `anon`, or `authenticated`. The migration never reads from or writes to `public.scholarships`.

## Apply and rollback policy

No restoration may be applied until a separate staging Supabase project or paid Supabase branch exists. At that point:

1. Apply the private migration in staging.
2. Load the audit artifacts with a separate, reviewed loader.
3. Resolve every review-queue item.
4. Snapshot each target row before any update.
5. Apply only approved field decisions in one transaction.
6. Compare row counts and field counts with `audit-report.json`.
7. Roll back from `scholarship_restoration_snapshots` if verification fails.

For the current file-only workflow, rollback is simply deleting `data/phase-a/`; source data and Supabase remain unchanged.
