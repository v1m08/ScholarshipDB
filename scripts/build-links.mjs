// Build data/links/links.json: every scholarship we know exists and the page to read it
// from. Gathers the portal walk, Scholarship America, the gold set, and names from the old
// BigFuture catalog; merges them with what is already in the file; removes duplicates.
// Usage: node scripts/build-links.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLinks } from "../crawler/lib/links.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(join(root, path), "utf8")); } catch { return fallback; } };
const readLines = async (path) => { try { return (await readFile(join(root, path), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

const incoming = [];
const counts = {};
const add = (source, entry) => { incoming.push({ ...entry, foundVia: [source] }); counts[source] = (counts[source] || 0) + 1; };

// Portals: later lines win, so a re-walked portal replaces its earlier result.
const portals = new Map((await readLines("data/raw/portal-links/results.jsonl")).map((row) => [row.key, row]));
for (const portal of portals.values()) {
  for (const award of portal.awards || []) {
    add(`${portal.platform}-portal`, {
      url: award.url,
      name: award.title,
      // A scholarship in the "outside organizations" list is not the school's own.
      provider: award.external ? null : portal.portalName || null,
      platform: portal.platform,
      unitids: portal.unitids,
      external: award.external,
      hints: { amountText: award.amountText, statusText: award.statusText, snippet: award.snippet, listedBy: portal.portalName || portal.key },
    });
  }
}
for (const row of await readLines("data/raw/scholarship-america/results.jsonl")) {
  add("scholarship-america", { url: row.url, name: row.name, platform: "scholarship-america" });
}
for (const record of (await readJson("data/gold/gold-set.json", { records: [] })).records) {
  const url = (record.labeledFrom || []).find((value) => /^https?:\/\/\S+$/.test(value)) || record.homepage;
  if (url) add("gold-set", { url, name: record.title, provider: record.provider });
}
// The old catalog's addresses point at BigFuture, not the provider, so only names are taken.
for (const record of await readJson("data/scholarships.json", [])) {
  add("bigfuture", { name: record.title, provider: record.provider });
}

const path = "data/links/links.json";
const links = mergeLinks(await readJson(path, []), incoming);
await mkdir(join(root, "data", "links"), { recursive: true });
// One entry per line keeps the file readable and its history small.
await writeFile(join(root, path), `[\n${links.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`);

const byStatus = {};
for (const entry of links) byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
console.log("Found this run:", counts);
console.log(`${links.length} entries in ${path}`, byStatus);
console.log(`Found through more than one source: ${links.filter((entry) => entry.foundVia.length > 1).length}`);
