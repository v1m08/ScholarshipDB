// Build the clean rows that go into the database, from what the crawl jobs wrote.
// Writes data/records/schools.jsonl, scholarships.jsonl, evidence.jsonl and summary.json.
// Every row passes the rules in database/schema.sql (see database/clean-record.mjs).
//
// Sources, strongest first (when two describe the same scholarship the stronger one is kept):
//   school-portal        award pages on school application portals (data/raw/portal-awards)
//   provider-website     listing-site leads read on the provider's own site (data/raw/link-sites)
//   foundation-website   community foundations' sites (data/raw/foundation-pages)
//   school-website       schools' own scholarship pages (data/raw/school-pages, and leads on .edu sites)
// From the three website sources only scholarships with at least one fact read from the page
// are kept; a bare name waits for a later pass. Left out for now: awards a portal lists for
// outside organizations, and portals shared by several schools.
// Usage: node scripts/build-records.mjs
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { normalizeUrl } from "../crawler/lib/links.mjs";
import { core } from "../crawler/lib/named-reader.mjs";
import { createHash } from "node:crypto";
import { acceptedFields, cleanRecord, idFor, nameKey } from "../database/clean-record.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
async function* lines(path) {
  if (!existsSync(join(root, path))) return;
  const reader = createInterface({ input: createReadStream(join(root, path)) });
  for await (const line of reader) if (line.trim()) { try { yield JSON.parse(line); } catch { /* a half-written last line */ } }
}
// Later lines replace earlier ones for the same key (a re-read replaces the first read).
async function latest(path) {
  const rows = new Map();
  for await (const row of lines(path)) rows.set(row.key, row);
  return [...rows.values()];
}
const baseDomain = (host) => host.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
const https = (url) => String(url || "").replace(/^http:\/\//i, "https://");

// ------------------------------------------------------------------ schools
const registry = JSON.parse(await readFile(join(root, "data", "registry", "institutions.json"), "utf8"));
const institutions = Array.isArray(registry) ? registry : registry.institutions;
const schools = new Map();
const schoolsByDomain = new Map();
for (const school of institutions) {
  const website = school.website ? `https://${school.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")}` : null;
  schools.set(String(school.unitid), {
    unitid: Number(school.unitid),
    name: school.name.replace(/\s+/g, " ").trim(),
    city: school.city || null,
    state: /^[A-Z]{2}$/.test(school.state || "") ? school.state : null,
    level: ["less-than-two-year", "two-year", "four-year"].includes(school.level) ? school.level : null,
    control: ["public", "private-nonprofit", "private-for-profit"].includes(school.control) ? school.control : null,
    website: website && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(website) ? website : null,
  });
  if (school.domain) { const list = schoolsByDomain.get(school.domain) || []; list.push(String(school.unitid)); schoolsByDomain.set(school.domain, list); }
}

// ------------------------------------------------------------------ fields of study we trust
const fieldCounts = new Map();
for await (const result of lines("data/raw/portal-awards/results.jsonl")) {
  for (const field of result.record?.metadata?.fieldsOfStudy?.value || []) { const key = String(field).toLowerCase().trim(); fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1); }
}
const knownFields = acceptedFields(fieldCounts);

