# Adding scholarships

The catalog is standardized on the BigFuture record shape. Every scholarship — whatever its origin — is stored in that canonical schema, and custom metadata (taxonomy tags, enrichment, vetting) is layered on top by the build instead of being baked into the raw records.

## Data layers

1. **Raw imports** — `data/imports/<source>/records.jsonl`, immutable per-source exports in the canonical schema. BigFuture is the reference source.
2. **Overlays** — `data/enrichment/records.jsonl` (fill-missing only) and `data/tagging/records.jsonl` (versioned taxonomy tags). Overlays never overwrite a value a structured source provided.
3. **Generated catalog** — `npm run index` merges layers into `src/generated/`. Records from structured sources (currently BigFuture) win id/URL/fingerprint collisions; lower-priority duplicates only contribute their `sourceUrls`. After all overlays, the build derives taxonomy tags that follow directly from structured fields (`essay: false` → `no-essay`, `needBased: true` → `financial-need`, `meritBased: true` → `merit-based`; see `scripts/lib/derived-tags.mjs`), so a tag overlay can never erase a structured observation.
4. **Production** — `npm run db:publish` upserts the generated catalog into Supabase.

## Canonical record schema

The minimal candidate looks like this (see `src/lib/scholarship.ts` for the full type):

```json
{
  "title": "Example Scholarship",
  "provider": "Example Foundation",
  "sourceUrl": "https://example.com/scholarship",
  "applicationUrl": "https://example.com/apply",
  "deadline": "2027-01-15",
  "description": "One-paragraph description from the provider.",
  "award": { "maximum": 2000, "varies": false },
  "requirements": { "essay": null, "needBased": null, "meritBased": null, "fee": null },
  "eligibility": {
    "countries": ["US"], "states": ["Texas"], "grades": ["high-school-senior"],
    "degreeLevels": [], "fields": [], "minimumGpa": null, "minimumAge": null,
    "citizenship": [], "tags": ["stem"], "other": []
  }
}
```

Everything optional may be omitted; unknown booleans stay `null` ("not published"), never guessed. States, grades, countries, and tags are normalized automatically (aliases in `scripts/lib/normalize-record.mjs`; tag ids must exist in `data/taxonomy/scholarship-taxonomy.json` to survive the build).

## Adding records

```bash
npm run add -- path/to/candidates.json --source manual
```

- Accepts a JSON object, JSON array, or JSONL file.
- Normalizes and validates every candidate (URLs must be public http(s); dates `YYYY-MM-DD`).
- Generates a deterministic id (`<source>-<hash>`) when none is given.
- Deduplicates against the current catalog by id, source URL, and title|provider|application-URL fingerprint, and within the batch itself.
- Dry run by default; add `--yes` to append accepted records to `data/imports/<source>/records.jsonl` and rebuild the index. `--no-index` skips the rebuild.

Invalid candidates fail the run (exit 1) and are never written. Duplicates are skipped and reported with the existing record id.

## Verifying against the BigFuture baseline

`npm run phase-a:bigfuture` audits the generated catalog against the raw BigFuture export. A healthy build reports `restorationRecords: 0` — the catalog exactly preserves BigFuture's structured data. Review-queue items cover only inherent source conflicts and fields where the catalog holds richer values than BigFuture published.
