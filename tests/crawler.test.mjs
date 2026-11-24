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

test("a school page yields named scholarships and not section headings", async () => {
  const { scholarshipsOn, scholarshipLinks } = await import("../crawler/lib/school-pages.mjs");
  const lines = [
    "# Scholarships for Transfer Students",
    "We offer several awards to students who transfer in with strong records and good standing.",
    "# Dean's Merit Scholarship",
    "Awarded to transfer students with a minimum 3.5 GPA. The award is $5,000 per year and is renewable.",
    "Stamps Eminence Scholarship Program",
    "Covers the full cost of attendance for eight semesters of full-time enrollment for selected students.",
    "# How do I apply for scholarships?",
    "Submit the admission application by November 1 to be considered for every merit scholarship listed.",
    "- Founders Grant: Given each year to an entering student from the county who shows financial need and promise.",
  ];
  const found = scholarshipsOn(lines, "https://x.edu/aid/scholarships");
  assert.deepEqual(found.map((item) => item.name), ["Dean's Merit Scholarship", "Stamps Eminence Scholarship Program", "Founders Grant"]);
  assert.equal(found[0].metadata.minimumGpa.value, 3.5);
  assert.equal(found[0].metadata.awardMaximum.value, 5000);
  const html = `<a href="/aid/scholarships/merit">Merit scholarships</a><a href="/news/scholarship-story">Story</a><a href="https://other.org/scholarships">Other</a><a href="https://x.academicworks.com/opportunities">Apply</a><a href="https://admissions.x.edu/scholarships">More</a>`;
  const links = scholarshipLinks(html, "https://www.x.edu/aid", "x.edu");
  assert.deepEqual(links.pages.map((link) => link.url), ["https://www.x.edu/aid/scholarships/merit", "https://admissions.x.edu/scholarships"]);
  assert.deepEqual(links.portals, ["https://x.academicworks.com/"]);
});

test("a foundation's scholarship page joins labels to values and stops at the FAQ", async () => {
  const { labelled, scholarshipPage, scholarshipsOn, scholarshipLinks } = await import("../crawler/lib/school-pages.mjs");
  assert.deepEqual(labelled(["$1000", "Scholarship Value", "January 14", "Application Deadline", "Areas of Study:", "Any"], new Date("2026-11-23")),
    ["Scholarship Value: $1000", "Application Deadline: January 14, 2027 (year assumed)", "Areas of Study: Any"]);
  const lines = ["- Home", "# Tilghman, Linda Healthcare Scholarship", "Available to high school seniors who are attending the Primary Healthcare Program.", "$1000", "Scholarship Value",
    "Applicants must have a minimum cumulative GPA of 2.50.", "# Frequently Asked Questions", "Finalists will be interviewed by the committee before the general awards are made."];
  const page = scholarshipPage(lines, "https://cf.org/scholarship/tilghman-linda-healthcare-scholarship/");
  assert.equal(page.name, "Tilghman, Linda Healthcare Scholarship");
  assert.equal(page.metadata.awardMaximum.value, 1000);
  assert.equal(page.metadata.minimumGpa.value, 2.5);
  assert.equal(page.metadata.hasLaterRounds.value, false);
  assert.equal(scholarshipPage(lines, "https://cf.org/students/"), null);
  // A page that only lists names keeps them as names.
  const list = scholarshipsOn(["Scholarship Funds", "Ann Edwards Memorial Scholarship Fund", "David Yarid Scholarship Fund"], "https://cf.org/scholarship-funds/");
  assert.deepEqual(list.map((item) => [item.name, item.nameOnly]), [["Ann Edwards Memorial Scholarship Fund", true], ["David Yarid Scholarship Fund", true]]);
  const links = scholarshipLinks(`<a href="/scholarships/blackburn?filter=1">Janet M. Blackburn Scholarship</a><a href="/scholarships/">Go to Scholarship Applicant Section</a><a href="https://www.grantinterface.com/Home/Logon?urlkey=cf">Apply</a>`, "https://cf.org/scholarships/", "cf.org");
  assert.deepEqual(links.named, [{ name: "Janet M. Blackburn Scholarship", url: "https://cf.org/scholarships/blackburn" }]);
  assert.deepEqual(links.portals, ["https://www.grantinterface.com/"]);
});

test("names listed in a row do not take the text that follows the list", async () => {
  const { scholarshipsOn } = await import("../crawler/lib/school-pages.mjs");
  const found = scholarshipsOn(["Valero Scholarship", "Whataburger Family Foundation Scholarship Fund", "Complete this application to be considered. Open: December 1, 2022. Deadline: February 24, 2023. Minimum GPA of 2.5."], "https://f.org/apply");
  assert.deepEqual(found.map((item) => [item.name, item.nameOnly, item.metadata]), [["Valero Scholarship", true, null], ["Whataburger Family Foundation Scholarship Fund", true, null]]);
});

