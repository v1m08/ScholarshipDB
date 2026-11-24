// Job 4: gather leads from scholarship listing sites that are not tied to one college
// (BigFuture, Fastweb, Scholarships360, Access Scholarships, Sallie, Peterson's, JLV's weekly
// posts, InternationalStudent.com).
// For each scholarship page a site lists in its sitemap, record the scholarship's name and
// the provider's own address. Writes data/raw/listing-sites/results.jsonl. Resumable.
// Each site's robots.txt is read first; a path it disallows is skipped, its crawl delay is
// honored, and a site that starts refusing requests is stopped and recorded as blocked.
// Usage: node collect-listing-sites.mjs [--site bigfuture] [--limit 15] [--retry-errors]
import { gunzipSync } from "node:zlib";
import { USER_AGENT } from "./lib/fetcher.mjs";
import { LISTING_SITES, tidyLeads } from "./lib/listing-sites.mjs";
import { parseRobots } from "./lib/robots.mjs";
import { openJob } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
  let body = Buffer.from(await response.arrayBuffer());
  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
  return { status: response.status, text: body.toString("utf8") };
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map((match) => match[1].trim().replace(/&amp;/g, "&"));

async function sitemapPages(site, gapMs) {
  const queue = [site.sitemap];
  const pages = new Set();
  let fetched = 0;
  while (queue.length && fetched < 60) {
    if (fetched) await sleep(gapMs);
    const result = await get(queue.shift());
    fetched += 1;
    if (result.status >= 400) continue;
    if (/<sitemapindex/i.test(result.text)) queue.push(...locs(result.text).filter((url) => !site.childSitemaps || site.childSitemaps.test(url)));
    else for (const url of locs(result.text)) if (site.page.test(url)) pages.add(url);
  }
  return [...pages];
}

// A site without a sitemap: walk its numbered result pages until one adds nothing new.
async function listingPages(site, gapMs, robots, limit) {
  const pages = new Set();
  for (let number = 1; number <= site.listing.maxPages; number += 1) {
    const url = site.listing.url(number);
    if (!robots.allowed(`${new URL(url).pathname}${new URL(url).search}`)) break;
    if (number > 1) await sleep(gapMs);
    const result = await get(url);
    if (result.status >= 400) break;
    const before = pages.size;
    for (const match of result.text.matchAll(site.listing.link)) pages.add(new URL(match[1].replace(/&amp;/g, "&"), url).toString());
    // Past the last page the site repeats what it already showed.
    if (pages.size === before || (limit && pages.size >= limit * 4)) break;
  }
  return [...pages].filter((page) => site.page.test(page));
}

async function runSite(site, job, limit) {
  const say = (message) => console.log(`[${site.id}] ${message}`);
  let robots;
  try {
    const result = await get(new URL("/robots.txt", site.sitemap).toString());
    if ([401, 403, 429].includes(result.status)) { say(`robots.txt refused (HTTP ${result.status}); site skipped`); return; }
    robots = parseRobots(result.status < 400 ? result.text : "");
  } catch (error) { say(`robots.txt unreachable (${error.message}); site skipped`); return; }
  const gapMs = Math.max(site.gapMs, robots.crawlDelay * 1000);
  let pages = (site.listing ? await listingPages(site, gapMs, robots, limit) : await sitemapPages(site, gapMs)).filter((url) => robots.allowed(new URL(url).pathname));
  const listed = pages.length;
  if (limit) {
    // A limited run takes pages spread evenly through the sitemap.
    const step = Math.max(1, Math.floor(pages.length / limit));
    pages = pages.filter((_, index) => index % step === 0).slice(0, limit);
  }
  const selected = pages.length;
  pages = pages.filter((url) => { const previous = job.done.get(url); return !previous || (process.argv.includes("--retry-errors") && previous.error); });
  say(`${listed} pages listed, ${selected} selected, ${selected - pages.length} already done, ${pages.length} to read (one every ${gapMs} ms)`);

  const counts = { pages: 0, leads: 0, withAddress: 0, errors: 0 };
  let refusals = 0;
  for (const url of pages) {
    await sleep(gapMs);
    const row = { key: url, site: site.id, collectedAt: new Date().toISOString() };
    try {
      let page = await get(url);
      if (page.status >= 500) { await sleep(8000); page = await get(url); }
      if ([401, 403, 429].includes(page.status)) {
        // The site is refusing us: stop rather than push on. Nothing is recorded for this
        // page, so a later run picks up from here.
        refusals += 1;
        if (refusals >= 3) { say(`refused ${refusals} times in a row (HTTP ${page.status}); stopping this site`); break; }
        await sleep(30000);
        continue;
      }
      refusals = 0;
      if (page.status >= 400) { row.error = `HTTP ${page.status}`; counts.errors += 1; }
      else {
        row.leads = tidyLeads(site.leads(page.text));
        counts.leads += row.leads.length;
        counts.withAddress += row.leads.filter((lead) => lead.url).length;
      }
    } catch (error) {
      row.error = error.message.split("\n")[0].slice(0, 120);
      counts.errors += 1;
    }
    await job.record(row);
    counts.pages += 1;
    if (counts.pages % 25 === 0 || counts.pages === pages.length) say(`${counts.pages}/${pages.length}  ${JSON.stringify(counts)}`);
  }
  say(`done ${JSON.stringify(counts)}`);
}

const only = arg("site", null);
const sites = LISTING_SITES.filter((site) => !only || only.split(",").includes(site.id));
if (!sites.length) { console.error(`Unknown site. Choose from: ${LISTING_SITES.map((site) => site.id).join(", ")}`); process.exit(1); }
const job = await openJob("listing-sites");
// Sites run side by side; each keeps its own pace, so no single site sees more than one
// request at a time.
await Promise.all(sites.map((site) => runSite(site, job, Number(arg("limit", 0))).catch((error) => console.log(`[${site.id}] failed: ${error.message}`))));
console.log("Results: data/raw/listing-sites/results.jsonl");
