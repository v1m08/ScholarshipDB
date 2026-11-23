// Build data/registry/foundations.json: community foundations and their websites.
// Three sources are merged, keyed by website host:
//   1. Wikidata (public domain): organizations classed as community foundations, plus
//      organizations whose name says "community foundation", that have a website.
//   2. Our own listing-site leads: any provider whose name reads like a community
//      foundation, with the site its scholarships were linked to.
//   3. data/registry/foundations-manual.json: ones added by hand.
// Usage: node scripts/build-foundations.mjs [--no-wikidata]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = "scholarship-directory-bot/1.0 (open-source scholarship directory)";
const readJson = async (path, fallback) => { try { return JSON.parse(await readFile(join(root, path), "utf8")); } catch { return fallback; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A name that reads like a place-based foundation, not a school's or a company's.
export const FOUNDATION_NAME = { test: (name) => /community (foundation|fund|trust)\b|\b(area|county|regional|valley) (community )?foundation\b/i.test(name) || /\bFoundation (for|of) (the )?(Greater|Northern|Southern|Eastern|Western|Central|[A-Z][a-z]+ (County|Area|Region|Valley))/.test(name) };
const NOT_COMMUNITY = /university|college|school|hospital|health system|medical center|church|library|museum|alumni|\b(inc|llc|corp)\b.*scholarship/i;
const hostOf = (url) => { try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase().replace(/^www\./, ""); } catch { return null; } };

async function wikidata() {
  const out = [];
  const sparql = 'SELECT DISTINCT ?org ?orgLabel ?site ?placeLabel WHERE { ?org wdt:P31 wd:Q1021488 ; wdt:P856 ?site . OPTIONAL { ?org wdt:P17 ?c } OPTIONAL { ?org wdt:P159 ?place } FILTER(!BOUND(?c) || ?c = wd:Q30) SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }';
  const response = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}`, { headers: { "user-agent": AGENT, accept: "application/sparql-results+json" }, signal: AbortSignal.timeout(90000) });
  if (response.ok) for (const row of (await response.json()).results.bindings) out.push({ name: row.orgLabel.value, website: row.site.value, place: row.placeLabel?.value || null, wikidata: row.org.value.split("/").pop() });
  // Name search: items titled "... community foundation ..." that have a website and are in the US.
  const ids = [];
  for (let offset = 0; offset < 2000; offset += 50) {
    const url = `https://www.wikidata.org/w/api.php?action=query&list=search&format=json&srlimit=50&sroffset=${offset}&srsearch=${encodeURIComponent('"community foundation" haswbstatement:P856 haswbstatement:P17=Q30')}`;
    const page = await (await fetch(url, { headers: { "user-agent": AGENT }, signal: AbortSignal.timeout(30000) })).json();
    const hits = page.query?.search || [];
    ids.push(...hits.map((hit) => hit.title));
    if (hits.length < 50) break;
    await sleep(500);
  }
  for (let i = 0; i < ids.length; i += 50) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|claims&languages=en&ids=${ids.slice(i, i + 50).join("|")}`;
    const page = await (await fetch(url, { headers: { "user-agent": AGENT }, signal: AbortSignal.timeout(30000) })).json();
    for (const [id, entity] of Object.entries(page.entities || {})) {
      const name = entity.labels?.en?.value;
      const website = entity.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      if (name && website && /community foundation/i.test(name)) out.push({ name, website, place: null, wikidata: id });
    }
    await sleep(500);
  }
  return out;
}

async function fromLeads() {
  const out = [];
  let text = "";
  try { text = await readFile(join(root, "data", "raw", "listing-sites", "results.jsonl"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    for (const lead of JSON.parse(line).leads || []) {
      if (!lead.provider || !lead.url || !FOUNDATION_NAME.test(lead.provider) || NOT_COMMUNITY.test(lead.provider)) continue;
      const host = hostOf(lead.url);
      // A foundation's scholarships are sometimes hosted on an application portal; that is not its website.
      if (!host || /academicworks|awardspring|smarterselect|grantinterface|communityforce|kaleidoscope|google|forms\./.test(host)) continue;
      out.push({ name: lead.provider, website: `https://${host}/`, scholarshipPage: lead.url });
    }
  }
  return out;
}

async function main() {
  const existing = (await readJson("data/registry/foundations.json", { foundations: [] })).foundations;
  const manual = (await readJson("data/registry/foundations-manual.json", { foundations: [] })).foundations;
  const fresh = process.argv.includes("--no-wikidata") ? [] : await wikidata().catch((error) => { console.log(`Wikidata unavailable (${error.message}); keeping what is already in the file`); return []; });
  const leads = await fromLeads();
  const byHost = new Map();
  const put = (entry, source) => {
    const host = hostOf(entry.website);
    if (!host || NOT_COMMUNITY.test(entry.name)) return;
    const current = byHost.get(host) || { name: entry.name, website: `https://${host}/`, host, place: null, sources: [], scholarshipPages: [] };
    current.place ||= entry.place || null;
    if (entry.wikidata) current.wikidata = entry.wikidata;
    for (const tag of entry.sources || [source]) if (!current.sources.includes(tag)) current.sources.push(tag);
    for (const page of entry.scholarshipPages || (entry.scholarshipPage ? [entry.scholarshipPage] : [])) if (!current.scholarshipPages.includes(page) && current.scholarshipPages.length < 5) current.scholarshipPages.push(page);
    byHost.set(host, current);
  };
  existing.forEach((entry) => put(entry, "earlier"));
  fresh.forEach((entry) => put(entry, "wikidata"));
  leads.forEach((entry) => put(entry, "listing-leads"));
  manual.forEach((entry) => put(entry, "manual"));
  const foundations = [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name));
  const file = { note: "Community foundations and their websites. Built by scripts/build-foundations.mjs from Wikidata, our own listing-site leads and foundations-manual.json. Not a complete list of US community foundations.", builtAt: new Date().toISOString().slice(0, 10), count: foundations.length, foundations };
  await writeFile(join(root, "data", "registry", "foundations.json"), `${JSON.stringify(file, null, 1)}\n`);
  const bySource = {};
  for (const entry of foundations) for (const source of entry.sources) bySource[source] = (bySource[source] || 0) + 1;
  console.log(`${foundations.length} foundations in data/registry/foundations.json`, bySource);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
