// How good is what we scraped? For every scholarship any crawl has seen, decide whether the
// page was read properly, and if not, what has to happen: fetch it again, find a better page,
// or only read the saved text again with a better reader.
//
// Reads data/raw/*/results.jsonl. Writes (git-ignored):
//   data/records/audit.json       counts per source and per verdict, and which facts are missing
//   data/records/rescrape.jsonl   one line per address that needs fetching again, with the reason
//
// Usage: node --max-old-space-size=6000 scripts/audit-quality.mjs [--samples 5]
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const today = new Date().toISOString().slice(0, 10);

// What has to happen next, in the order the work should be done.
export const VERDICTS = {
  "refused": "site refuses crawlers (left alone)",
  "dead": "address is dead or failed (find the new address)",
  "not-opened": "its own page was never opened (fetch it)",
  "not-rendered": "page came back nearly empty (fetch again with a browser)",
  "wrong-page": "listed name is not on the provider's site (find the right page)",
  "bare-list": "only a name on a list (find its own page, or use the tax filing)",
  "no-facts": "text was read but no fact came out (read again with a model)",
  "partial": "some facts, key ones missing (read again with a model)",
  "stale": "complete, but the deadline has passed (fetch again next cycle)",
  "complete": "amount, deadline and eligibility all stated",
};
const FETCH_AGAIN = new Set(["dead", "not-opened", "not-rendered", "wrong-page", "bare-list"]);

const stated = (entry) => Boolean(entry) && !entry.assumed && entry.value !== null && entry.value !== undefined && !(Array.isArray(entry.value) && !entry.value.length) && entry.value !== false;
// The four things a student needs before applying, and the metadata that answers each.
const GROUPS = {
  amount: ["awardMaximum", "awardMinimum", "awardType"],
  deadline: ["deadline"],
  eligibility: ["minimumGpa", "gradeLevels", "fieldsOfStudy", "citizenship", "need", "enrollment"],
  requirements: ["essay", "recommendations", "transcript", "interview", "nomination"],
};
export function factGroups(metadata) {
  const have = {};
  for (const [group, fields] of Object.entries(GROUPS)) have[group] = fields.some((field) => stated(metadata?.[field]) && metadata[field].value !== "no" && metadata[field].value !== "either");
  return have;
}

// One scholarship's verdict from what the crawl recorded about it.
export function verdictFor({ metadata, linkOnly, nameOnly, pageLines, method }) {
  if (linkOnly) return { verdict: "not-opened", missing: Object.keys(GROUPS) };
  // A page read without a browser that has almost no text is usually one that draws itself with scripts.
  if (pageLines !== undefined && pageLines !== null && pageLines < 12 && method !== "browser") return { verdict: "not-rendered", missing: Object.keys(GROUPS) };
  if (nameOnly || !metadata) return { verdict: "bare-list", missing: Object.keys(GROUPS) };
  const have = factGroups(metadata);
  const missing = Object.keys(GROUPS).filter((group) => !have[group]);
  if (missing.length === Object.keys(GROUPS).length) return { verdict: "no-facts", missing };
  if (!have.amount || !have.deadline || !have.eligibility) return { verdict: "partial", missing };
  const deadline = metadata.deadline?.value;
  return { verdict: typeof deadline === "string" && deadline < today ? "stale" : "complete", missing };
}

async function* rows(job) {
  const path = join(root, "data", "raw", job, "results.jsonl");
  if (!existsSync(path)) return;
  // Later lines replace earlier ones for the same key, as in the builder.
  const latest = new Map();
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); latest.set(row.key, line); } catch { /* a cut-off line */ }
  }
  for (const line of latest.values()) yield JSON.parse(line);
}

