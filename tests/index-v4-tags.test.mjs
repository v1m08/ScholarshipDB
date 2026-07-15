import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertV4TagShape, normalizeRecord } from "../scripts/lib/normalize-record.mjs";

const taxonomyV4 = JSON.parse(
  await readFile(new URL("../data/taxonomy/scholarship-taxonomy-v4.json", import.meta.url), "utf8"),
);
const allowedV4Tags = new Set(taxonomyV4.tags.map((tag) => tag.id));

test("v4 generated tags keep frontend aliases in lockstep", () => {
  const frontendTags = ["engineering", "veteran"];
  const record = normalizeRecord({
    id: "v4-test",
    title: "Engineering Veteran Scholarship",
    provider: "Test",
    tags: frontendTags,
    eligibility: {
      grades: [],
      states: [],
      countries: [],
      tags: frontendTags,
    },
    classification: {
      backendTags: ["engineering", "stem", "veteran"],
      frontendTags,
      assignments: [],
    },
    institutionTypes: [],
  });
  assertV4TagShape(record, allowedV4Tags);
  assert.ok(record.classification.frontendTags.includes("engineering"));
  assert.ok(record.eligibility.tags.includes("engineering"));
  assert.ok(record.tags.includes("engineering"));
  assert.ok(record.classification.frontendTags.includes("veteran"));
  assert.ok(!record.tags.includes("veteran-military"));
  assert.deepEqual(record.tags, record.eligibility.tags);
});

test("generated v4 catalog records have one frontend tag shape", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../src/generated/catalog.json", import.meta.url), "utf8"),
  );
  for (const record of catalog.filter((item) => item.classification)) {
    assertV4TagShape(record, allowedV4Tags);
  }
});

test("generated catalog records keep explicit enrichment provenance", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../src/generated/catalog.json", import.meta.url), "utf8"),
  );
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every((record) => record.enrichmentQuality?.pipelineVersion === 1));
  assert.ok(catalog.every((record) => record.enrichmentQuality?.taxonomyVersion === taxonomyV4.version));
  const acceptedMethods = new Set(["deterministic-prefill", "enrichment-v4"]);
  assert.ok(catalog.every((record) => acceptedMethods.has(record.vetting?.method)));
  assert.ok(
    catalog.every((record) =>
      record.vetting?.method === "deterministic-prefill"
        ? record.vetting?.status === "unvetted"
        : record.vetting?.status === "ai",
    ),
  );
});
