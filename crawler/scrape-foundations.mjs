// Job 7: for every community foundation in data/registry/foundations.json, start at its
// scholarships page (or home page), follow the links about scholarships, and record each
// named scholarship those pages describe. Writes data/raw/foundation-pages/results.jsonl
// (one line per foundation) and keeps the cleaned text of every page read.
// robots.txt is obeyed per host; a foundation that refuses the crawler is recorded as blocked.
// Usage: node scrape-foundations.mjs [--limit 15] [--only "cfnoble.org|pacf.org"] [--pages 60]
//        [--concurrency 6] [--retry-errors]
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
  let foundations;
  try { foundations = JSON.parse(await readFile(join(repoRoot, "data", "registry", "foundations.json"), "utf8")).foundations; }
  catch { console.error("No foundation list found. Run: node ../scripts/build-foundations.mjs"); process.exit(1); }
  const only = arg("only", null)?.split("|");
  if (only) foundations = foundations.filter((entry) => only.includes(entry.host) || only.includes(entry.name));
  const limit = Number(arg("limit", 0));
  if (limit) {
    const step = Math.max(1, Math.floor(foundations.length / limit));
    foundations = foundations.filter((_, index) => index % step === 0).slice(0, limit);
  }
  const job = await openJob("foundation-pages");
  const total = foundations.length;
  foundations = foundations.filter((entry) => { const previous = job.done.get(entry.host); return !previous || (process.argv.includes("--retry-errors") && (previous.error || previous.blocked)); });
  console.log(`${total} foundations selected, ${total - foundations.length} already done, ${foundations.length} to read`);

  // Foundations usually give each scholarship its own page, so many pages are allowed.
  const maxPages = Number(arg("pages", 60));
  const counts = { foundations: 0, withScholarships: 0, scholarships: 0, blocked: 0, errors: 0 };
  await politePool(foundations, { concurrency: Number(arg("concurrency", 6)), keyOf: (entry) => entry.host, gapMs: 0 }, async (entry) => {
    let row;
    // A scholarships page already known from a listing site is the best place to start.
    const org = { key: entry.host, name: entry.name, state: entry.place, start: entry.scholarshipPages?.[0] || entry.website, home: entry.website };
    try { row = await readOrganization(org, job, maxPages); }
    catch (error) { row = { key: entry.host, name: entry.name, error: error.message.split("\n")[0].slice(0, 120), pages: [], scholarships: [], portals: [] }; }
    await job.record(row);
    counts.foundations += 1;
    if (row.blocked) counts.blocked += 1;
    if (row.error) counts.errors += 1;
    if (row.scholarships.length) counts.withScholarships += 1;
    counts.scholarships += row.scholarships.length;
    if (counts.foundations % 20 === 0 || counts.foundations === foundations.length) console.log(`${counts.foundations}/${foundations.length}  ${JSON.stringify(counts)}`);
  });
  await closeBrowser();
  console.log(`Done. ${JSON.stringify(counts)}  Results: data/raw/foundation-pages/results.jsonl`);
}

main();
