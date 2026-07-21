import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { duplicateKey, parseOptions, planDuplicatePrune } from "../scripts/prune-supabase-duplicates.mjs";

const base = {
  provider: "Jack Kent Cooke Foundation",
  source_checked_at: "2026-06-05",
  description: "",
  award: { maximum: null },
  requirements: { essay: null, needBased: null, meritBased: null, fee: null },
  eligibility: { grades: [], degreeLevels: [], minimumGpa: null },
  vetting: { status: "unvetted" },
  publication_status: "published",
  updated_at: "2026-07-15T00:00:00Z",
  source_urls: [],
};

test("provider words and generic title words collapse source variants", () => {
  const bigFuture = { ...base, title: "Jack Kent Cooke College Scholarship Program" };
  const careerOneStop = { ...base, title: "Jack Kent Cooke Foundation College Scholarship Program" };
  assert.equal(duplicateKey(bigFuture), duplicateKey(careerOneStop));
});

test("the more complete direct-application record survives", () => {
  const bigFuture = {
    ...base,
    id: "bigfuture-jkc",
    title: "Jack Kent Cooke College Scholarship Program",
    source_name: "BigFuture Scholarship Search",
    source_url: "https://bigfuture.example/jkc",
    source_urls: ["https://bigfuture.example/jkc"],
    application_url: "https://apply.commonapp.org/jkc",
    deadline: "2025-11-12",
    description: "A sufficiently detailed description of the scholarship and its eligibility requirements for applicants.",
    requirements: { essay: true, needBased: true, meritBased: true, fee: false },
    eligibility: { grades: ["High School Senior"], degreeLevels: ["Bachelor's Degree"], minimumGpa: 3.75 },
  };
  const careerOneStop = {
    ...base,
    id: "careeronestop-jkc",
    title: "Jack Kent Cooke Foundation College Scholarship Program",
    source_name: "CareerOneStop Scholarship Finder",
    source_url: "https://careeronestop.example/jkc",
    application_url: "https://careeronestop.example/jkc",
    deadline: null,
  };
  const { plans } = planDuplicatePrune([careerOneStop, bigFuture], {
    title: bigFuture.title,
    today: "2026-07-16",
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].survivor.id, "bigfuture-jkc");
  assert.deepEqual(plans[0].duplicates.map((row) => row.id), ["careeronestop-jkc"]);
  assert.deepEqual(plans[0].sourceUrls, ["https://bigfuture.example/jkc", "https://careeronestop.example/jkc"]);
});

test("multiple human-vetted rows are never deleted automatically", () => {
  const rows = ["one", "two"].map((id) => ({
    ...base,
    id,
    title: "Example College Scholarship",
    provider: "Example Foundation",
    source_name: id,
    source_url: `https://${id}.example/source`,
    application_url: `https://${id}.example/apply`,
    deadline: "2027-01-01",
    vetting: { status: "human" },
  }));
  const result = planDuplicatePrune(rows, { today: "2026-07-16" });
  assert.equal(result.plans.length, 0);
  assert.equal(result.skipped.length, 1);
});

test("full database deletion requires an explicit all flag", () => {
  assert.throws(() => parseOptions(["--yes"]), /--all/);
  assert.deepEqual(parseOptions(["--all", "--yes"]), { title: null, keep: null, yes: true, all: true });
});

test("the prune RPC is service-role-only and preserves dependent submissions", async () => {
  const migration = await readFile("supabase/migrations/20260716200000_prune_scholarship_duplicates.sql", "utf8");
  assert.match(migration, /auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /revoke all on function .* from public, anon, authenticated/s);
  assert.match(migration, /grant execute on function .* to service_role/s);
  assert.match(migration, /update public\.scholarship_reports[\s\S]+delete from public\.scholarships/);
  assert.match(migration, /update public\.scholarship_contributions[\s\S]+delete from public\.scholarships/);
});
