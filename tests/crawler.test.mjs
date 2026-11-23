import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseListingPage } from "../crawler/lib/academicworks.mjs";
import { pageTitle, visibleText } from "../crawler/lib/fetcher.mjs";
import { candidateSlugs } from "../scripts/portal-scan.mjs";

test("candidate portal names come from the institution's own domain", () => {
  assert.deepEqual(candidateSlugs("ucsd.edu"), ["ucsd"]);
  assert.deepEqual(candidateSlugs("cc.peralta.edu"), ["peralta"]);
  assert.deepEqual(candidateSlugs("admissions.alamo.edu"), ["alamo", "admissions"]);
  assert.deepEqual(candidateSlugs(null), []);
});

test("visible text drops scripts, styles and tags", () => {
  const html = "<html><head><title> A &amp; B </title><style>p{}</style></head><body><script>x()</script><p>Hello&nbsp;<b>world</b></p></body></html>";
  assert.equal(visibleText(html), "A & B Hello world");
  assert.equal(pageTitle(html), "A & B");
});

test("AcademicWorks listing rows yield amount, title, link and status", () => {
  const html = `<table><tbody>
    <tr><td class="strong"> $1,000 </td><th scope="row"><a href="/opportunities/3989">John M. Holleran Fund</a></th><td class="center"> Ended </td></tr>
    <tr><td> up to $2500 </td><th><a href="/opportunities/6054">Essay &amp; Art Contest</a></th><td> Deadline 12/01/2026 </td></tr>
    <tr><td>no link here</td></tr></tbody></table>`;
  assert.deepEqual(parseListingPage(html, "ucsd.academicworks.com"), [
    { host: "ucsd.academicworks.com", url: "https://ucsd.academicworks.com/opportunities/3989", title: "John M. Holleran Fund", amountText: "$1,000", statusText: "Ended" },
    { host: "ucsd.academicworks.com", url: "https://ucsd.academicworks.com/opportunities/6054", title: "Essay & Art Contest", amountText: "up to $2500", statusText: "Deadline 12/01/2026" },
  ]);
});

test("gold set uses only allowed values and has no unlabeled cells", async () => {
  const gold = JSON.parse(await readFile(new URL("../data/gold/gold-set.json", import.meta.url), "utf8"));
  const allowed = gold.allowed;
  assert.equal(gold.records.length, 20);
  assert.ok(!JSON.stringify(gold.records).includes('"TODO"'));
  for (const record of gold.records) {
    for (const grade of record.eligibility.gradeLevels) assert.ok(allowed["eligibility.gradeLevels"].includes(grade), `${record.id} ${grade}`);
    for (const status of record.eligibility.citizenship || []) assert.ok(allowed["eligibility.citizenship"].includes(status), `${record.id} ${status}`);
    for (const group of ["identity", "field", "basis"]) {
      for (const [tag, strength] of Object.entries(record.tags[group])) {
        assert.ok(allowed[`tags.${group}`].includes(tag), `${record.id} ${tag}`);
        assert.ok(["required", "preferred"].includes(strength));
      }
    }
    for (const key of ["essay", "recommendations", "nomination", "interview", "fee"]) assert.equal(typeof record.application[key], "boolean");
    assert.equal(typeof record.award.renewable, "boolean");
  }
});