async function main() {
  const audit = { builtAt: today, verdicts: VERDICTS, sources: {}, skippedPages: {} };
  const rescrape = [];
  const samples = {};
  const sampleSize = Number(arg("samples", 0));
  const count = (source, name, url, result, how) => {
    const tally = (audit.sources[source] ||= { scholarships: 0, verdicts: {}, missing: { amount: 0, deadline: 0, eligibility: 0, requirements: 0 } });
    tally.scholarships += 1;
    tally.verdicts[result.verdict] = (tally.verdicts[result.verdict] || 0) + 1;
    for (const group of result.missing) tally.missing[group] += 1;
    if (FETCH_AGAIN.has(result.verdict) && url) rescrape.push({ source, name, url, reason: result.verdict, how });
    if (sampleSize) { const list = (samples[`${source}|${result.verdict}`] ||= []); if (list.length < 400) list.push({ name, url }); }
  };
  const pageIndex = (pages) => new Map((pages || []).filter((page) => !page.skipped).map((page) => [page.url, page]));
  const noteSkipped = (pages) => { for (const page of pages || []) if (page.skipped) { const reason = page.skipped.replace(/\d+/g, "N").slice(0, 40); audit.skippedPages[reason] = (audit.skippedPages[reason] || 0) + 1; } };
  const fromOrg = (source, row, list) => {
    const pages = pageIndex(row.pages);
    for (const found of list || []) {
      const page = pages.get(found.url);
      count(source, found.name, found.url, verdictFor({ metadata: found.metadata, linkOnly: found.linkOnly, nameOnly: found.nameOnly, pageLines: page?.lines, method: page?.method }), found.linkOnly ? "fetch" : page && page.lines < 12 ? "browser" : "find-page");
    }
  };

  // School portals: one structured page per scholarship.
  for await (const row of rows("portal-awards")) {
    if (row.error || row.blocked || !row.record) { count("school-portal", row.key, row.url, { verdict: row.blocked ? "refused" : "dead", missing: Object.keys(GROUPS) }, "fetch"); continue; }
    count("school-portal", row.record.name, row.url, verdictFor({ metadata: row.record.metadata }), "fetch");
  }
  for await (const row of rows("school-pages")) { noteSkipped(row.pages); fromOrg("school-website", row, row.scholarships); }
  for await (const row of rows("foundation-pages")) {
    noteSkipped(row.pages);
    if (row.blocked || row.error) { count("foundation-website", row.name, row.start, { verdict: row.blocked ? "refused" : "dead", missing: Object.keys(GROUPS) }, "fetch"); continue; }
    fromOrg("foundation-website", row, row.scholarships);
  }
  // Leads from listing sites, read on the provider's own site.
  for await (const row of rows("link-sites")) {
    noteSkipped(row.pages);
    const names = row.names || [];
    if (row.blocked || row.error) {
      for (const name of names) count("provider-website", name, row.url, { verdict: row.blocked ? "refused" : "dead", missing: Object.keys(GROUPS) }, "find-page");
      continue;
    }
    if (row.shared) {
      for (const name of row.unmatched || []) count("provider-website", name, row.url, { verdict: "wrong-page", missing: Object.keys(GROUPS) }, "find-page");
      fromOrg("provider-website", row, row.scholarships);
      fromOrg("provider-website (not listed anywhere)", row, row.others);
      continue;
    }
    const read = (row.scholarships || [])[0];
    for (const name of names) {
      if (!read) { count("provider-website", name, row.url, { verdict: "not-rendered", missing: Object.keys(GROUPS) }, "browser"); continue; }
      const thin = (read.digestTokens ?? 999) < 40;
      count("provider-website", name, row.url, thin && !Object.values(factGroups(read.metadata)).some(Boolean) ? { verdict: "not-rendered", missing: Object.keys(GROUPS) } : verdictFor({ metadata: read.metadata }), thin ? "browser" : "find-page");
    }
  }

  audit.total = { scholarships: 0, verdicts: {} };
  for (const tally of Object.values(audit.sources)) {
    audit.total.scholarships += tally.scholarships;
    for (const [verdict, number] of Object.entries(tally.verdicts)) audit.total.verdicts[verdict] = (audit.total.verdicts[verdict] || 0) + number;
  }
  // The same address can be named by many scholarships; it is fetched once.
  const addresses = new Map();
  for (const item of rescrape) { const have = addresses.get(item.url) || { url: item.url, source: item.source, reasons: {}, names: 0 }; have.reasons[item.reason] = (have.reasons[item.reason] || 0) + 1; have.names += 1; addresses.set(item.url, have); }
  audit.rescrape = { scholarships: rescrape.length, addresses: addresses.size };
  audit.skippedPages = Object.fromEntries(Object.entries(audit.skippedPages).sort((a, b) => b[1] - a[1]).slice(0, 15));

  await mkdir(join(root, "data", "records"), { recursive: true });
  await writeFile(join(root, "data", "records", "audit.json"), `${JSON.stringify(audit, null, 1)}\n`);
  await writeFile(join(root, "data", "records", "rescrape.jsonl"), [...addresses.values()].map((item) => JSON.stringify(item)).join("\n") + "\n");
  console.log(JSON.stringify(audit, null, 1));
  if (sampleSize) {
    for (const [key, list] of Object.entries(samples)) {
      const step = Math.max(1, Math.floor(list.length / sampleSize));
      console.log(`\n-- ${key}`);
      for (const item of list.filter((_, index) => index % step === 0).slice(0, sampleSize)) console.log(`   ${item.name}  ${item.url || ""}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
