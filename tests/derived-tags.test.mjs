import assert from "node:assert/strict";
import test from "node:test";
import { deriveStructuralTags } from "../scripts/lib/derived-tags.mjs";

test("derives tags only from definite structured observations", () => {
  assert.deepEqual(
    deriveStructuralTags({ requirements: { essay: false, needBased: true, meritBased: true } }),
    ["no-essay", "financial-need", "merit-based"],
  );
});

test("unknown or negative observations derive nothing", () => {
  assert.deepEqual(deriveStructuralTags({ requirements: { essay: null, needBased: null, meritBased: null } }), []);
  assert.deepEqual(deriveStructuralTags({ requirements: { essay: true, needBased: false, meritBased: false } }), []);
  assert.deepEqual(deriveStructuralTags({}), []);
});
