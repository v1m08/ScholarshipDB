// Job 5: for every school in the registry, start at its financial aid page, follow the
// links about scholarships, and record each named scholarship those pages describe.
// Writes data/raw/school-pages/results.jsonl (one line per school) and keeps the cleaned
// text of every page read, so a later pass can re-read it without visiting the site again.
// robots.txt is obeyed per host; a school that refuses the crawler is recorded as blocked.
// Usage: node scrape-schools.mjs [--limit 20] [--only "Rice University"] [--pages 8]
//        [--concurrency 6] [--levels four-year,two-year] [--retry-errors]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser, politePool } from "./lib/fetcher.mjs";
import { readOrganization } from "./lib/org-reader.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

async function main() {
  const registry = JSON.parse(await readFile(join(repoRoot, "data", "registry", "institutions.json"), "utf8"));
  const levels = arg("levels", "four-year,two-year").split(",");
  const only = arg("only", null);
  let schools = registry.institutions.filter((school) => (school.financialAidUrl || school.website) && (only ? only.split("|").includes(school.name) : levels.includes(school.level) && school.control !== "private-for-profit"));
  const limit = Number(arg("limit", 0));
  if (limit) {
    const step = Math.max(1, Math.floor(schools.length / limit));
    schools = schools.filter((_, index) => index % step === 0).slice(0, limit);
  }
  const job = await openJob("school-pages");
  const total = schools.length;
  schools = schools.filter((school) => { const previous = job.done.get(school.unitid); return !previous || (process.argv.includes("--retry-errors") && (previous.error || previous.blocked)); });
  console.log(`${total} schools selected, ${total - schools.length} already done, ${schools.length} to read`);

  const maxPages = Number(arg("pages", 8));
  const counts = { schools: 0, withScholarships: 0, scholarships: 0, blocked: 0, errors: 0 };
  await politePool(schools, { concurrency: Number(arg("concurrency", 6)), keyOf: (school) => school.unitid, gapMs: 0 }, async (school) => {
    let row;
    try { row = await readOrganization({ key: school.unitid, name: school.name, state: school.state, start: school.financialAidUrl || school.website, home: school.website }, job, maxPages); }
    catch (error) { row = { key: school.unitid, name: school.name, error: error.message.split("\n")[0].slice(0, 120), pages: [], scholarships: [], portals: [] }; }
    await job.record(row);
    counts.schools += 1;
    if (row.blocked) counts.blocked += 1;
    if (row.error) counts.errors += 1;
    if (row.scholarships.length) counts.withScholarships += 1;
    counts.scholarships += row.scholarships.length;
    if (counts.schools % 20 === 0 || counts.schools === schools.length) console.log(`${counts.schools}/${schools.length}  ${JSON.stringify(counts)}`);
  });
  await closeBrowser();
  console.log(`Done. ${JSON.stringify(counts)}  Results: data/raw/school-pages/results.jsonl`);
}

main();
