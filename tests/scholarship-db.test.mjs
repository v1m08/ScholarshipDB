import assert from "node:assert/strict";
import test from "node:test";
import { applyAssignment, buildSearchText } from "../scripts/scholarship-db.mjs";

test("scholarship DB updates parse nested values without allowing prototype paths", () => {
  const record = {
    title: "Example",
    provider: "Provider",
    description: "Description",
    deadline: null,
    eligibility: { countries: [], minimumGpa: null, other: [] },
  };
  assert.equal(applyAssignment(record, "deadline=2026-11-11"), "deadline");
  applyAssignment(record, "eligibility.countries=US");
  applyAssignment(record, "eligibility.minimumGpa=3.75");
  applyAssignment(record, "eligibility.other=One|Two");
  assert.equal(record.deadline, "2026-11-11");
  assert.deepEqual(record.eligibility.countries, ["US"]);
  assert.equal(record.eligibility.minimumGpa, 3.75);
  assert.deepEqual(record.eligibility.other, ["One", "Two"]);
  assert.match(buildSearchText(record), /provider.*description.*us.*one.*two/);
  assert.throws(() => applyAssignment(record, "eligibility.__proto__.polluted=true"), /not editable/);
});
