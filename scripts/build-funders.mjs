// Build funder records from the IRS filings read by crawler/read-irs-filings.mjs.
// One record per organization (its latest filing), with what the filing says about applying.
// Reads data/raw/irs-filings/*.kept.jsonl.gz. Writes (git-ignored):
//   data/records/funders.jsonl        one line per organization that gives scholarships
//   data/registry/funder-sites.json   the websites named in filings, for crawler/scrape-foundations.mjs
// Names of individual grant recipients are never in the input and never written.
// Usage: node --max-old-space-size=4000 scripts/build-funders.mjs
import { createReadStream, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "data", "raw", "irs-filings");

// Filings are typed in capitals; names read better in ordinary case.
const SMALL = new Set(["of", "the", "and", "for", "in", "at", "to", "a", "an", "on", "by"]);
const KEEP_UPPER = /^(inc|llc|ii|iii|iv|usa|us|pta|pto|vfw|ymca|ywca|ffa|nfp|co|tr|uw|cf|dba|ua|fbo)$/i;
export function titleCase(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean.toLowerCase().split(" ").map((word, index) => {
    if (/^(inc|llc|co|tr)$/.test(word)) return word === "llc" ? "LLC" : word[0].toUpperCase() + word.slice(1);
    if (KEEP_UPPER.test(word)) return word.toUpperCase();
    if (index && SMALL.has(word)) return word;
    return word.replace(/(^|[-'/.&])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
  }).join(" ");
}

// The IRS name line is 35 characters of capitals with a trustee's shorthand:
// "T U W FLOWERS CHRTBL FNDTN TTEE", "GHIDOTTI WM MARIAN T U A", "X SCHSHP TR C/O HNB BANK".
// Written out the way the fund would be named to a student.
const WRITTEN_OUT = [
  [/\bschl?a?r?s?h?p\b|\bschshp\b|\bschlrshp\b|\bschol\b|\bscholar\b(?! ?ship)|\bschlp\b|\bschlshp\b/gi, "Scholarship"],
  [/\bf(ou)?nda?t?n\b|\bfdn\b|\bfndn\b|\bfound\b|\bfdtn\b/gi, "Foundation"],
  [/\bchar\b|\bchrtbl\b|\bcharit\b|\bchartbl\b|\bchar'?bl\b/gi, "Charitable"],
  [/\bmem\b|\bmeml\b|\bmemor\b/gi, "Memorial"],
  [/\bedu\b|\beduc\b|\beducatl\b|\bed\b(?= (fund|foundation|trust))/gi, "Educational"],
  [/\btr\b|\btrst\b/gi, "Trust"],
  [/\bfd\b/gi, "Fund"],
  [/\bmemorial sch\b/gi, "Memorial Scholarship"],
];
export function fundName(raw) {
  let name = titleCase(raw);
  if (!name) return null;
  name = name
    .replace(/\s+(c\/o|%|attn:?|dba|fbo|f\/b\/o)\s.*$/i, "")
    // trust shorthand: under will, under agreement, trustee, irrevocable, private foundation
    .replace(/\b(t ?u ?w|t ?u ?a|u ?t ?a|u ?w ?o?|u ?a|u\/w|u\/a|t\/u\/w|t\/u\/a|f\/b\/o|fbo|ttee|trustee|tw|irr|irrev|pfdn|pf|ua|uw|tua|tuw|ta)\b(?=\s|$)/gi, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s+[-,]\s*$/g, "");
  for (const [short, written] of WRITTEN_OUT) name = name.replace(short, written);
  name = name.replace(/\b(Scholarship|Foundation|Trust|Fund)( \1\b)+/gi, "$1").replace(/\s+/g, " ").replace(/^[\s,&-]+|[\s,&-]+$/g, "").replace(/^(of|for|the estate of|estate of)\s+/i, "").trim();
  // "Ghidotti Wm Marian" keeps the filer's word order; that is as far as rules can go.
  return name.length >= 4 ? name : titleCase(raw);
}

// "SEE STATEMENT ATTACHED", "NONE", "N/A": the filer wrote nothing useful in the box.
const EMPTY = /^(n\/?a|none\.?|no|not applicable|see (the )?(attached|statement|attachment|schedule|footnote|supplemental|general|above|below|part|add)[^.]{0,60}|same( as above)?|various|varies|unknown|-+|\.+|0|x)$/i;
export function said(text) {
  if (!text) return null;
  const clean = String(text).replace(/-{3,}/g, "; ").replace(/\s+/g, " ").replace(/^[;\s]+|[;\s]+$/g, "").trim();
  return !clean || EMPTY.test(clean) ? null : clean;
}
const sentence = (text) => { const clean = said(text); return clean && clean === clean.toUpperCase() ? clean[0] + clean.slice(1).toLowerCase() : clean; };

const SOCIAL = /(^|\.)(facebook|fb|linkedin|instagram|twitter|x|youtube|gofundme|paypal|google|gmail|yahoo|aol|wixsite|weebly|squarespace|godaddy|linktr|guidestar|candid|irs)\.(com|org|gov|ee|me)$/i;
export function siteOf(website) {
  if (!website) return null;
  const text = String(website).trim().toLowerCase().replace(/\s+/g, "");
  if (!/\.[a-z]{2,}/.test(text) || /@/.test(text) || /^n\/?a$|^none/.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
    const host = url.host.replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || SOCIAL.test(host)) return null;
    return { host, website: `https://${url.host}${url.pathname === "/" ? "/" : url.pathname}` };
  } catch { return null; }
}

const ABOUT_STUDENTS = /scholar|tuition|student|graduat|college|universit|high school|seniors?|educat|degree|school|fellow/i;

// One organization's record from its latest filing.
export function funderFrom(filing, years) {
  const foundation = filing.form === "990PF";
  const entries = foundation ? filing.application?.entries || [] : [];
  const first = entries.find((entry) => said(entry.restrictions) || said(entry.deadlines) || said(entry.materials)) || entries[0] || null;
  const site = siteOf(filing.website);
  const scholarshipGrants = foundation
    ? { awards: filing.grants?.scholarships?.count || 0, dollars: filing.grants?.scholarships?.amount || 0 }
    : (filing.grantsToPeople || []).filter((grant) => ABOUT_STUDENTS.test(grant.type || "")).reduce((sum, grant) => ({ awards: sum.awards + (grant.recipients || 0), dollars: sum.dollars + (grant.cash || 0) }), { awards: 0, dollars: 0 });
  const programs = (filing.programs || []).map((program) => sentence(program.description)).filter(Boolean);
  const purposes = foundation ? (filing.grants?.purposes || []).filter((item) => ABOUT_STUDENTS.test(item.purpose || "")).map((item) => sentence(item.purpose)).filter(Boolean).slice(0, 8) : (filing.grantsToPeople || []).map((grant) => sentence(grant.type)).filter(Boolean).slice(0, 8);
  const application = first ? {
    contact: titleCase(first.contact), email: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(first.email || "") ? String(first.email).toLowerCase() : null, phone: first.phone || null,
    address: first.address ? [titleCase(first.address.line1), titleCase(first.address.city), first.address.state, first.address.zip].filter(Boolean).join(", ") : null,
    materials: sentence(first.materials), deadlines: sentence(first.deadlines), restrictions: sentence(first.restrictions),
  } : null;
  const accepts = foundation ? !filing.application?.preselectedOnly && entries.length > 0 : null;
  // The words the filing gives about who can apply and how, for the criteria reader.
  const text = [
    !foundation && sentence(filing.mission) ? `Mission: ${sentence(filing.mission)}` : null,
    ...programs.filter((line) => ABOUT_STUDENTS.test(line)).slice(0, 4).map((line) => `Program: ${line}`),
    application?.restrictions ? `Restrictions on awards: ${application.restrictions}` : null,
    application?.deadlines ? `Deadlines: ${application.deadlines}` : null,
    application?.materials ? `How to apply: ${application.materials}` : null,
    purposes.length ? `Grants paid for: ${[...new Set(purposes)].join("; ")}` : null,
  ].filter(Boolean);
  return {
    ein: filing.ein, name: fundName(filing.name), kind: foundation ? "foundation" : filing.isSchool ? "school" : "charity",
    city: titleCase(filing.address?.city), state: /^[A-Z]{2}$/.test(filing.address?.state || "") ? filing.address.state : null, zip: filing.address?.zip || null,
    website: site?.website || null, host: site?.host || null, phone: filing.phone || null,
    tax_year: filing.taxYear, years_filed: years, filing: filing.key,
    assets: filing.money?.assets ?? null, grants_paid: filing.money?.grantsPaid ?? null,
    scholarship_awards: scholarshipGrants.awards, scholarship_dollars: scholarshipGrants.dollars,
    accepts_applications: accepts, preselected_only: foundation ? Boolean(filing.application?.preselectedOnly) : null,
    application, text,
    // Enough said in the filing to tell a student whether to apply.
    usable: Boolean(accepts && (application?.restrictions || application?.deadlines) && ABOUT_STUDENTS.test(text.join(" "))),
    reasons: filing.scholarshipReasons || [],
  };
}

async function main() {
  const latest = new Map();
  const years = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".kept.jsonl.gz"))) {
    for await (const line of createInterface({ input: createReadStream(join(dir, file)).pipe(createGunzip()), crlfDelay: Infinity })) {
      if (!line) continue;
      const filing = JSON.parse(line);
      if (!years.has(filing.ein)) years.set(filing.ein, new Set());
      years.get(filing.ein).add(filing.taxYear);
      const stamp = `${filing.periodEnd || ""}|${filing.filedAt || ""}`;
      if (latest.has(filing.ein) && latest.get(filing.ein).stamp >= stamp) continue;
      latest.set(filing.ein, { stamp, filing });
    }
  }
  const funders = [...latest.values()].map(({ filing }) => funderFrom(filing, [...years.get(filing.ein)].sort())).sort((a, b) => a.ein.localeCompare(b.ein));

  // Websites worth reading: not schools (read already), not foundations that choose their own recipients.
  let known = new Set();
  try { known = new Set(JSON.parse(await readFile(join(root, "data", "registry", "foundations.json"), "utf8")).foundations.map((entry) => entry.host)); } catch { /* no earlier list */ }
  const sites = new Map();
  for (const funder of funders) {
    if (!funder.host || funder.kind === "school" || funder.preselected_only || known.has(funder.host)) continue;
    const have = sites.get(funder.host);
    // Several organizations can share one site; the one giving the most is named.
    if (!have || funder.scholarship_dollars > have.dollars) sites.set(funder.host, { name: funder.name, website: funder.website, host: funder.host, place: funder.state, sources: ["irs-filing"], ein: funder.ein, dollars: funder.scholarship_dollars });
  }
  const list = [...sites.values()].sort((a, b) => b.dollars - a.dollars).map(({ dollars, ...entry }) => entry);

  await mkdir(join(root, "data", "records"), { recursive: true });
  await writeFile(join(root, "data", "records", "funders.jsonl"), funders.map((funder) => JSON.stringify(funder)).join("\n") + "\n");
  await writeFile(join(root, "data", "registry", "funder-sites.json"), `${JSON.stringify({ note: "Websites named in IRS filings of organizations that give scholarships. Built by scripts/build-funders.mjs.", builtAt: new Date().toISOString().slice(0, 10), count: list.length, foundations: list })}\n`);
  const count = (test) => funders.filter(test).length;
  console.log(JSON.stringify({
    funders: funders.length, foundations: count((f) => f.kind === "foundation"), charities: count((f) => f.kind === "charity"), schools: count((f) => f.kind === "school"),
    acceptApplications: count((f) => f.accepts_applications), usableFromFilingAlone: count((f) => f.usable),
    withWebsite: count((f) => f.host), sitesToRead: list.length,
  }, null, 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