// ------------------------------------------------------------------ collecting
const summary = { sources: {}, fieldsOfStudyAccepted: knownFields.size };
const tally = (source) => (summary.sources[source] ||= { read: 0, kept: 0, leftOut: {} });
const candidates = [];
const MIN_TEXT = 150;
const tidy = (line) => String(line || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
// At most 6,000 characters of a scholarship's own lines.
function textOf(lines) {
  const out = [];
  let size = 0;
  for (const line of (lines || []).map(tidy).filter(Boolean)) { if (size + line.length > 6000) break; out.push(line); size += line.length; }
  return out;
}
// Clean one scholarship and keep it, or count why it was left out.
function take(source, raw, context, { needsFact = true } = {}) {
  const counts = tally(source);
  counts.read += 1;
  const leave = (reason) => { counts.leftOut[reason] = (counts.leftOut[reason] || 0) + 1; };
  if (typeof raw === "string") return leave(raw);
  const cleaned = cleanRecord(raw, { ...context, knownFields });
  if (cleaned.rejected) return leave(cleaned.rejected);
  // The words kept for this scholarship, for the criteria reader (scripts/extract-criteria.mjs).
  cleaned.text = textOf(raw.text);
  cleaned.hasFact = cleaned.row.stated_fields.some((field) => field !== "tags");
  cleaned.funderEin = context.funderEin || null;
  // A keyword tag alone ("leadership") is too thin to count as a fact about the scholarship;
  // without a fact there must at least be a paragraph of its own text to read.
  if (needsFact && !cleaned.hasFact && cleaned.text.join(" ").length < MIN_TEXT) return leave("name only (no fact and no text of its own)");
  counts.kept += 1;
  candidates.push(cleaned);
}

// 1. School portals.
const portalSchool = new Map();
for await (const portal of lines("data/raw/portal-links/results.jsonl")) portalSchool.set(portal.key, portal.unitids || []);
for (const result of await latest("data/raw/portal-awards/results.jsonl")) {
  const record = result.record;
  if (!record) { take("school-portal", result.error ? "page could not be read" : "page had no scholarship"); continue; }
  if (record.external) { take("school-portal", "outside organization (read from its own site instead)"); continue; }
  const unitids = portalSchool.get(new URL(record.url).host) || [];
  if (unitids.length !== 1 || !schools.has(unitids[0])) { take("school-portal", unitids.length > 1 ? "portal shared by several schools" : "school not identified"); continue; }
  const school = schools.get(unitids[0]);
  take("school-portal", { url: record.url, name: record.name, metadata: record.metadata, checkedAt: result.readAt, text: [...Object.entries(record.fields || {}).map(([label, value]) => `${label}: ${value}`), ...(result.description || [])] }, { scope: "school", source: "school-portal", providerName: school.name, schoolUnitid: school.unitid }, { needsFact: false });
}

// Pages that list other organizations' scholarships are not the school's own awards.
const OUTSIDE_PAGE = /outside|external|private|non-?institutional|third-?party|community-scholarships|other-scholarships/i;

// 2. Schools' own websites.
for (const result of await latest("data/raw/school-pages/results.jsonl")) {
  const school = schools.get(String(result.key));
  for (const found of result.scholarships || []) {
    if (!school) { take("school-website", "school not identified"); continue; }
    if (!found.metadata && !found.text?.length) { take("school-website", "name only (no fact and no text of its own)"); continue; }
    if (OUTSIDE_PAGE.test(found.url)) { take("school-website", "listed on a page of outside scholarships"); continue; }
    take("school-website", { url: https(found.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: !found.ownPage }, { scope: "school", source: "school-website", providerName: school.name, schoolUnitid: school.unitid });
  }
}

// 3. Community foundations.
// Funders known from IRS filings (scripts/build-funders.mjs), by EIN.
const funders = new Map();
for await (const funder of lines("data/records/funders.jsonl")) funders.set(funder.ein, funder);
const funderByHost = new Map();
for (const funder of funders.values()) if (funder.host && (!funderByHost.has(funder.host) || funder.scholarship_dollars > funderByHost.get(funder.host).scholarship_dollars)) funderByHost.set(funder.host, funder);
const einsWithPages = new Set();
const foundationName = new Map();
for (const job of ["foundation-pages", "funder-pages"]) {
  for (const result of await latest(`data/raw/${job}/results.jsonl`)) {
    const funder = funders.get(result.ein) || funderByHost.get(String(result.key).replace(/^www\./, "")) || null;
    foundationName.set(String(result.key).replace(/^www\./, ""), result.name);
    for (const found of result.scholarships || []) {
      if (!found.metadata && !found.text?.length) { take("foundation-website", "name only (no fact and no text of its own)"); continue; }
      const before = candidates.length;
      take("foundation-website", { url: https(found.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: !found.ownPage }, { scope: "open", source: "foundation-website", providerName: result.name, funderEin: funder?.ein });
      if (funder && candidates.length > before) einsWithPages.add(funder.ein);
    }
  }
}

// 4. Listing-site leads, read on the provider's own site. The lead's provider comes from the links list.
const leadProvider = new Map();
if (existsSync(join(root, "data", "links", "links.json"))) {
  for (const entry of JSON.parse(await readFile(join(root, "data", "links", "links.json"), "utf8"))) {
    if (!entry.url || !entry.name || entry.platform === "academicworks") continue;
    try { leadProvider.set(`${normalizeUrl(entry.url)}|${entry.name}`, entry.provider || null); } catch { /* unusable address */ }
  }
}
// A lead on a school's site is that school's scholarship; anywhere else it is open to anyone.
const LISTING_HOST = /(^|\.)(collegexpress|fastweb|scholarships|niche|collegeboard|unigo|cappex|scholarshipowl|bold|internationalstudent|careeronestop|goingmerry|petersons|collegescholarships|scholarshipamerica)\.(com|org)$/i;
function leadContext(url, provider) {
  let host;
  try { host = new URL(url).host; } catch { return "bad address"; }
  if (/\.edu$/i.test(host)) {
    const unitids = schoolsByDomain.get(baseDomain(host)) || [];
    if (unitids.length !== 1) return "school not identified";
    const school = schools.get(unitids[0]);
    return { scope: "school", source: "school-website", providerName: school.name, schoolUnitid: school.unitid };
  }
  // A listing site is where a lead came from, never the scholarship's own page.
  if (LISTING_HOST.test(host)) return "address is a listing site, not the provider";
  // Some schools keep their scholarship list on a vendor's address: <school>.scholarships.ngwebsolutions.com.
  const vendor = host.match(/^([a-z0-9-]+)\.scholarships\.ngwebsolutions\.com$/i);
  if (vendor) {
    const unitids = schoolsByDomain.get(`${vendor[1].toLowerCase()}.edu`) || [];
    if (unitids.length !== 1) return "school not identified";
    const school = schools.get(unitids[0]);
    return { scope: "school", source: "school-website", providerName: school.name, schoolUnitid: school.unitid };
  }
  if (!provider) return "no provider";
  return { scope: "open", source: "provider-website", providerName: provider.replace(/\s+/g, " ").trim() };
}
for (const result of await latest("data/raw/link-sites/results.jsonl")) {
  if (result.blocked || result.error) { for (const name of result.names || []) take("provider-website", result.blocked ? "site refuses crawlers" : "page could not be read"); continue; }
  if (result.shared) {
    // Several names on one address: each was looked for on the site's pages.
    for (const name of result.unmatched || []) take("provider-website", "name not found on the provider's site");
    for (const found of result.scholarships || []) {
      const context = leadContext(result.url, leadProvider.get(`${result.key}|${found.name}`));
      if (typeof context === "string") { take("provider-website", context); continue; }
      if (!found.metadata && !found.text?.length) { take(context.source === "school-website" ? "school-website" : "provider-website", "name only (no fact and no text of its own)"); continue; }
      take(context.source === "school-website" ? "school-website" : "provider-website", { url: https(found.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: found.how !== "own-page" }, context);
    }
    // Other scholarships the same pages describe, which no listing site named. They belong to
    // the school on a school's site; elsewhere only when every lead here names one provider.
    const providers = new Set([...(result.scholarships || []).map((found) => found.name), ...(result.unmatched || [])].map((name) => (leadProvider.get(`${result.key}|${name}`) || "").replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean));
    const anyLead = [...(result.scholarships || []).map((found) => found.name), ...(result.unmatched || [])].map((name) => leadProvider.get(`${result.key}|${name}`)).find(Boolean);
    const context = leadContext(result.url, providers.size === 1 ? anyLead : null);
    const source = typeof context !== "string" && context.source === "school-website" ? "school-website" : "provider-website";
    for (const found of result.others || []) {
      if (typeof context === "string") { take(source, context === "no provider" ? "unlisted scholarship on a page of several providers" : context); continue; }
      if ((!found.metadata && !found.text?.length) || found.nameOnly || found.linkOnly) { take(source, "name only (no fact and no text of its own)"); continue; }
      if (OUTSIDE_PAGE.test(found.url || "")) { take(source, "listed on a page of outside scholarships"); continue; }
      let sameSite = false;
      try { sameSite = baseDomain(new URL(found.url).host) === baseDomain(new URL(result.url).host); } catch { /* unusable address */ }
      if (!sameSite) { take(source, "unlisted scholarship on another site"); continue; }
      take(source, { url: https(found.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: true }, context);
    }
    continue;
  }
  const names = result.names || [];
  // An older read of a shared address returned one record for many names; it is read again on the server.
  if (names.length !== 1) { for (const name of names) take("provider-website", "shared address not yet re-read"); continue; }
  const context = leadContext(result.url, leadProvider.get(`${result.key}|${names[0]}`));
  const source = typeof context === "string" || context.source !== "school-website" ? "provider-website" : "school-website";
  if (typeof context === "string") { take(source, context); continue; }
  const read = (result.scholarships || [])[0];
  if (!read) { take(source, "page had no scholarship"); continue; }
  // The page must be about this scholarship: either the lead points at a page of its own,
  // or what was read there uses the words of its name.
  const words = core(names[0]).split(" ").filter((word) => word.length > 2);
  const text = ` ${core(`${read.name} ${(read.digest || []).map((line) => line.text).join(" ")}`)} `;
  const hits = words.filter((word) => text.includes(` ${word} `)).length;
  const ownAddress = new URL(result.url).pathname.replace(/\/$/, "").length > 0;
  if (!(words.length && hits / words.length >= 0.6) && !(ownAddress && hits >= 1)) { take(source, "page read is not about this scholarship"); continue; }
  take(source, { url: https(result.url), name: names[0], metadata: read.metadata, text: (read.digest || []).map((line) => line.text), checkedAt: result.readAt }, context);
}

// 5. What the re-scrape (crawler/rescrape.mjs) recovered: names whose page was fetched again
// or found through the site's sitemap, and other scholarships on the pages it read.
for (const result of await latest("data/raw/rescrape/results.jsonl")) {
  if (result.blocked || result.error) continue;
  const listed = (result.source || "").startsWith("provider-website");
  const sourceOf = (context) => (typeof context !== "string" && context.source === "school-website" ? "school-website" : listed ? "provider-website" : context.source);
  // Whose scholarship it is comes from the first crawl: a school's site, a foundation's, or a listed provider's.
  const owner = (name) => {
    if (listed) return leadContext(result.url, leadProvider.get(`${result.url}|${name}`) || leadProvider.get(`${normalizeUrl(result.url)}|${name}`));
    let host;
    try { host = new URL(result.url).host.replace(/^www\./, ""); } catch { return "bad address"; }
    if (/\.edu$/i.test(host)) return leadContext(result.url, null);
    const funder = funderByHost.get(host);
    const foundation = foundationName.get(host) || funder?.name;
    return foundation ? { scope: "open", source: "foundation-website", providerName: foundation, funderEin: funder?.ein } : "no provider";
  };
  for (const found of result.scholarships || []) {
    const context = owner(found.name);
    if (typeof context === "string") { take("re-scrape", context); continue; }
    if (!found.metadata && !found.text?.length) { take("re-scrape", "name only (no fact and no text of its own)"); continue; }
    take("re-scrape", { url: https(found.url || result.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: found.how !== "own-page" && found.how !== "linked-page" }, { ...context, source: sourceOf(context) });
  }
  const providers = new Set((result.scholarships || []).map((found) => owner(found.name)).filter((context) => typeof context !== "string").map((context) => context.providerName));
  const shared = providers.size === 1 ? owner((result.scholarships || [])[0].name) : /\.edu$/i.test((() => { try { return new URL(result.url).host; } catch { return ""; } })()) ? leadContext(result.url, null) : owner("");
  for (const found of result.others || []) {
    if (typeof shared === "string") { take("re-scrape", shared === "no provider" ? "unlisted scholarship on a page of several providers" : shared); continue; }
    if ((!found.metadata && !found.text?.length) || found.nameOnly) { take("re-scrape", "name only (no fact and no text of its own)"); continue; }
    let sameSite = false;
    try { sameSite = baseDomain(new URL(found.url).host) === baseDomain(new URL(result.url).host); } catch { /* unusable address */ }
    if (!sameSite || OUTSIDE_PAGE.test(found.url || "")) { take("re-scrape", "unlisted scholarship on another site"); continue; }
    take("re-scrape", { url: https(found.url), name: found.name, metadata: found.metadata, text: found.text, checkedAt: result.readAt, shared: true }, { ...shared, source: sourceOf(shared) });
  }
}

// ------------------------------------------------------------------ one row per scholarship
// The same scholarship can arrive from several sources, and a portal keeps last year's copy
// beside this year's. Same school (or same site, for open ones) and same name is one
// scholarship: keep the strongest source, then the latest deadline, then the most facts.
const STRENGTH = { "school-portal": 4, "provider-website": 3, "foundation-website": 2, "school-website": 1 };
const better = (a, b) => STRENGTH[a.row.source] - STRENGTH[b.row.source] || (a.row.deadline || "").localeCompare(b.row.deadline || "") || a.row.stated_fields.length - b.row.stated_fields.length || a.text.join(" ").length - b.text.join(" ").length;
const byScholarship = new Map();
let merged = 0;
for (const cleaned of candidates) {
  const row = cleaned.row;
  const owner = row.scope === "school" ? `school:${row.school_unitid}` : `site:${baseDomain(new URL(row.url).host)}`;
  const key = `${owner}|${nameKey(row.name)}`;
  const current = byScholarship.get(key);
  if (!current) { byScholarship.set(key, cleaned); continue; }
  merged += 1;
  // The copy that is kept still gets the longer text and the funder, whichever copy had them.
  const [keep, other] = better(cleaned, current) > 0 ? [cleaned, current] : [current, cleaned];
  if (other.text.join(" ").length > keep.text.join(" ").length * 1.5) keep.text = other.text;
  keep.funderEin ||= other.funderEin;
  byScholarship.set(key, keep);
}
// Two different scholarships can still share an id only if they share an address and a name.
const byId = new Map();
for (const cleaned of byScholarship.values()) if (!byId.has(cleaned.row.id) || better(cleaned, byId.get(cleaned.row.id)) > 0) byId.set(cleaned.row.id, cleaned);

await mkdir(join(root, "data", "records"), { recursive: true });
const write = async (file, rows) => {
  const out = createWriteStream(join(root, "data", "records", file));
  for (const row of rows) out.write(`${JSON.stringify(row)}\n`);
  await new Promise((resolve) => out.end(resolve));
};
const today = new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ funders known only from a tax filing
// A foundation that takes applications and says who may apply, and whose website gave us no
// scholarship page, becomes one row whose only source is the filing.
for (const funder of funders.values()) {
  if (!funder.usable || einsWithPages.has(funder.ein)) continue;
  const counts = tally("irs-filing");
  counts.read += 1;
  const name = /scholar|fund|foundation|trust|award|memorial/i.test(funder.name) ? funder.name : `${funder.name} Scholarship`;
  const id = idFor(`irs.gov/ein/${funder.ein}`);
  if (byId.has(id) || name.length > 200) continue;
  counts.kept += 1;
  byId.set(id, {
    row: {
      id, name, provider_name: funder.name, scope: "open", school_unitid: null, url: funder.website, source: "irs-filing",
      award_min: null, award_max: null, award_per_year: false, award_type: null, opens: null, deadline: null, minimum_gpa: null,
      grade_levels: [], fields_of_study: [], citizenship: [], tags: [], need: "no", merit: "no", enrollment: "either",
      essay: false, recommendations: false, transcript: false, interview: false, nomination: false, fee: false, renewable: false, has_later_rounds: false,
      checked_at: `${Math.min(funder.tax_year + 1, Number(today.slice(0, 4)))}-01-01T00:00:00.000Z`, stated_fields: [],
    },
    evidence: [], text: textOf(funder.text), hasFact: false, funderEin: funder.ein,
  });
}

// ------------------------------------------------------------------ criteria read by the model
// scripts/extract-criteria.mjs reads each scholarship's text; what it wrote is joined here.
const criteria = new Map();
for await (const row of lines("data/records/criteria.jsonl")) criteria.set(row.id, row);
const textHash = (text) => createHash("sha256").update(text.join("\n")).digest("hex").slice(0, 12);
// "03-01" with no year is the next March 1.
const nextDate = (monthDay) => { const year = Number(today.slice(0, 4)); return `${year}-${monthDay}` >= today ? `${year}-${monthDay}` : `${year + 1}-${monthDay}`; };
let notScholarships = 0;
for (const [id, cleaned] of byId) {
  const row = cleaned.row;
  const funder = cleaned.funderEin ? funders.get(cleaned.funderEin) : null;
  const read = criteria.get(id);
  const current = read && !read.error && read.text_hash === textHash(cleaned.text) ? read : null;
  // The model says the text is not an award a student applies for: a heading, a grant to
  // organizations, a news item. Rows the keyword reader built from a portal stay.
  if (current && !current.is_scholarship && row.source !== "school-portal") { byId.delete(id); notScholarships += 1; continue; }
  Object.assign(row, {
    tier: row.source === "irs-filing" ? "filing" : "page",
    funder_ein: funder?.ein || null,
    has_text: cleaned.text.join(" ").length >= MIN_TEXT,
    criteria_read: Boolean(current),
    summary: current?.summary || null,
    criteria: current?.criteria || [],
    required_states: [...new Set((current?.criteria || []).filter((item) => item.strength === "required" && item.kind === "location" && item.state).map((item) => item.state))].sort(),
    awards: current?.awards || null,
    deadline_recurring: false,
    materials: current?.materials || [],
    apply_url: current?.apply_url || null,
    contact: current?.contact || (row.source === "irs-filing" ? funder?.application?.email || funder?.application?.phone || null : null),
  });
  if (!current) continue;
  // Amount and deadline: what the model read, with its quote checked, fills what the keyword reader left empty.
  if (current.amount && !row.award_max) { row.award_min = current.amount.min; row.award_max = current.amount.max || current.amount.min; row.award_min ||= null; row.award_per_year = current.amount.per_year; row.stated_fields = [...new Set([...row.stated_fields, "award_max"])].sort(); }
  if (current.deadline && !row.deadline) {
    row.deadline = current.deadline.date || nextDate(current.deadline.month_day);
    row.deadline_recurring = !current.deadline.date;
    row.stated_fields = [...new Set([...row.stated_fields, "deadline"])].sort();
  }
  if (current.renewable === true) row.renewable = true;
}

const kept = [...byId.values()].sort((a, b) => a.row.id.localeCompare(b.row.id));
await write("schools.jsonl", [...schools.values()]);
await write("scholarships.jsonl", kept.map((cleaned) => cleaned.row));
await write("evidence.jsonl", kept.flatMap((cleaned) => cleaned.evidence));
await write("texts.jsonl", kept.filter((cleaned) => cleaned.row.has_text).map((cleaned) => ({ id: cleaned.row.id, name: cleaned.row.name, provider: cleaned.row.provider_name, tier: cleaned.row.tier, text: cleaned.text })));
await write("funders.rows.jsonl", [...funders.values()].map((funder) => ({
  ein: funder.ein, name: funder.name, kind: funder.kind, city: funder.city, state: funder.state, zip: funder.zip, website: funder.website, phone: funder.phone,
  tax_year: funder.tax_year, assets: funder.assets, grants_paid: funder.grants_paid, scholarship_awards: funder.scholarship_awards, scholarship_dollars: funder.scholarship_dollars,
  accepts_applications: funder.accepts_applications, preselected_only: funder.preselected_only,
  apply_contact: funder.application?.contact || null, apply_email: funder.application?.email || null, apply_phone: funder.application?.phone || null, apply_address: funder.application?.address || null,
  apply_materials: funder.application?.materials || null, apply_deadlines: funder.application?.deadlines || null, apply_restrictions: funder.application?.restrictions || null,
})));
summary.notScholarships = notScholarships;

const count = (test) => kept.filter((cleaned) => test(cleaned.row)).length;
summary.duplicatesMerged = merged;
summary.rows = kept.length;
summary.bySource = Object.fromEntries([...Object.keys(STRENGTH), "irs-filing"].map((source) => [source, count((row) => row.source === source)]));
summary.withText = count((row) => row.has_text);
summary.criteriaRead = count((row) => row.criteria_read);
summary.withFunder = count((row) => row.funder_ein);
summary.byScope = { school: count((row) => row.scope === "school"), open: count((row) => row.scope === "open") };
summary.open = count((row) => row.deadline && row.deadline >= today);
summary.closed = count((row) => row.deadline && row.deadline < today);
summary.noDeadline = count((row) => !row.deadline);
summary.withAward = count((row) => row.award_max);
summary.schoolsWithScholarships = new Set(kept.map((cleaned) => cleaned.row.school_unitid).filter(Boolean)).size;
summary.builtAt = today;
await writeFile(join(root, "data", "records", "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
