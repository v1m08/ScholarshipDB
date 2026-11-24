// Job 6: run the site scraper on every not-yet-scraped link in data/links/links.json that
// points at a provider's own site (everything except portal award pages, which have their
// own reader). Writes data/raw/link-sites/results.jsonl, one line per address. Several
// links can share one address (a school's or foundation's "scholarships" page); it is read
// once. When two or more names point at one address the site's scholarship pages are read
// and each name is looked for on them (lib/named-reader.mjs): the line then holds one
// entry per name found, the names not found, and other scholarships seen on the way. Resumable.
// One site is never visited by two workers at once; robots.txt is obeyed by the scraper.
// Usage: node scrape-links.mjs [--limit 12] [--via bigfuture,sallie] [--concurrency 6] [--retry-errors]
//        [--redo-shared]  read again the shared addresses an earlier version read as one scholarship
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser, politePool } from "./lib/fetcher.mjs";
import { normalizeUrl } from "./lib/links.mjs";
import { findNamed, linkNames, nameKey } from "./lib/named-reader.mjs";
import { readOrganization } from "./lib/org-reader.mjs";
import { analyzeSite } from "./lib/pipeline.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
// Portal hosts are read by their own jobs or are closed to crawlers.
const PORTAL = /(academicworks\.com|awardspring\.com|scholarshipuniverse\.com|communityforce\.com)$/i;

// An address that several names point at: read the site's pages about scholarships and
// find each name on them.
async function readShared(item, job) {
  const pages = [];
  const origin = new URL(item.url).origin;
  // More names need more pages, within reason.
  const maxPages = Math.min(40, 6 + item.leads.length * 2);
  const org = await readOrganization({ key: item.key, name: new URL(item.url).host, start: item.url, home: `${origin}/` }, job, maxPages, { onPage: (url, lines) => pages.push({ url, lines }), wantedLink: linkNames(item.leads) });
  const named = findNamed(item.leads, pages);
  const taken = new Set(item.leads.map((lead) => nameKey(lead.name)));
  return {
    shared: true,
    blocked: org.blocked,
    error: org.error,
    startFailed: org.startFailed,
    pages: org.pages,
    portals: org.portals,
    scholarships: named.filter((entry) => entry.found),
    unmatched: named.filter((entry) => !entry.found).map((entry) => entry.name),
    // Scholarships the pages describe that no listing site told us about.
    others: org.scholarships.filter((entry) => !taken.has(nameKey(entry.name))).map(({ name, url, metadata, linkOnly, nameOnly }) => ({ name, url, metadata, linkOnly, nameOnly })),
  };
}

async function main() {
  const links = JSON.parse(await readFile(join(repoRoot, "data", "links", "links.json"), "utf8"));
  const via = arg("via", null)?.split(",");
  const byAddress = new Map();
  for (const entry of links) {
    if (!entry.url || entry.status !== "not-scraped" || entry.platform === "academicworks") continue;
    if (via && !entry.foundVia.some((source) => via.includes(source))) continue;
    let key;
    try { key = normalizeUrl(entry.url); if (PORTAL.test(new URL(entry.url).host)) continue; } catch { continue; }
    if (!byAddress.has(key)) byAddress.set(key, { key, url: entry.url, names: [], leads: [], foundVia: new Set() });
    const item = byAddress.get(key);
    if (entry.name && !item.names.includes(entry.name)) { item.names.push(entry.name); item.leads.push({ name: entry.name, provider: entry.provider || null }); }
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
  addresses = addresses.filter((item) => { const previous = job.done.get(item.key); return !previous || (process.argv.includes("--retry-errors") && previous.error) || (process.argv.includes("--redo-shared") && item.names.length > 1 && !previous.shared); });
  console.log(`${total} addresses selected, ${total - addresses.length} already done, ${addresses.length} to read`);

  // Group by site so one site's addresses are read one after another.
  const bySite = new Map();
  for (const item of addresses) {
    const host = new URL(item.url).host.replace(/^www\./, "");
    if (!bySite.has(host)) bySite.set(host, []);
    bySite.get(host).push(item);
  }
  const counts = { addresses: 0, read: 0, scholarships: 0, namesNotFound: 0, others: 0, blocked: 0, errors: 0 };
  await politePool([...bySite.values()], { concurrency: Number(arg("concurrency", 6)), keyOf: (group) => group[0].key, gapMs: 0 }, async (group) => {
    for (const item of group) {
      const row = { key: item.key, url: item.url, names: item.names, foundVia: [...item.foundVia], readAt: new Date().toISOString() };
      try {
        // A link names one scholarship (or one page of them), so the bundle is kept small.
        if (item.names.length > 1) {
          Object.assign(row, await readShared(item, job));
          for (const field of ["blocked", "error", "startFailed"]) if (!row[field]) delete row[field];
          if (row.blocked) counts.blocked += 1;
          else if (row.error) counts.errors += 1;
          else { counts.read += 1; counts.scholarships += row.scholarships.length; counts.namesNotFound += row.unmatched.length; counts.others += row.others.length; }
          await job.record(row);
          counts.addresses += 1;
          if (counts.addresses % 20 === 0 || counts.addresses === addresses.length) console.log(`${counts.addresses}/${addresses.length}  ${JSON.stringify(counts)}`);
          continue;
        }
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
