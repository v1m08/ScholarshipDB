import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeRecord } from "../scripts/lib/normalize-record.mjs";

const taxonomy = JSON.parse(
  await readFile(new URL("../data/taxonomy/scholarship-taxonomy.json", import.meta.url), "utf8"),
);

test("canonical taxonomy has unique valid ids and categories", () => {
  const categories = new Set(taxonomy.categories.map((category) => category.id));
  const ids = taxonomy.tags.map((tag) => tag.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const tag of taxonomy.tags) {
    assert.match(tag.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(categories.has(tag.category), `${tag.id} has an unknown category`);
    assert.ok(tag.definition);
    assert.ok(tag.positiveTerms.length);
  }
});

test("legacy aliases normalize to current canonical tags", () => {
  const normalized = normalizeRecord({
    title: "Alias test",
    provider: "Test",
    eligibility: {
      grades: [],
      states: [],
      countries: [],
      tags: ["veteran", "cancer-survivor", "future-teachers", "engineering"],
    },
    institutionTypes: [],
  });
  assert.deepEqual(normalized.eligibility.tags, [
    "veteran",
    "cancer-affected",
    "education",
    "engineering",
  ]);
});
