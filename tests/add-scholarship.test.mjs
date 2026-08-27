import assert from "node:assert/strict";
import test from "node:test";

import { buildCandidate, candidateFingerprint, dedupeAgainstCatalog } from "../scripts/add-scholarship.mjs";

function input(overrides = {}) {
  return {
    title: "Example Scholarship",
    provider: "Example Foundation",
    sourceUrl: "https://example.com/scholarship",
    applicationUrl: "https://example.com/apply",
    deadline: "2027-01-15",
    description: "A scholarship for examples.",
    award: { maximum: 2000, varies: false },
    eligibility: { grades: ["high-school-senior"], states: ["Texas"], tags: ["stem"] },
    ...overrides,
  };
}

test("builds a normalized candidate with a deterministic generated id", () => {
  const first = buildCandidate(input(), { source: "manual", today: "2026-08-10" });
  const second = buildCandidate(input(), { source: "manual", today: "2026-08-10" });
  assert.equal(first.record.id, second.record.id);
  assert.match(first.record.id, /^manual-[0-9a-f]{16}$/);
  assert.equal(first.record.sourceName, "Manual Intake");
  assert.equal(first.record.sourceCheckedAt, "2026-08-10");
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.record.eligibility.grades, ["High School Senior"]);
  assert.deepEqual(first.record.eligibility.states, ["TX"]);
});

test("falls back to the source URL when no application URL is provided", () => {
  const candidate = buildCandidate(input({ applicationUrl: undefined }), { source: "manual", today: "2026-08-10" });
  assert.equal(candidate.record.applicationUrl, "https://example.com/scholarship");
  assert.deepEqual(candidate.errors, []);
});

test("reports validation errors for unusable candidates", () => {
  const candidate = buildCandidate(input({ sourceUrl: "not-a-url", applicationUrl: "http://localhost/x" }), {
    source: "manual",
    today: "2026-08-10",
  });
  assert.ok(candidate.errors.includes("invalid_sourceUrl"));
  assert.ok(candidate.errors.includes("invalid_applicationUrl"));
});

test("deduplicates against the catalog by id, url, and fingerprint", () => {
  const existing = buildCandidate(input(), { source: "manual", today: "2026-08-10" }).record;
  const catalog = [existing];
  const byFingerprint = buildCandidate(input({ sourceUrl: "https://elsewhere.com/listing" }), { source: "manual", today: "2026-08-10" });
  const byUrl = buildCandidate(input({ title: "Renamed Award", applicationUrl: "https://other.example/apply" }), { source: "manual", today: "2026-08-10" });
  const fresh = buildCandidate(
    input({ title: "Different Scholarship", sourceUrl: "https://different.example/listing", applicationUrl: "https://different.example/apply" }),
    { source: "manual", today: "2026-08-10" },
  );
  const results = dedupeAgainstCatalog([byFingerprint, byUrl, fresh], catalog);
  assert.deepEqual(results.map((result) => result.status), ["duplicate", "duplicate", "new"]);
  assert.equal(results[0].existingId, existing.id);
});

test("deduplicates repeated candidates inside one batch", () => {
  const first = buildCandidate(input(), { source: "manual", today: "2026-08-10" });
  const second = buildCandidate(input({ sourceUrl: "https://mirror.example/listing" }), { source: "manual", today: "2026-08-10" });
  assert.equal(candidateFingerprint(first.record), candidateFingerprint(second.record));
  const results = dedupeAgainstCatalog([first, second], []);
  assert.deepEqual(results.map((result) => result.status), ["new", "duplicate"]);
});
