import assert from "node:assert/strict";
import test from "node:test";
import { EXCLUDED_RECORDS } from "../scripts/lib/excluded-records.mjs";

test("every exclusion names a record id and a human-readable reason", () => {
  assert.ok(EXCLUDED_RECORDS.size > 0);
  for (const [id, reason] of EXCLUDED_RECORDS) {
    assert.match(id, /^[a-z0-9-]+-[0-9a-f]{16}$/);
    assert.ok(typeof reason === "string" && reason.length >= 10, `${id} needs a reason`);
  }
});

test("exclusions never touch the immutable BigFuture baseline", () => {
  for (const id of EXCLUDED_RECORDS.keys()) {
    assert.ok(!id.startsWith("bigfuture-"), `${id} would break the BigFuture baseline`);
  }
});
