import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFieldDecisions,
  canonicalizeBigFutureGroup,
  findConflictingFields,
  scholarshipFingerprint,
  validateBigFutureRecord,
} from "../scripts/knowledge/phase-a-bigfuture.mjs";

function record(overrides = {}) {
  return {
    sourceName: "BigFuture Scholarship Search",
    sourceUrl: "https://bigfuture.collegeboard.org/scholarships/example",
    sourceCheckedAt: "2026-05-25",
    applicationUrl: "https://example.org/apply",
    opens: null,
    deadline: "2026-12-01",
    description: "Example scholarship",
    award: { maximum: 1_000, varies: false },
    requirements: { essay: true, needBased: false, meritBased: true, fee: null },
    eligibility: {
      countries: ["US"], states: [], grades: ["12"], degreeLevels: ["Bachelor's Degree"],
      fields: [], minimumGpa: 3, minimumAge: null, citizenship: [], tags: ["merit-based"], other: [],
    },
    id: "bigfuture-example",
    title: "Example",
    provider: "Example Foundation",
    ...overrides,
  };
}

test("validates the structured BigFuture contract and source host", () => {
  assert.deepEqual(validateBigFutureRecord(record()), []);
  const issues = validateBigFutureRecord(record({ sourceUrl: "https://example.com/not-bigfuture" }));
  assert.equal(issues.some((issue) => issue.field === "sourceUrl"), true);
});

test("canonicalizes exact duplicate fingerprints without losing source URLs", () => {
  const first = record();
  const second = record({ id: "bigfuture-duplicate", sourceUrl: "https://bigfuture.collegeboard.org/scholarships/example-copy" });
  assert.equal(scholarshipFingerprint(first), scholarshipFingerprint(second));
  const canonical = canonicalizeBigFutureGroup([first, second]);
  assert.equal(canonical.id, first.id);
  assert.deepEqual(canonical.sourceUrls, [first.sourceUrl, second.sourceUrl]);
  assert.deepEqual(canonical.eligibility.grades, ["High School Senior"]);
  assert.deepEqual(findConflictingFields([first, second]), []);
  assert.deepEqual(findConflictingFields([first, { ...second, deadline: "2027-01-01" }]), ["deadline"]);
});

test("restores supported BigFuture fields but never erases a current value", () => {
  const source = record({ description: "Trusted source text", applicationUrl: null });
  const current = record({ description: "Polluted text", applicationUrl: "https://current.example/apply" });
  const decisions = buildFieldDecisions(source, current);
  assert.deepEqual(decisions.changes.map((item) => item.fieldName), ["description"]);
  assert.deepEqual(decisions.retainedCurrentFields.map((item) => item.fieldName), ["applicationUrl"]);
  assert.equal(decisions.changes[0].chosenReason, "bigfuture_structured_source_priority");
});
