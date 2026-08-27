import assert from "node:assert/strict";
import test from "node:test";
import { sourceCoverage } from "../scripts/pipeline-status.mjs";

test("counts stage coverage per source", () => {
  const coverage = sourceCoverage([
    {
      sourceName: "A", deadline: "2026-12-01", award: { maximum: 1000 },
      eligibility: { tags: ["stem"] }, taggedAt: "2026-06-01", enrichedAt: "2026-06-02",
      vetting: { status: "approved" },
    },
    { sourceName: "A", award: { maximum: null }, eligibility: { tags: [] } },
    { sourceName: "B", deadline: "2027-01-01", award: {}, eligibility: { tags: ["women"] } },
  ]);
  assert.deepEqual(coverage.get("A"), {
    records: 2, tagged: 1, tagOverlay: 1, enriched: 1, vetted: 1, deadline: 1, award: 1,
  });
  assert.deepEqual(coverage.get("B"), {
    records: 1, tagged: 1, tagOverlay: 0, enriched: 0, vetted: 0, deadline: 1, award: 0,
  });
});
