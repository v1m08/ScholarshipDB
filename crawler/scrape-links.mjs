// Job 6: run the site scraper on every not-yet-scraped link in data/links/links.json that
// points at a provider's own site (everything except portal award pages, which have their
// own reader). Writes data/raw/link-sites/results.jsonl, one line per address. Several
// links can share one address (a foundation's "scholarships" page); it is read once and
// the line lists every scholarship name that points there. Resumable.
// One site is never visited by two workers at once; robots.txt is obeyed by the scraper.
// Usage: node scrape-links.mjs [--limit 12] [--via bigfuture,sallie] [--concurrency 6] [--retry-errors]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser, politePool } from "./lib/fetcher.mjs";
import { normalizeUrl } from "./lib/links.mjs";
import { analyzeSite } from "./lib/pipeline.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
// Portal hosts are read by their own jobs or are closed to crawlers.
const PORTAL = /(academicworks\.com|awardspring\.com|scholarshipuniverse\.com|communityforce\.com)$/i;

async function main() {
  const links = JSON.parse(await readFile(join(repoRoot, "data", "links", "links.json"), "utf8"));
  const via = arg("via", null)?.split(",");
  const byAddress = new Map();
  for (const entry of links) {
    if (!entry.url || entry.status !== "not-scraped" || entry.platform === "academicworks") continue;
    if (via && !entry.foundVia.some((source) => via.includes(source))) continue;
    let key;
    try { key = normalizeUrl(entry.url); if (PORTAL.test(new URL(entry.url).host)) continue; } catch { continue; }
    if (!byAddress.has(key)) byAddress.set(key, { key, url: entry.url, names: [], foundVia: new Set() });
    const item = byAddress.get(key);
    if (entry.name && !item.names.includes(entry.name)) item.names.push(entry.name);
    entry.foundVia.forEach((source) => item.foundVia.add(source));
  }
  let addresses = [...byAddress.values()];
  const limit = Number(arg("limit", 0));
  if (limit) {
    const step = Math.max(1, Math.floor(addresses.length / limit));
    addresses = addresses.filter((_, index) => index % step === 0).slice(0, limit);
  }
  const job = await openJob("link-sites");
  const total = addresses.length;
  addresses = addresses.filter((item) => { const previous = job.done.get(item.key); return !previous || (process.argv.includes("--retry-errors") && previous.error); });
  console.log(`${total} addresses selected, ${total - addresses.length} already done, ${addresses.length} to read`);

  // Group by site so one site's addresses are read one after another.
  const bySite = new Map();
  for (const item of addresses) {
    const host = new URL(item.url).host.replace(/^www\./, "");
    if (!bySite.has(host)) bySite.set(host, []);
    bySite.get(host).push(item);
  }
  const counts = { addresses: 0, read: 0, scholarships: 0, blocked: 0, errors: 0 };
  await politePool([...bySite.values()], { concurrency: Number(arg("concurrency", 6)), keyOf: (group) => group[0].key, gapMs: 0 }, async (group) => {
    for (const item of group) {
      const row = { key: item.key, url: item.url, names: item.names, foundVia: [...item.foundVia], readAt: new Date().toISOString() };
      try {
        // A link names one scholarship (or one page of them), so the bundle is kept small.
        const result = await analyzeSite(item.url, { maxPrograms: 3, pagesPerProgram: 5 });
        if (result.blocked) { row.blocked = result.reason || `HTTP ${result.status}`; counts.blocked += 1; }
        else if (result.error) { row.error = result.error; counts.errors += 1; }
        else {
          row.scholarships = result.scholarships.map(({ name, key, pages, metadata, digest, sizes }) => ({ name, key, pages, metadata, digest, digestTokens: sizes.digestTokens }));
          counts.read += 1;
          counts.scholarships += row.scholarships.length;
        }
      } catch (error) {
        row.error = error.message.split("\n")[0].slice(0, 120);
        counts.errors += 1;
      }
      await job.record(row);
      counts.addresses += 1;
      if (counts.addresses % 20 === 0 || counts.addresses === addresses.length) console.log(`${counts.addresses}/${addresses.length}  ${JSON.stringify(counts)}`);
    }
  });
  await closeBrowser();
  console.log(`Done. ${JSON.stringify(counts)}  Results: data/raw/link-sites/results.jsonl`);
}

main();
