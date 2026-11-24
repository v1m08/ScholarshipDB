// Job 11: fetch again what the audit (scripts/audit-quality.mjs) says was not scraped right.
// Reads data/records/rescrape.jsonl, one address per line with the names that need it and why:
//   not-opened     a scholarship's own page was linked but never read      -> fetch that page
//   not-rendered   the page came back nearly empty                         -> fetch it with a browser
//   wrong-page, bare-list, dead
//                  the address we have does not describe the scholarship   -> look the name up in
//                  the site's own sitemap and read the page whose address spells it
// Writes data/raw/rescrape/results.jsonl, one line per address: each name found (with the
// text read for it), the names still not found, and other scholarships on the pages read.
// robots.txt is obeyed; a site that refuses the crawler is recorded as blocked and left alone.
// Usage: node rescrape.mjs [--limit 40] [--only not-opened,not-rendered] [--concurrency 8] [--retry-errors]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanLines } from "./lib/clean.mjs";
import { closeBrowser, fetchPage, politePool, USER_AGENT } from "./lib/fetcher.mjs";
import { findNamed, nameKey } from "./lib/named-reader.mjs";
import { parseRobots } from "./lib/robots.mjs";
import { wholePage } from "./lib/school-pages.mjs";
import { candidatesFor, sitemapUrls } from "./lib/sitemap.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";
import { scholarshipsFrom } from "./reread-saved.mjs";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FETCH = ["not-opened", "not-rendered"];
const NOT_A_PAGE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|zip|mp4)(\?|$)|^mailto:|^tel:/i;

// One site's rules and sitemap, fetched once.
const siteCache = new Map();
function siteFor(origin) {
  if (!siteCache.has(origin)) {
    siteCache.set(origin, (async () => {
      let text = "";
      try { const response = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }); if (response.ok) text = await response.text(); } catch { /* no robots file */ }
      const robots = parseRobots(text);
      let urls = null;
      return { robots, gapMs: Math.max(500, Math.min(robots.crawlDelay, 5) * 1000), sitemap: async () => (urls ||= await sitemapUrls(origin, text, { allowed: (path) => robots.allowed(path) }).catch(() => [])) };
    })());
  }
  return siteCache.get(origin);
}

async function read(url, render) {
  const parsed = new URL(url);
  const site = await siteFor(parsed.origin);
  if (!site.robots.allowed(`${parsed.pathname}${parsed.search}`)) return { skipped: "robots" };
  await sleep(site.gapMs);
  const page = await fetchPage(url, { render });
  if ([401, 403, 405, 429].includes(page.status)) return { skipped: `refused (HTTP ${page.status})` };
  if (page.status >= 400) return { skipped: `HTTP ${page.status}` };
  return page;
}

async function rescrapeOne(item, job) {
  const row = { key: item.url, url: item.url, source: item.source, reasons: item.reasons, readAt: new Date().toISOString(), pages: [], scholarships: [], unmatched: [], others: [] };
  const names = item.names || [];
  const fetchMode = FETCH.some((reason) => item.reasons[reason]);
  row.mode = fetchMode ? "fetch" : "sitemap";
  let targets = [];
  // The one name each page was chosen for, when there is exactly one.
  const chosenFor = new Map();
  if (fetchMode && names.length === 1) chosenFor.set(item.url, names[0]);
  if (fetchMode) targets = [{ url: item.url, render: item.reasons["not-rendered"] ? "always" : "auto" }];
  else {
    const origin = new URL(item.url).origin;
    const urls = await (await siteFor(origin)).sitemap();
    row.sitemapPages = urls.length;
    const candidates = candidatesFor(names, urls);
    row.candidates = candidates.size;
    const owners = new Map();
    for (const [name, list] of candidates) for (const url of list) owners.set(url, [...(owners.get(url) || []), name]);
    for (const [url, list] of owners) if (list.length === 1) chosenFor.set(url, list[0]);
    targets = [...new Set([...candidates.values()].flat())].slice(0, Math.min(60, Math.max(6, names.length * 2))).map((url) => ({ url, render: "auto" }));
    if (!urls.length) row.note = "site publishes no sitemap";
  }
  const pages = [];
  for (const target of targets) {
    if (NOT_A_PAGE.test(target.url)) { row.pages.push({ url: target.url, skipped: "a document, not a page" }); continue; }
    let page;
    try { page = await read(target.url, target.render); } catch (error) { page = { skipped: error.message.split("\n")[0].slice(0, 60) }; }
    if (page.skipped) { row.pages.push({ url: target.url, skipped: page.skipped }); continue; }
    const lines = cleanLines(page.html);
    const url = page.finalUrl || target.url;
    if (chosenFor.has(target.url)) chosenFor.set(url, chosenFor.get(target.url));
    row.pages.push({ url, lines: lines.length, method: page.method, text: await job.savePage(lines.join("\n")) });
    pages.push({ url, lines });
  }
  if (fetchMode && !pages.length) {
    const why = row.pages[0]?.skipped || "nothing read";
    row[/robots|refused/.test(why) ? "blocked" : "error"] = why;
    row.unmatched = names;
    return row;
  }
  const named = findNamed(names.map((name) => ({ name, provider: null })), pages);
  // A page reached through a link named after one scholarship, or whose address spells its
  // name, is that scholarship's page whatever its heading says.
  for (const page of pages) {
    const name = chosenFor.get(page.url);
    const at = name ? named.findIndex((entry) => entry.name === name) : -1;
    if (at < 0 || named[at].text?.length) continue;
    const whole = wholePage(page.lines, page.url);
    if (whole) named[at] = { name, found: true, url: whole.url, how: "linked-page", title: whole.title, metadata: whole.metadata, lines: whole.lines, text: whole.text };
  }
  const taken = new Set(names.map((name) => nameKey(name)));
  row.scholarships = named.filter((entry) => entry.found);
  row.unmatched = named.filter((entry) => !entry.found).map((entry) => entry.name);
  row.others = scholarshipsFrom(pages).filter((entry) => !taken.has(nameKey(entry.name)) && !row.scholarships.some((found) => found.title && nameKey(found.title) === nameKey(entry.name))).map(({ name, url, metadata, nameOnly, text }) => ({ name, url, metadata, nameOnly, text }));
  return row;
}

