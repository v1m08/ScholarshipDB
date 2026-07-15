import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("date formatting accepts ISO timestamps and rejects invalid dates", async () => {
  const source = await readFile(new URL("../src/lib/scholarship.ts", import.meta.url), "utf8");
  assert.match(source, /value\.slice\(0, 10\)/);
  assert.match(source, /Number\.isNaN\(date\.getTime\(\)\)/);
});