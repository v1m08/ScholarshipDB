// Job 12: one click deeper for scholarships we know only by name.
// Reads data/records/bare.jsonl (written by scripts/build-records.mjs): each name, the page it
// was seen on, and whose scholarship it is. For every such page:
//   1. fetch the page again;
//   2. where a link on it is named after the scholarship, read what the link leads to,
//      a page or a PDF (PDF text needs the `pdftotext` program: apt install poppler-utils);
//   3. otherwise keep the lines that follow the name on the page itself, when there are any.
// Writes data/raw/deeper/results.jsonl, one line per page: the names found with their text,
// and the names still bare. robots.txt is obeyed; a site that refuses is recorded and left alone.
// Usage: node fetch-deeper.mjs [--limit 40] [--concurrency 8] [--retry-errors]
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanLines, decodeEntities } from "./lib/clean.mjs";
import { closeBrowser, fetchPage, politePool, USER_AGENT } from "./lib/fetcher.mjs";
import { core, nameKey } from "./lib/named-reader.mjs";
import { parseRobots } from "./lib/robots.mjs";
import { wholePage } from "./lib/school-pages.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PDF = /\.pdf(\?|#|$)/i;
const NOT_READABLE = /\.(docx?|xlsx?|pptx?|jpe?g|png|gif|zip|mp4)(\?|#|$)|^mailto:|^tel:|^javascript:/i;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_LINKS_PER_PAGE = 150;
const bare = (url) => url.replace(/#.*$/, "").replace(/\/$/, "");

// One site's rules, fetched once.
const siteCache = new Map();
function siteFor(origin) {
  if (!siteCache.has(origin)) {
    siteCache.set(origin, (async () => {
      let text = "";
      try { const response = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) }); if (response.ok) text = await response.text(); } catch { /* no robots file */ }
      const robots = parseRobots(text);
      return { robots, gapMs: Math.max(500, Math.min(robots.crawlDelay, 5) * 1000) };
    })());
  }
  return siteCache.get(origin);
}
async function allowed(url) {
  const parsed = new URL(url);
  const site = await siteFor(parsed.origin);
  if (!site.robots.allowed(`${parsed.pathname}${parsed.search}`)) return false;
  await sleep(site.gapMs);
  return true;
}
async function readPage(url) {
  if (!(await allowed(url))) return { skipped: "robots" };
  const page = await fetchPage(url, { render: "auto" });
  if ([401, 403, 405, 429].includes(page.status)) return { skipped: `refused (HTTP ${page.status})` };
  if (page.status >= 400) return { skipped: `HTTP ${page.status}` };
  return page;
}

