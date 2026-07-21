import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("directory summary stays small and contains only listing fields", async () => {
  const summary = JSON.parse(await readFile(new URL("../src/generated/directory-summary.json", import.meta.url), "utf8"));
  assert.ok(summary.records.length <= 30);
  assert.ok(summary.records.length > 0);
  assert.deepEqual(Object.keys(summary.records[0]).sort(), [
    "award", "deadline", "description", "eligibility", "id", "institutionName", "institutionSpecific", "provider", "requirements", "title", "vetting",
  ]);
  assert.ok(summary.records.every((record) => record.description.length <= 240));
});