test("names sharing one address are each found where the page describes them", async () => {
  const { findNamed, linkNames } = await import("../crawler/lib/named-reader.mjs");
  const leads = [
    { name: "Acme College Jane Doe Memorial Scholarship", provider: "Acme College" },
    { name: "Robert Smith Engineering Award", provider: "Acme College" },
    { name: "Acme College Athletic Scholarships", provider: "Acme College" },
    { name: "Lee Family Nursing Scholarship", provider: "Acme College" },
  ];
  const pages = [
    { url: "https://acme.edu/scholarships", lines: [
      "# Scholarships at Acme College",
      "We offer many awards to our students every year across all of our programs.",
      "# Jane Doe Memorial Scholarship",
      "Awarded to a full-time student with a minimum 3.0 GPA who demonstrates financial need. The award is $2,500.",
      "- Robert Smith Engineering Award: A $1,000 award for engineering majors with a minimum GPA of 3.5 who are enrolled full-time.",
      "- Lee Family Nursing Scholarship",
      "- Another Fund Entirely",
    ] },
  ];
  const [jane, robert, athletic, lee] = findNamed(leads, pages);
  assert.equal(jane.how, "section");
  assert.equal(jane.metadata.minimumGpa.value, 3);
  assert.equal(robert.metadata.minimumGpa.value, 3.5);
  assert.equal(athletic.found, false);
  assert.equal(lee.how, "listed");
  assert.equal(lee.metadata, null);
  const wanted = linkNames(leads);
  assert.equal(wanted("Jane Doe Memorial Scholarship"), true);
  assert.equal(wanted("Scholarships at Acme College"), false);
});

test("only values that pass the database's rules reach a clean row", async () => {
  const { cleanRecord, acceptedFields } = await import("../database/clean-record.mjs");
  const knownFields = acceptedFields(new Map([["nursing", 300], ["following spc", 40], ["rare subject", 2]]));
  assert.deepEqual([...knownFields], ["nursing"]);
  const context = { scope: "school", source: "school-portal", providerName: "Acme College", schoolUnitid: 123456, knownFields };
  const metadata = {
    awardMaximum: { value: 250000, evidence: "worth $250,000" },
    awardMinimum: { value: 500, evidence: "from $500" },
    deadline: { value: "2027-03-01", evidence: "Deadline 03/01/2027" },
    opens: { value: "2027-06-01", evidence: "opens June 1" },
    minimumGpa: { value: 35, evidence: "35 GPA" },
    gradeLevels: { value: ["college-junior", "made-up", "grade-12"], evidence: "juniors" },
    fieldsOfStudy: { value: ["Nursing", "following spc"], evidence: "nursing majors" },
    citizenship: { value: ["any"], evidence: "open to all" },
    need: { value: "required", evidence: "must show need" },
    merit: { value: "no", evidence: null, assumed: true },
    essay: { value: true, evidence: "Question: write an essay" },
    fee: { value: false, evidence: null, assumed: true },
    tags: { leadership: "shows leadership", bogus: "x" },
  };
  const { row, evidence } = cleanRecord({ url: "https://acme.academicworks.com/opportunities/1", name: "  JANE DOE MEMORIAL SCHOLARSHIP ", metadata, checkedAt: "2026-11-23T00:00:00Z" }, context);
  assert.equal(row.name, "Jane Doe Memorial Scholarship");
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.equal(row.award_max, null); // over the limit: left out, not guessed
  assert.equal(row.award_min, 500);
  assert.equal(row.minimum_gpa, null);
  assert.equal(row.opens, null); // after the deadline
  assert.deepEqual(row.grade_levels, ["grade-12", "college-junior"]);
  assert.deepEqual(row.fields_of_study, ["nursing"]);
  assert.deepEqual(row.citizenship, []);
  assert.deepEqual(row.tags, ["leadership"]);
  assert.equal(row.fee, false);
  assert.ok(row.stated_fields.includes("need") && row.stated_fields.includes("essay"));
  assert.ok(!row.stated_fields.includes("award_max") && !row.stated_fields.includes("fee") && !row.stated_fields.includes("merit"));
  assert.ok(evidence.some((line) => line.field === "deadline") && !evidence.some((line) => line.field === "award_max"));
  assert.ok(cleanRecord({ url: "https://acme.academicworks.com/opportunities/2", name: "General Application", metadata: {} }, context).rejected);
  assert.ok(cleanRecord({ url: "http://acme.example/3", name: "Real Scholarship", metadata: {} }, context).rejected);
});

test("the review batch takes open, well-filled scholarships, one per school", async () => {
  const { pickBatch } = await import("../scripts/load-database.mjs");
  const base = { award_max: 1000, stated_fields: ["a", "b", "c", "d"], name: "Some Scholarship" };
  const rows = [
    { ...base, id: "b", school_unitid: 1, deadline: "2027-01-01" },
    { ...base, id: "a", school_unitid: 1, deadline: "2027-01-01" },
    { ...base, id: "c", school_unitid: 2, deadline: "2025-01-01" },
    { ...base, id: "d", school_unitid: 3, deadline: "2027-01-01", award_max: null },
    { ...base, id: "e", school_unitid: 4, deadline: "2027-01-01" },
  ];
  assert.deepEqual(pickBatch(rows, 2, "2026-11-24").map((row) => row.id), ["a", "e"]);
});
