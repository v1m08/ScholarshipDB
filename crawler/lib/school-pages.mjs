// A school's own website: start at its financial aid page, find the pages about
// scholarships, and pick out each named scholarship described on them.
import { cleanLines } from "./clean.mjs";
import { extractMetadata } from "./digest.mjs";
import { linksOn } from "./discover.mjs";

const SKIP = /news|blog|press|stories|story|event|calendar|donat|giving|give\b|alumni|career|job|staff|directory|login|sign-?in|privacy|contact|\.(pdf|docx?|xlsx?|jpg|png|zip)(\?|$)|mailto:|tel:|\/20\d\d\/\d\d\//i;
const PORTAL_HOST = /(academicworks\.com|scholarshipuniverse\.com|awardspring\.com|communityforce\.com|starsscholarshiponline\.com|smarterselect\.com|kaleidoscope\.com|scholarshipmanager\.com|nextgensso\.com|blackbaud\.com)$/i;

// "admissions.tamu.edu" and "scholarships.tamu.edu" are the same school.
const baseDomain = (host) => host.toLowerCase().split(".").slice(-2).join(".");

export function scholarshipLinks(html, pageUrl, schoolDomain, { aidLinks = false } = {}) {
  const own = new Map();
  const portals = new Set();
  for (const link of linksOn(html, pageUrl)) {
    const parsed = new URL(link.url);
    if (PORTAL_HOST.test(parsed.host)) { portals.add(`${parsed.protocol}//${parsed.host}/`); continue; }
    if (baseDomain(parsed.host) !== schoolDomain) continue;
    const address = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (SKIP.test(address) || /\/https?(&|%|:|$)/.test(address)) continue;
    const text = link.text.toLowerCase();
    let score = 0;
    if (/scholarship/.test(address)) score += 5;
    if (/scholarship/.test(text)) score += 4;
    if (/\b(grants?|fellowships?|awards?)\b/.test(`${address} ${text}`)) score += 1;
    if (/merit|freshm[ae]n|first-year|transfer|incoming|current students|continuing|departmental|endowed|institutional|types? of/.test(`${address} ${text}`)) score += 1;
    if (/outside|external|private/.test(`${address} ${text}`)) score += 1;
    // From a home page the way to scholarships usually runs through "financial aid".
    if (aidLinks && /financial[- ]?aid|finaid|cost(s)? (and|&) aid|paying for|tuition (and|&) aid|affordab/.test(`${address} ${text}`)) score += 4;
    if (score < 4) continue;
    parsed.hash = "";
    const url = parsed.toString();
    if (!own.has(url) || own.get(url).score < score) own.set(url, { url, text: link.text.slice(0, 80), score });
  }
  return { pages: [...own.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length), portals: [...portals] };
}

const AWARD_WORD = /scholarships?|fellowships?|\bawards?\b|\bgrants?\b|\bprize\b/i;
// Headings that name a section or a kind of aid, not one scholarship.
const GENERIC = /^(award amount|length of |relationship |the |our |more |other |all |about |additional |available |find |search |featured |general |new |types? of |kinds? of |how to |apply |applying |when |where |what |who |why |can |do |does |is |are |will |should |frequently|faqs?\b|step \d|outside|external|private|federal|state|institutional|departmental|endowed|merit|need[- ]based|academic|athletic|transfer|freshm[ae]n|first[- ]year|incoming|current|continuing|graduate|undergraduate|international|donor|foundation|university|college|financial aid|scholarships?( and| &|:|$)|grants?( and| &|:|$)|awards?( and| &|:|$))/i;
const GENERIC_END = /(opportunities|resources|information|search|application|applications|deadlines?|requirements|eligibility|criteria|process|program overview|faqs?|portal|office|renewal|policy|policies|terms|tips|scams?|database|listings?|types|options|amounts?|chart|calculator|estimator|recipients|winners|donors|universe|manager)\s*:?$/i;

// Wording that belongs to advice, instructions or government aid rather than a named award.
const NOT_A_NAME = /\b(you|your|you're|don't|aren't|isn't|how|tips?|help|forms?|terms|checks?|letters?|submitting|deferring|receiving|received|explore|list of|office of|levels?|steps?|notification|disbursement|refunds?|taxes|taxable|pell|fseog|seog|teach grant|federal|work[- ]study|loans?|fafsa|considered)\b/i;
const PROPER = /[A-Z][A-Za-z'’.&-]+/;
const isName = (text) => text.length >= 8 && text.length <= 110 && AWARD_WORD.test(text) && PROPER.test(text)
  && !/^scholarships\b/i.test(text) && !GENERIC.test(text) && !GENERIC_END.test(text) && !NOT_A_NAME.test(text.replace(/\(.*?\)/g, ""))
  && !/[?.!]$/.test(text) && text.split(" ").length >= 2 && text.split(" ").length <= 14;

// Each named scholarship on a page: a heading (or a "Name: description" list entry) that
// carries an award word, with the lines beneath it as its description.
export function scholarshipsOn(lines, pageUrl) {
  const found = [];
  let current = null;
  const close = () => {
    if (current && current.body.join(" ").length >= 60) found.push(current);
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("# ")) {
      close();
      const name = line.slice(2).trim();
      if (isName(name)) current = { name, body: [] };
      continue;
    }
    const entry = line.match(/^(?:- )?([A-Z][^:|]{6,100}?)\s*(?::| [-–] | \| )\s*(.{60,})$/);
    if (entry && isName(entry[1].trim())) {
      found.push({ name: entry[1].trim(), body: [entry[2]] });
      continue;
    }
    // A short capitalized line on its own ("Stamps Eminence Scholarship Program") is a bold
    // title whose formatting was stripped.
    const words = line.split(" ");
    if (!line.startsWith("- ") && line.length <= 90 && isName(line) && words.filter((word) => /^[A-Z(]/.test(word)).length >= words.length * 0.6 && /(scholarships?|fellowship|award|grant|prize|program)\)?$/i.test(line)) {
      close();
      current = { name: line, body: [] };
      continue;
    }
    if (current) current.body.push(line.replace(/^- /, ""));
  }
  close();
  const seen = new Set();
  return found.filter((item) => { const key = item.name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).map((item) => ({
    name: item.name,
    url: pageUrl,
    metadata: extractMetadata(item.body.map((text) => ({ text, heading: false, url: pageUrl }))),
    lines: item.body.length,
  }));
}

export { baseDomain, cleanLines };
