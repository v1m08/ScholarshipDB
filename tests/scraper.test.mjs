import assert from "node:assert/strict";
import test from "node:test";
import { cleanLines } from "../crawler/lib/clean.mjs";
import { AWARD_LIMIT, datesIn, extractMetadata } from "../crawler/lib/digest.mjs";
import { programKey, scoreUrl } from "../crawler/lib/discover.mjs";

const lines = (...texts) => texts.map((text) => ({ text }));

test("page names decide relevance", () => {
  assert.ok(scoreUrl("https://x.org/our-scholarships/college-scholarship-program/how-to-apply") > 0);
  assert.ok(scoreUrl("https://x.org/students/eligibility") > 0);
  assert.equal(scoreUrl("https://x.org/terms-of-service"), 0);
  assert.equal(scoreUrl("https://x.org/news/2026/scholarship-winners-announced"), 0);
  assert.ok(scoreUrl("https://x.org/interior.aspx?pgid=9", "Entry Requirements") > 0);
});

test("pages are grouped by the scholarship folder they sit in", () => {
  assert.equal(programKey("https://x.org/our-scholarships/college-scholarship-program/faqs/"), "/our-scholarships/college-scholarship-program");
  assert.equal(programKey("https://x.org/students/overview/"), "/");
});

test("cleaning keeps headings and list items and drops menus, scripts and footers", () => {
  const html = "<body><nav><a>Home</a></nav><main><h2>Who can apply</h2><ul><li>High school seniors</li></ul><script>x()</script></main><footer>Copyright</footer></body>";
  assert.deepEqual(cleanLines(html), ["# Who can apply", "- High school seniors"]);
});

test("a date without a year borrows it, and a range gives open date and deadline", () => {
  assert.deepEqual(datesIn("from Monday, August 3, through 5 pm Eastern on Wednesday, September 30, 2026"), ["2026-08-03", "2026-09-30"]);
  assert.deepEqual(datesIn("opens November 3 and closes January 5, 2027"), ["2026-11-03", "2027-01-05"]);
  const meta = extractMetadata(lines("The application will be available from Monday, August 3, through 5 pm Eastern on Wednesday, September 30, 2026."));
  assert.equal(meta.opens.value, "2026-08-03");
  assert.equal(meta.deadline.value, "2026-09-30");
});

test("organization totals and amounts over the limit are not awards", () => {
  const meta = extractMetadata(lines(
    "Some Other Fund - The largest provider, awarding $15 million in scholarships annually and more than $200 million since inception.",
    "150 Scholars are selected each year to receive this $20,000 scholarship.",
    "First place finalists receive $250,000 for their research.",
  ));
  assert.equal(meta.awardMaximum.value, 20000);
  assert.ok(meta.doubts.some((doubt) => doubt.field === "awardMaximum" && doubt.reason.includes(AWARD_LIMIT.toLocaleString())));
});

test("a per-year amount is preferred over the multi-year total", () => {
  const meta = extractMetadata(lines("We will award up to $10,000 each year of your 4-year degree program (up to $40,000 total)."));
  assert.equal(meta.awardMaximum.value, 10000);
  assert.equal(meta.awardPerYear.value, true);
  assert.equal(meta.renewable.value, true);
});

test("an FAQ question is read through its answer, not its keywords", () => {
  const meta = extractMetadata(lines(
    "Is this a needs- or income-based scholarship? Expand",
    "The scholarship is an achievement-based scholarship.",
    "Must I be a U.S. citizen to apply?",
    "No. You must, however, reside in the United States.",
    "Do I need to apply through the portal?",
    "Yes, all applications are online.",
  ));
  assert.equal(meta.need.value, "no");
  assert.deepEqual(meta.citizenship.value, ["any"]);
});

test("only first-round requirements count, and later rounds are flagged", () => {
  const meta = extractMetadata(lines(
    "This phase requires no essays, no transcript, and no recommendations.",
    "250 Semifinalists will advance and participate in a final interview with alumni and staff.",
  ));
  assert.equal(meta.essay.value, false);
  assert.equal(meta.recommendations.value, false);
  assert.equal(meta.interview.value, false);
  assert.equal(meta.hasLaterRounds.value, true);
});

test("grade levels come from eligibility sentences, and the lowest GPA minimum wins", () => {
  const meta = extractMetadata(lines(
    "Applicants must be an undergraduate student in good standing at a two-year or four-year institution.",
    "Many scholars go on to graduate school.",
    "Minimum of 3.0 GPA on a 4.0 scale for high school students; minimum of 2.5 GPA on a 4.0 scale for college students.",
  ));
  assert.ok(meta.gradeLevels.value.includes("college-junior"));
  assert.ok(meta.gradeLevels.value.includes("community-college"));
  assert.ok(!meta.gradeLevels.value.includes("graduate"));
  assert.equal(meta.minimumGpa.value, 2.5);
});