// The text of a PDF, as lines. Null when the file is not a PDF, too large, or has no text layer.
let pdfProgramMissing = false;
function pdfToText(buffer) {
  return new Promise((resolve) => {
    if (pdfProgramMissing) return resolve(null);
    const child = execFile("pdftotext", ["-q", "-enc", "UTF-8", "-l", "12", "-", "-"], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (error, stdout) => {
      if (error?.code === "ENOENT") pdfProgramMissing = true;
      resolve(error ? null : stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}
async function readPdf(url) {
  if (!(await allowed(url))) return { skipped: "robots" };
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(40000) });
  if (!response.ok) return { skipped: `HTTP ${response.status}` };
  if (Number(response.headers.get("content-length") || 0) > MAX_PDF_BYTES) return { skipped: "PDF too large" };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) return { skipped: "PDF too large" };
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return { skipped: "not a PDF" };
  const text = await pdfToText(buffer);
  if (text === null) return { skipped: pdfProgramMissing ? "pdftotext is not installed" : "PDF could not be read" };
  const lines = text.split(/\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length >= 3);
  if (lines.join(" ").length < 80) return { skipped: "PDF has no text (a scan)" };
  return { lines };
}

// Every link on a page: where it goes and the words it shows.
export function linksOn(html, pageUrl) {
  const out = [];
  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(decodeEntities(match[1].trim()), pageUrl).href; } catch { continue; }
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text && /^https?:/.test(url)) out.push({ url, text, key: nameKey(text) });
  }
  return out;
}
// The link named after a scholarship: its words are the name, or the name with a few more
// ("Smith Scholarship application", "Smith Scholarship (PDF)").
export function linkFor(name, links, pageUrl) {
  const key = nameKey(name);
  if (key.length < 6) return null;
  const elsewhere = links.filter((link) => bare(link.url) !== bare(pageUrl) && !NOT_READABLE.test(link.url));
  return elsewhere.find((link) => link.key === key) || elsewhere.find((link) => link.key.startsWith(`${key} `) && link.key.length <= key.length + 30) || null;
}
// A short line that names an award and is not a sentence: the next entry of a list.
const ANOTHER_AWARD = /^(?=.{6,90}$)(?!.*[.;!?]$)(?!.*\b(is|are|was|were|will|must|may|provides?|awarded|established|supports?)\b).*\b(scholarships?|awards?|funds?|grants?|fellowships?|prizes?|bursar(y|ies)|endowments?)\b/i;
const PERSON = /^(?:(?:Dr|Mr|Mrs|Ms)\.? )?(?:[A-Z][a-zA-Z'’.-]*,? ){1,4}[A-Z][a-zA-Z'’-]+(?:,? (?:Jr|Sr|II|III|IV)\.?)?$/;
// The lines that follow a name on the page it is listed on, up to the next entry.
export function linesAfter(name, lines, otherNames) {
  const key = nameKey(name);
  if (key.length < 6) return null;
  const strip = (line) => line.replace(/^[#-] /, "");
  const at = lines.findIndex((line) => { const lineKey = nameKey(strip(line)); return lineKey === key || lineKey.startsWith(`${key} `); });
  if (at < 0) return null;
  const first = lines[at];
  const kind = first.startsWith("# ") ? "heading" : first.startsWith("- ") ? "item" : "plain";
  const out = [strip(first)];
  let size = 0;
  for (const line of lines.slice(at + 1, at + 25)) {
    if (line.startsWith("# ")) break;
    if (kind === "item" && line.startsWith("- ") && !/[.;:]\s|\.$/.test(line)) break;
    if (otherNames.has(nameKey(strip(line))) || ANOTHER_AWARD.test(strip(line))) break;
    // A person's name on its own line is a past recipient: never kept.
    if (PERSON.test(strip(line))) continue;
    out.push(strip(line));
    size += line.length;
    if (size > 2500) break;
  }
  const own = out.join(" ").length - name.length;
  return own >= 80 ? out : null;
}

// Is this text about the scholarship of that name? Most of the name's own words must be in it.
export function mentions(name, text) {
  const words = [...new Set(core(name).split(" ").filter((word) => word.length > 2))];
  if (!words.length) return false;
  const hay = ` ${nameKey(text)} `;
  return words.filter((word) => hay.includes(` ${word} `)).length / words.length >= 0.6;
}

async function deeperOne(group, job, listPages) {
  const row = { key: group.url, url: group.url, readAt: new Date().toISOString(), found: [], missing: [], fetched: 0, skipped: {} };
  let page;
  try { page = await readPage(group.url); } catch (error) { page = { skipped: error.message.split("\n")[0].slice(0, 60) }; }
  if (page.skipped) {
    row[/robots|refused/.test(page.skipped) ? "blocked" : "error"] = page.skipped;
    row.missing = group.items.map((item) => item.name);
    return row;
  }
  const pageUrl = page.finalUrl || group.url;
  const lines = cleanLines(page.html);
  row.text = await job.savePage(lines.join("\n"));
  const links = linksOn(page.html, pageUrl);
  const names = new Set(group.items.map((item) => nameKey(item.name)));
  // A link that several names point to is a shared document, not any one scholarship's page.
  const targets = new Map();
  for (const item of group.items) { const link = linkFor(item.name, links, pageUrl); if (link) targets.set(item, link); }
  const uses = new Map();
  for (const link of targets.values()) uses.set(bare(link.url), (uses.get(bare(link.url)) || 0) + 1);
  const skip = (why) => { row.skipped[why] = (row.skipped[why] || 0) + 1; };
  for (const item of group.items) {
    const link = targets.get(item);
    const entry = { name: item.name, context: item.context };
    if (link && uses.get(bare(link.url)) === 1 && row.fetched < MAX_LINKS_PER_PAGE) {
      row.fetched += 1;
      try {
        if (PDF.test(link.url)) {
          const pdf = await readPdf(link.url);
          if (pdf.lines && mentions(item.name, pdf.lines.join(" "))) { row.found.push({ ...entry, how: "linked-pdf", url: link.url, text: pdf.lines.slice(0, 200) }); continue; }
          skip(pdf.skipped || "PDF is not about this scholarship");
        } else {
          const next = await readPage(link.url);
          if (next.skipped) skip(next.skipped);
          // A link that was really a PDF behind a plain address.
          else if (next.html.startsWith("%PDF-")) skip("PDF behind a plain address");
          else {
            const landed = next.finalUrl || link.url;
            const whole = wholePage(cleanLines(next.html), landed);
            // A link that lands on a list of scholarships, or on a page that never names this one, is not its page.
            if (listPages.has(bare(landed)) || new URL(landed).pathname.length <= 1) skip("link leads to a list or a home page");
            else if (whole && !mentions(item.name, `${whole.title || ""} ${whole.text.join(" ")}`)) skip("linked page is not about this scholarship");
            else if (whole) { row.found.push({ ...entry, how: "linked-page", url: whole.url, title: whole.title, metadata: whole.metadata, text: whole.text }); continue; }
            skip("linked page says nothing");
          }
        }
      } catch (error) { skip(error.message.split("\n")[0].slice(0, 40)); }
    }
    const others = new Set([...names].filter((key) => key !== nameKey(item.name)));
    const own = linesAfter(item.name, lines, others);
    if (own) row.found.push({ ...entry, how: "same-page", url: pageUrl, text: own });
    else row.missing.push(item.name);
  }
  return row;
}

async function main() {
  let items;
  try { items = (await readFile(join(repoRoot, "data", "records", "bare.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { console.error("No list. Run: node scripts/build-records.mjs"); process.exit(1); }
  const byPage = new Map();
  for (const item of items) {
    const url = item.url || item.page;
    try { if (!/^https?:$/.test(new URL(url).protocol)) continue; } catch { continue; }
    if (!byPage.has(url)) byPage.set(url, { url, items: [] });
    byPage.get(url).items.push(item);
  }
  let groups = [...byPage.values()];
  const limit = Number(arg("limit", 0));
  if (limit) { const step = Math.max(1, Math.floor(groups.length / limit)); groups = groups.filter((_, index) => index % step === 0).slice(0, limit); }
  const listPages = new Set([...byPage.values()].filter((group) => group.items.length > 1).map((group) => bare(group.url)));
  const job = await openJob("deeper");
  const total = groups.length;
  groups = groups.filter((group) => { const previous = job.done.get(group.url); return !previous || (process.argv.includes("--retry-errors") && previous.error); });
  console.log(`${total} pages selected, ${total - groups.length} already done, ${groups.length} to read`);

  // One site's pages are read one after another, never by two workers at once.
  const bySite = new Map();
  for (const group of groups) { const host = new URL(group.url).host.replace(/^www\./, ""); if (!bySite.has(host)) bySite.set(host, []); bySite.get(host).push(group); }
  const counts = { pages: 0, names: 0, linkedPage: 0, linkedPdf: 0, samePage: 0, stillBare: 0, blocked: 0, errors: 0 };
  await politePool([...bySite.values()], { concurrency: Number(arg("concurrency", 8)), keyOf: (list) => list[0].url, gapMs: 0 }, async (list) => {
    for (const group of list) {
      let row;
      try { row = await deeperOne(group, job, listPages); }
      catch (error) { row = { key: group.url, url: group.url, readAt: new Date().toISOString(), error: error.message.split("\n")[0].slice(0, 120), found: [], missing: group.items.map((item) => item.name) }; }
      if (row.blocked) counts.blocked += 1;
      else if (row.error) counts.errors += 1;
      counts.names += group.items.length;
      for (const found of row.found) counts[found.how === "linked-page" ? "linkedPage" : found.how === "linked-pdf" ? "linkedPdf" : "samePage"] += 1;
      counts.stillBare += row.missing.length;
      await job.record(row);
      counts.pages += 1;
      if (counts.pages % 25 === 0 || counts.pages === groups.length) console.log(`${counts.pages}/${groups.length}  ${JSON.stringify(counts)}`);
    }
    try { siteCache.delete(new URL(list[0].url).origin); } catch { /* not an address */ }
  });
  await closeBrowser();
  console.log(`Done. ${JSON.stringify(counts)}${pdfProgramMissing ? "  (PDFs were skipped: pdftotext is not installed)" : ""}  Results: data/raw/deeper/results.jsonl`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
