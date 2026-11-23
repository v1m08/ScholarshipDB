// Job 5: for every school in the registry, start at its financial aid page, follow the
// links about scholarships, and record each named scholarship those pages describe.
// Writes data/raw/school-pages/results.jsonl (one line per school) and keeps the cleaned
// text of every page read, so a later pass can re-read it without visiting the site again.
// robots.txt is obeyed per host; a school that refuses the crawler is recorded as blocked.
// Usage: node scrape-schools.mjs [--limit 20] [--only "Rice University"] [--pages 8]
//        [--concurrency 6] [--levels four-year,two-year] [--retry-errors]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser, fetchPage, pageTitle, politePool, USER_AGENT } from "./lib/fetcher.mjs";
import { parseRobots } from "./lib/robots.mjs";
import { baseDomain, cleanLines, scholarshipLinks, scholarshipsOn } from "./lib/school-pages.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withScheme = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

const robotsCache = new Map();
async function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const response = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
        return parseRobots(response.ok ? await response.text() : "");
      } catch { return parseRobots(""); }
    })());
  }
  return robotsCache.get(origin);
}

async function readSchool(school, job, maxPages) {
  const row = { key: school.unitid, name: school.name, state: school.state, start: withScheme(school.financialAidUrl || school.website), readAt: new Date().toISOString(), pages: [], scholarships: [], portals: [] };
  const visited = new Set();
  const portals = new Set();
  let gapMs = 500;
  const read = async (url) => {
    const parsed = new URL(url);
    const robots = await robotsFor(parsed.origin);
    if (!robots.allowed(`${parsed.pathname}${parsed.search}`)) return { skipped: "robots" };
    gapMs = Math.max(gapMs, Math.min(robots.crawlDelay, 5) * 1000);
    if (visited.size) await sleep(gapMs);
    const page = await fetchPage(url);
    if ([401, 403, 405, 429].includes(page.status)) return { skipped: `refused (HTTP ${page.status})` };
    if (page.status >= 400) return { skipped: `HTTP ${page.status}` };
    return page;
  };

  let first = await read(row.start).catch((error) => ({ skipped: error.message.split("\n")[0].slice(0, 60) }));
  // A financial aid address that no longer works: fall back to the school's home page.
  const home = school.website ? withScheme(school.website) : null;
  if (first.skipped && !/robots|refused/.test(first.skipped) && home && home !== row.start) {
    row.startFailed = first.skipped;
    row.start = home;
    first = await read(home).catch((error) => ({ skipped: error.message.split("\n")[0].slice(0, 60) }));
  }
  if (first.skipped) { row[/robots|refused/.test(first.skipped) ? "blocked" : "error"] = first.skipped; return row; }
  const domain = baseDomain(new URL(first.finalUrl || row.start).host);
  const queue = [{ url: first.finalUrl || row.start, page: first, depth: 0, score: 99 }];
  while (queue.length && row.pages.length < maxPages) {
    queue.sort((a, b) => b.score - a.score);
    const item = queue.shift();
    const key = item.url.replace(/\/$/, "");
    if (visited.has(key)) continue;
    let page = item.page;
    if (!page) {
      try { page = await read(item.url); } catch (error) { page = { skipped: error.message.split("\n")[0].slice(0, 60) }; }
    }
    visited.add(key);
    if (page.skipped) { row.pages.push({ url: item.url, skipped: page.skipped }); continue; }
    visited.add((page.finalUrl || item.url).replace(/\/$/, ""));
    const lines = cleanLines(page.html);
    const sha = await job.savePage(lines.join("\n"));
    const found = scholarshipsOn(lines, page.finalUrl || item.url);
    row.pages.push({ url: page.finalUrl || item.url, title: pageTitle(page.html), lines: lines.length, scholarships: found.length, method: page.method, text: sha });
    for (const scholarship of found) if (!row.scholarships.some((other) => other.name.toLowerCase() === scholarship.name.toLowerCase())) row.scholarships.push(scholarship);
    const links = scholarshipLinks(page.html, page.finalUrl || item.url, domain, { aidLinks: Boolean(row.startFailed) && item.depth === 0 });
    // Nothing about scholarships is linked from the start page: try the two usual addresses.
    if (item.depth === 0 && !links.pages.some((link) => /scholarship/i.test(`${link.url} ${link.text}`))) {
      for (const guess of [`https://scholarships.${domain}/`, `https://www.${domain}/scholarships`]) queue.push({ url: guess, depth: 1, score: 5 });
    }
    links.portals.forEach((portal) => portals.add(portal));
    // Follow scholarship links from the start page and from the pages it leads to, no further.
    if (item.depth < 2) for (const link of links.pages) if (!visited.has(link.url.replace(/\/$/, ""))) queue.push({ url: link.url, depth: item.depth + 1, score: link.score - item.depth });
  }
  row.portals = [...portals];
  return row;
}

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
    try { row = await readSchool(school, job, maxPages); }
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
