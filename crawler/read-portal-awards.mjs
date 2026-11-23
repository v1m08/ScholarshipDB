// Job 3: open every AcademicWorks award link in data/links/links.json and turn its page into
// a record. Writes data/raw/portal-awards/results.jsonl (one line per award) and keeps only
// the award section of each page, not the whole 250 KB page. Resumable.
// Usage: node read-portal-awards.mjs [--limit 500] [--external-only] [--concurrency 3] [--retry-errors]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAwardPage } from "./lib/academicworks.mjs";
import { awardRecord } from "./lib/award-record.mjs";
import { fetchPage, politePool } from "./lib/fetcher.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const links = JSON.parse(await readFile(join(repoRoot, "data", "links", "links.json"), "utf8"));
  const registry = JSON.parse(await readFile(join(repoRoot, "data", "registry", "institutions.json"), "utf8"));
  const schoolName = new Map(registry.institutions.map((school) => [school.unitid, school.name]));
  let awards = links.filter((entry) => entry.platform === "academicworks" && entry.url && (!has("external-only") || entry.external));
  const job = await openJob("portal-awards");
  const limit = Number(arg("limit", 0));
  if (limit) {
    // A limited run takes awards spread evenly through the list, so many portals are covered.
    const step = Math.max(1, Math.floor(awards.length / limit));
    awards = awards.filter((_, index) => index % step === 0).slice(0, limit);
  }
  const total = awards.length;
  awards = awards.filter((entry) => { const previous = job.done.get(entry.id); return !previous || (has("retry-errors") && previous.error); });
  console.log(`${total} awards selected, ${total - awards.length} already done, ${awards.length} to read`);

  // All portals are one vendor, so the gap between requests is shared across every portal.
  const gapMs = Number(arg("gap", 350));
  let nextSlot = 0;
  const get = async (url) => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + gapMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    let page = await fetchPage(url, { render: "never" });
    if (page.status === 429 || page.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      page = await fetchPage(url, { render: "never" });
    }
    return page;
  };

  let finished = 0;
  const counts = { read: 0, signIn: 0, missing: 0, error: 0 };
  await politePool(awards, { concurrency: Number(arg("concurrency", 3)), keyOf: () => "academicworks", gapMs: 0 }, async (entry) => {
    const row = { key: entry.id, url: entry.url, readAt: new Date().toISOString() };
    try {
      const page = await get(entry.url);
      if (/\/users\/sign_in/.test(page.finalUrl || "")) { row.signIn = true; counts.signIn += 1; }
      else if (page.status >= 400) { row.error = `HTTP ${page.status}`; counts[page.status === 404 ? "missing" : "error"] += 1; }
      else {
        const parsed = parseAwardPage(page.html);
        if (!parsed) { row.error = "award section not found"; counts.error += 1; }
        else {
          // A portal shared by several schools is not narrowed to one of them.
          const school = entry.unitids?.length === 1 ? schoolName.get(entry.unitids[0]) : null;
          const portalName = school || entry.hints?.listedBy || entry.provider;
          row.record = awardRecord(parsed, { url: entry.url, portalName, external: Boolean(entry.external) });
          row.description = parsed.description;
          row.questions = parsed.questions;
          counts.read += 1;
        }
      }
    } catch (error) {
      row.error = error.message.split("\n")[0].slice(0, 120);
      counts.error += 1;
    }
    await job.record(row);
    finished += 1;
    if (finished % 25 === 0 || finished === awards.length) console.log(`${finished}/${awards.length}  ${JSON.stringify(counts)}`);
  });
  console.log(`Done. ${JSON.stringify(counts)}  Results: data/raw/portal-awards/results.jsonl`);
}

main();
