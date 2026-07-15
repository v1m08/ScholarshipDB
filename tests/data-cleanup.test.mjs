import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeGrades } from "../scripts/lib/normalize-record.mjs";

test("K-8 and overlapping ranges normalize to canonical grades", () => {
  assert.deepEqual(normalizeGrades("K-8"), [
    "Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4",
    "Grade 5", "Grade 6", "Grade 7", "Grade 8",
  ]);
  assert.deepEqual(normalizeGrades("7-12"), [
    "Grade 7", "Grade 8", "High School Freshman", "High School Sophomore",
    "High School Junior", "High School Senior",
  ]);
});

test("duplicate grade spellings collapse", () => {
  assert.deepEqual(normalizeGrades("10"), ["High School Sophomore"]);
  assert.deepEqual(normalizeGrades("10th Grade"), ["High School Sophomore"]);
  assert.deepEqual(normalizeGrades("Grade 1"), ["Grade 1"]);
  assert.deepEqual(normalizeGrades("Ph.D."), ["Doctoral Student"]);
  assert.deepEqual(normalizeGrades("Doctoral Student"), ["Doctoral Student"]);
  assert.deepEqual(normalizeGrades("Vocational or Trade Student"), ["Vocational or Trade Student"]);
});

test("indexing owns legacy cleanup without a generated cleanup overlay", async () => {
  const indexer = await readFile(new URL("../scripts/build-index.mjs", import.meta.url), "utf8");
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotMatch(indexer, /data.+cleanup|cleanupPath|applyCleanup/);
  assert.doesNotMatch(packageJson, /data:cleanup/);
  assert.match(indexer, /legacy imports used false/);
});
