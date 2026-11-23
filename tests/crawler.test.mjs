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
    { host: "ucsd.academicworks.com", url: "https://ucsd.academicworks.com/opportunities/3989", title: "John M. Holleran Fund", amountText: "$1,000", statusText: "Ended", snippet: null },
    { host: "ucsd.academicworks.com", url: "https://ucsd.academicworks.com/opportunities/6054", title: "Essay & Art Contest", amountText: "up to $2500", statusText: "Deadline 12/01/2026", snippet: null },
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

test("AcademicWorks listing rows give title, amount, status and snippet", async () => {
  const { parseListingPage } = await import("../crawler/lib/academicworks.mjs");
  const html = `<table><tbody><tr> <td class="strong h4"> $250-6000 </td> <th scope="row"> <span class="block strong h4" > <a href="/opportunities/6128">The Epilepsy Foundation &amp; Friends</a> </span> <div class="mq-no-bp-only"> Provides scholarships... </div> </th> <td class="center" width=100> Ended </td> </tr></tbody></table>`;
  const rows = parseListingPage(html, "x.academicworks.com");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { host: "x.academicworks.com", url: "https://x.academicworks.com/opportunities/6128", title: "The Epilepsy Foundation & Friends", amountText: "$250-6000", statusText: "Ended", snippet: "Provides scholarships..." });
});

test("a portal walk stops when a page repeats and stops at a sign-in wall", async () => {
  const { collectPortal } = await import("../crawler/lib/academicworks.mjs");
  const row = (id) => `<tr><td>$1</td><th><span><a href="/opportunities/${id}">Award ${id}</a></span></th><td>Ended</td></tr>`;
  const pages = { "/opportunities": row(1) + row(2), "/opportunities?page=2": row(3), "/opportunities?page=3": row(3), "/opportunities/external": row(9), "/opportunities/external?page=2": row(9) };
  const get = async (url) => ({ status: 200, finalUrl: url, html: pages[url.replace("https://x.academicworks.com", "")] || "" });
  const result = await collectPortal("x.academicworks.com", get);
  assert.equal(result.awards.length, 4);
  assert.equal(result.awards.filter((award) => award.external).length, 1);
  const walled = await collectPortal("x.academicworks.com", async () => ({ status: 200, finalUrl: "https://x.academicworks.com/users/sign_in", html: "" }));
  assert.deepEqual(walled, { signIn: true, pages: 0, awards: [] });
});

test("links from several sources merge into one entry and keep progress", async () => {
  const { mergeLinks } = await import("../crawler/lib/links.mjs");
  const first = mergeLinks([], [
    { url: "https://www.example.org/award/", name: "Example Award", provider: "Example Org", foundVia: ["portal"] },
    { url: "https://example.org/award?utm_source=mail", foundVia: ["newsletter"] },
    { name: "Lead Award", provider: "Lead Org", foundVia: ["bigfuture"] },
  ]);
  assert.equal(first.length, 2);
  const merged = first.find((entry) => entry.url);
  assert.deepEqual(merged.foundVia, ["portal", "newsletter"]);
  assert.equal(merged.url, "https://www.example.org/award/");
  assert.equal(first.find((entry) => !entry.url).status, "needs-url");
  merged.status = "scraped";
  const second = mergeLinks(first, [
    { url: "https://example.org/award", foundVia: ["portal"] },
    { url: "https://lead.org/apply", name: "Lead Award", provider: "Lead Org", foundVia: ["search"] },
  ]);
  assert.equal(second.length, 2);
  assert.equal(second.find((entry) => entry.id === "https://example.org/award").status, "scraped");
  const lead = second.find((entry) => entry.name === "Lead Award");
  assert.equal(lead.status, "not-scraped");
  assert.deepEqual(lead.foundVia, ["bigfuture", "search"]);
});
