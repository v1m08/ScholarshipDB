import assert from "node:assert/strict";
import test from "node:test";
import { prepareCandidate } from "../scripts/lib/candidate-pipeline.mjs";

function record(overrides = {}) {
  return {
    id: "source-1",
    title: "Example Scholarship",
    provider: "Example Foundation",
    sourceName: "Example Source",
    sourceUrl: "https://example.com/source",
    sourceCheckedAt: "2026-06-07",
    applicationUrl: "https://example.com/apply",
    opens: null,
    deadline: "2026-12-01",
    description: "A scholarship.",
    award: { maximum: 1000, varies: false },
    requirements: { essay: null, needBased: null, meritBased: null, fee: null },
    eligibility: {
      countries: ["United States"],
      states: ["Colorado"],
      grades: ["12th Grade"],
      degreeLevels: ["Bachelor's Degree"],
      fields: [],
      minimumGpa: null,
      minimumAge: null,
      citizenship: [],
      tags: ["veteran"],
      other: [],
    },
    institutionTypes: [],
    ...overrides,
  };
}

test("candidate preparation centralizes country, state, grade, and tag normalization", () => {
  const prepared = prepareCandidate(record());
  assert.deepEqual(prepared.errors, []);
  assert.deepEqual(prepared.candidateData.eligibility.countries, ["US"]);
  assert.deepEqual(prepared.candidateData.eligibility.states, ["CO"]);
  assert.deepEqual(prepared.candidateData.eligibility.grades, ["High School Senior"]);
  assert.deepEqual(prepared.candidateData.eligibility.tags, ["veteran"]);
  assert.ok(prepared.qualityFlags.includes("human_review_required"));
});

test("candidate preparation rejects unsafe URLs", () => {
  const prepared = prepareCandidate(record({ applicationUrl: "javascript:alert(1)" }));
  assert.ok(prepared.errors.includes("invalid_applicationUrl"));
  const local = prepareCandidate(record({ applicationUrl: "http://127.0.0.1/admin" }));
  assert.ok(local.errors.includes("invalid_applicationUrl"));
});

test("candidate fingerprints are deterministic", () => {
  const first = prepareCandidate(record());
  const second = prepareCandidate(record());
  assert.equal(first.normalizedFingerprint, second.normalizedFingerprint);
});
