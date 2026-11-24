// Job 10: read again the page text earlier crawls saved, with the current readers. Nothing
// is fetched. Each site's line in results.jsonl is written again (the later line wins), now
// with the text kept for every scholarship and with descriptions that sit under sub-headings.
// Covers school-pages, foundation-pages and the shared addresses of link-sites.
// Usage: node --max-old-space-size=3000 reread-saved.mjs [--jobs school-pages,foundation-pages,link-sites] [--limit 50]
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeUrl } from "./lib/links.mjs";
import { findNamed, nameKey } from "./lib/named-reader.mjs";
import { scholarshipPage, scholarshipsOn } from "./lib/school-pages.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const today = new Date().toISOString().slice(0, 10);

// The scholarships a site's saved pages describe, merged the way the site reader merges them.
export function scholarshipsFrom(pages, earlier = []) {
  const found = [];
  for (const page of pages) {
    const single = scholarshipPage(page.lines, page.url);
    for (const scholarship of single ? [single] : scholarshipsOn(page.lines, page.url)) {
      const at = found.findIndex((other) => other.name.toLowerCase() === scholarship.name.toLowerCase());
      if (at < 0) found.push(scholarship);
      else if (scholarship.metadata && (!found[at].metadata || (scholarship.ownPage && !found[at].ownPage))) found[at] = scholarship;
    }
  }
  // Names seen only as links stay known, so their pages can still be fetched.
  for (const link of earlier.filter((item) => item.linkOnly)) if (!found.some((other) => other.name.toLowerCase() === link.name.toLowerCase())) found.push(link);
  return found;
}

async function main() {
  const jobs = arg("jobs", "school-pages,foundation-pages,link-sites").split(",");
  const limit = Number(arg("limit", 0));
  // The provider of each listed name, for names written with the provider in front.
  const providers = new Map();
  const linksPath = join(repoRoot, "data", "links", "links.json");
  if (jobs.includes("link-sites") && existsSync(linksPath)) {
    for (const entry of JSON.parse(await readFile(linksPath, "utf8"))) {
      if (!entry.url || !entry.name) continue;
      try { providers.set(`${normalizeUrl(entry.url)}|${entry.name}`, entry.provider || null); } catch { /* unusable address */ }
    }
  }
  for (const name of jobs) {
    const job = await openJob(name);
    const counts = { sites: 0, reread: 0, pagesMissing: 0, before: { scholarships: 0, withText: 0, withFacts: 0 }, after: { scholarships: 0, withText: 0, withFacts: 0 } };
    const tally = (bucket, list) => { for (const item of list) { bucket.scholarships += 1; if (item.text?.length) bucket.withText += 1; if (item.metadata) bucket.withFacts += 1; } };
    let rows = [...job.done.values()].filter((row) => Array.isArray(row.pages) && row.pages.some((page) => page.text) && row.reread !== today);
    if (name === "link-sites") rows = rows.filter((row) => row.shared);
    if (limit) rows = rows.slice(0, limit);
    for (const row of rows) {
      counts.sites += 1;
      const pages = [];
      for (const page of row.pages) {
        if (!page.text) continue;
        try { pages.push({ url: page.url, lines: (await readFile(join(job.dir, "pages", `${page.text}.html`), "utf8")).split("\n") }); }
        catch { counts.pagesMissing += 1; }
      }
      if (!pages.length) continue;
      const next = { ...row, reread: today };
      if (name === "link-sites") {
        const names = [...(row.scholarships || []).map((item) => item.name), ...(row.unmatched || [])];
        const leads = names.map((lead) => ({ name: lead, provider: providers.get(`${row.key}|${lead}`) || null }));
        const named = findNamed(leads, pages);
        const taken = new Set(leads.map((lead) => nameKey(lead.name)));
        tally(counts.before, [...(row.scholarships || []), ...(row.others || [])]);
        next.scholarships = named.filter((entry) => entry.found);
        next.unmatched = named.filter((entry) => !entry.found).map((entry) => entry.name);
        next.others = scholarshipsFrom(pages, row.others || []).filter((entry) => !taken.has(nameKey(entry.name))).map(({ name: title, url, metadata, linkOnly, nameOnly, text }) => ({ name: title, url, metadata, linkOnly, nameOnly, text }));
        tally(counts.after, [...next.scholarships, ...next.others]);
      } else {
        tally(counts.before, row.scholarships || []);
        next.scholarships = scholarshipsFrom(pages, row.scholarships || []);
        tally(counts.after, next.scholarships);
      }
      await job.record(next);
      counts.reread += 1;
      if (counts.sites % 500 === 0) console.log(`${name} ${counts.sites}/${rows.length}`);
    }
    console.log(`${name}: ${JSON.stringify(counts)}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("reread-saved.mjs")) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
