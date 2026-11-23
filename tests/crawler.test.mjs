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

test("an award page yields labelled fields, requirements and class years", async () => {
  const { parseAwardPage, parseAward } = await import("../crawler/lib/academicworks.mjs");
  const { awardRecord } = await import("../crawler/lib/award-record.mjs");
  const html = `<section class="main_content js-opportunity"><header class="section-header main"><h3>Smith Nursing Award</h3>
    <p><ul><li>For a full-time undergraduate student majoring in nursing with junior or senior standing and at least a 3.0 GPA.</li>
    <li>See www.example.org/award for details.</li></ul></p></header>
    <div><dl><dt>Donor</dt><dd><a href="/donors/x">Smith Family</a></dd></dl><dl><dt>Award</dt><dd>$500 - $2,500</dd></dl>
    <dl><dt>Deadline</dt><dd>02/01/2027</dd></dl>
    <dl><dt>Supplemental Questions</dt><dd><ol><li class=" js-question">Please submit an essay on your goals.</li><li class=" js-question">List two people for letters of recommendation.</li></ol></dd></dl></div></section><footer>`;
  const page = parseAwardPage(html);
  assert.equal(page.name, "Smith Nursing Award");
  assert.equal(page.donor, "Smith Family");
  assert.equal(page.deadline, "2027-02-01");
  assert.equal(page.questions.length, 2);
  assert.deepEqual(page.links, ["https://www.example.org/award"]);
  assert.deepEqual(parseAward("Varies"), { min: null, max: null });
  const record = awardRecord(page, { url: "https://x.academicworks.com/opportunities/1", portalName: "X College", today: "2026-11-23" });
  assert.equal(record.status, "open");
  assert.equal(record.restrictedTo, "X College");
  const m = record.metadata;
  assert.equal(m.awardMaximum.value, 2500);
  assert.equal(m.awardMinimum.value, 500);
  assert.equal(m.essay.value, true);
  assert.equal(m.recommendations.value, true);
  assert.equal(m.interview.value, false);
  assert.equal(m.minimumGpa.value, 3);
  assert.equal(m.enrollment.value, "full-time");
  assert.deepEqual(m.gradeLevels.value, ["college-junior", "college-senior"]);
  assert.deepEqual(m.fieldsOfStudy.value, ["nursing"]);
  assert.equal(parseAwardPage("<html>sign in</html>"), null);
});

test("robots rules: longest match wins and our own group overrides the general one", async () => {
  const { parseRobots } = await import("../crawler/lib/robots.mjs");
  const all = parseRobots("User-agent: *\nDisallow: /search\nDisallow: /private/\nAllow: /private/open\nCrawl-delay: 5\n\nUser-agent: OtherBot\nDisallow: /");
  assert.equal(all.allowed("/scholarships/abc"), true);
  assert.equal(all.allowed("/search?q=1"), false);
  assert.equal(all.allowed("/private/open/page"), true);
  assert.equal(all.crawlDelay, 5);
  assert.equal(parseRobots("User-agent: *\nDisallow: /").allowed("/anything"), false);
  assert.equal(parseRobots("User-agent: *\nDisallow:").allowed("/anything"), true);
  assert.equal(parseRobots("User-agent: *\nAllow: /\n\nUser-agent: scholarship-directory-bot\nDisallow: /").allowed("/x"), false);
});

test("listing-site leads keep provider addresses and drop links back to listing sites", async () => {
  const { LISTING_SITES, tidyLeads } = await import("../crawler/lib/listing-sites.mjs");
  const site = (id) => LISTING_SITES.find((entry) => entry.id === id);
  const bigfuture = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data: { scholarshipName: "A Award", programOrgName: "A Org", programUrl: "https://a.org/award" } } } })}</script>`;
  assert.deepEqual(tidyLeads(site("bigfuture").leads(bigfuture)), [{ name: "A Award", provider: "A Org", url: "https://a.org/award" }]);
  const jlv = `<strong><a href="https://b.org/s">B Scholarship</a></strong><br /><strong>Sponsor</strong>: B Fund<br /><strong><a href="https://bold.org/scholarships/x/">Bold One</a></strong><br /><strong>Sponsor</strong>: Bold.org<a href="https://jlvcollegecounseling.com/2026/11/"><strong>November</strong></a>`;
  assert.deepEqual(tidyLeads(site("jlv").leads(jlv)), [{ name: "B Scholarship", provider: "B Fund", url: "https://b.org/s" }, { name: "Bold One", provider: "Bold.org", url: null }]);
  for (const entry of LISTING_SITES) assert.ok(entry.page.test(entry.sitemap) === false && entry.gapMs >= 700, entry.id);
});

test("two scholarships sharing one provider page stay separate entries", async () => {
  const { mergeLinks } = await import("../crawler/lib/links.mjs");
  const first = mergeLinks([], [
    { url: "https://fund.org/scholarships", name: "Alpha Award", sharedPage: true, foundVia: ["bigfuture"] },
    { url: "https://fund.org/scholarships/", name: "Beta Award", sharedPage: true, foundVia: ["bigfuture"] },
    { url: "https://www.fund.org/scholarships", name: "Alpha Award", sharedPage: true, foundVia: ["sallie"] },
  ]);
  assert.equal(first.length, 2);
  assert.deepEqual(first.find((entry) => entry.name === "Alpha Award").foundVia, ["bigfuture", "sallie"]);
  assert.equal(mergeLinks(first, []).length, 2);
});