async function main() {
  let items;
  try { items = (await readFile(join(repoRoot, "data", "records", "rescrape.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { console.error("No re-scrape list. Run: node --max-old-space-size=3000 ../scripts/audit-quality.mjs"); process.exit(1); }
  const only = arg("only", null)?.split(",");
  if (only) items = items.filter((item) => only.some((reason) => item.reasons[reason]));
  items = items.filter((item) => { try { return /^https?:$/.test(new URL(item.url).protocol); } catch { return false; } });
  const limit = Number(arg("limit", 0));
  if (limit) { const step = Math.max(1, Math.floor(items.length / limit)); items = items.filter((_, index) => index % step === 0).slice(0, limit); }
  const job = await openJob("rescrape");
  const total = items.length;
  items = items.filter((item) => { const previous = job.done.get(item.url); return !previous || (process.argv.includes("--retry-errors") && previous.error); });
  console.log(`${total} addresses selected, ${total - items.length} already done, ${items.length} to read`);

  // One site's addresses are read one after another, never by two workers at once.
  const bySite = new Map();
  for (const item of items) { const host = new URL(item.url).host.replace(/^www\./, ""); if (!bySite.has(host)) bySite.set(host, []); bySite.get(host).push(item); }
  const counts = { addresses: 0, namesFound: 0, withText: 0, stillNotFound: 0, others: 0, blocked: 0, errors: 0 };
  await politePool([...bySite.values()], { concurrency: Number(arg("concurrency", 8)), keyOf: (group) => group[0].url, gapMs: 0 }, async (group) => {
    for (const item of group) {
      let row;
      try { row = await rescrapeOne(item, job); }
      catch (error) { row = { key: item.url, url: item.url, source: item.source, reasons: item.reasons, readAt: new Date().toISOString(), error: error.message.split("\n")[0].slice(0, 120), unmatched: item.names || [] }; }
      if (row.blocked) counts.blocked += 1;
      else if (row.error) counts.errors += 1;
      counts.namesFound += (row.scholarships || []).length;
      counts.withText += (row.scholarships || []).filter((entry) => entry.text?.length).length;
      counts.stillNotFound += (row.unmatched || []).length;
      counts.others += (row.others || []).length;
      await job.record(row);
      counts.addresses += 1;
      if (counts.addresses % 25 === 0 || counts.addresses === items.length) console.log(`${counts.addresses}/${items.length}  ${JSON.stringify(counts)}`);
    }
    // A site's sitemap can be large; it is not needed once the site is done.
    try { siteCache.delete(new URL(group[0].url).origin); } catch { /* not an address */ }
  });
  await closeBrowser();
  console.log(`Done. ${JSON.stringify(counts)}  Results: data/raw/rescrape/results.jsonl`);
}

main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
