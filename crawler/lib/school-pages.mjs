// A school's own website: start at its financial aid page, find the pages about
// scholarships, and pick out each named scholarship described on them.
import { cleanLines } from "./clean.mjs";
import { extractMetadata } from "./digest.mjs";
import { linksOn } from "./discover.mjs";

const SKIP = /wp-content\/uploads|_wp_link_placeholder|recipients?|winners|reviewers?|donor|news|blog|press|stories|story|event|calendar|donat|giving|give\b|alumni|career|job|staff|directory|login|sign-?in|privacy|contact|\.(pdf|docx?|xlsx?|jpg|png|zip)(\?|$)|mailto:|tel:|\/20\d\d\/\d\d\//i;
const PORTAL_HOST = /(grantinterface\.com|smapply\.io|submittable\.com|fluidreview\.com|mykaleidoscope\.com|applyists\.net|goingmerry\.com|academicworks\.com|scholarshipuniverse\.com|awardspring\.com|communityforce\.com|starsscholarshiponline\.com|smarterselect\.com|kaleidoscope\.com|scholarshipmanager\.com|nextgensso\.com|blackbaud\.com)$/i;

// "admissions.tamu.edu" and "scholarships.tamu.edu" are the same school.
const baseDomain = (host) => host.toLowerCase().split(".").slice(-2).join(".");

export function scholarshipLinks(html, pageUrl, schoolDomain, { aidLinks = false } = {}) {
  const own = new Map();
  const portals = new Set();
  // Links whose text is itself a scholarship's name ("Janet M. Blackburn Scholarship").
  const named = new Map();
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
    // Filter and builder parameters give the same page again.
    for (const name of [...parsed.searchParams.keys()]) if (!/^(id|p|page_id|pgid|sid|scholarship|fund)$/i.test(name)) parsed.searchParams.delete(name);
    const url = parsed.toString().replace(/\?$/, "");
    const label = link.text.replace(/\s+/g, " ").trim();
    if (isName(label) && !named.has(label.toLowerCase())) named.set(label.toLowerCase(), { name: label, url });
    if (!own.has(url) || own.get(url).score < score) own.set(url, { url, text: link.text.slice(0, 80), score });
  }
  return { pages: [...own.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length), portals: [...portals], named: [...named.values()] };
}

const AWARD_WORD = /scholarships?|fellowships?|\bawards?\b|\bgrants?\b|\bprize\b/i;
// Headings that name a section or a kind of aid, not one scholarship.
const GENERIC = /^(for |go to |view |see |click |learn |read |download |start |begin |log ?in|sign |browse |high school |adult |student |local |community scholarships|area |award amount|length of |relationship |the |our |more |other |all |about |additional |available |find |search |featured |general |new |types? of |kinds? of |how to |apply |applying |when |where |what |who |why |can |do |does |is |are |will |should |frequently|faqs?\b|step \d|outside|external|private|federal|state|institutional|departmental|endowed|merit|need[- ]based|academic|athletic|transfer|freshm[ae]n|first[- ]year|incoming|current|continuing|graduate|undergraduate|international|donor|foundation|university|college|financial aid|scholarships?( and| &|:|$)|grants?( and| &|:|$)|awards?( and| &|:|$))/i;
const GENERIC_END = /(funds|section|applicants?|opportunities|resources|information|search|application|applications|deadlines?|requirements|eligibility|criteria|process|program overview|faqs?|portal|office|renewal|policy|policies|terms|tips|scams?|database|listings?|types|options|amounts?|chart|calculator|estimator|recipients|winners|donors|universe|manager)\s*:?$/i;

// Wording that belongs to advice, instructions or government aid rather than a named award.
const NOT_A_NAME = /[►»›|•]|^\W|\b(application|apply|director|manager|coordinator|officer|season|portal|account|recipients?|one-time|special application|create|partners?|totaling|eligibility|deadline|committee|reviewers?|donors?|you|your|you're|don't|aren't|isn't|how|tips?|help|forms?|terms|checks?|letters?|submitting|deferring|receiving|received|explore|list of|office of|levels?|steps?|notification|disbursement|refunds?|taxes|taxable|pell|fseog|seog|teach grant|federal|work[- ]study|loans?|fafsa|considered)\b/i;
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
    // A title with nothing beneath it (a page that only lists names) is kept as a name.
    if (current && (current.body.join(" ").length >= 60 || current.titleLine)) found.push(current);
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
    if (!line.startsWith("- ") && line.length <= 90 && isName(line) && words.filter((word) => /^[A-Z(]/.test(word)).length >= words.length * 0.6 && /(scholarships?|fellowship|award|grant|prize|program|fund)\)?$/i.test(line)) {
      // Several titles in a row are a list of names; the text after the last one describes
      // the list as a whole, so none of them takes it as its own description.
      const inList = Boolean(current && current.titleLine && !current.body.length);
      if (inList) current.listed = true;
      close();
      current = { name: line, body: [], titleLine: true, listed: inList };
      continue;
    }
    if (current) current.body.push(line.replace(/^- /, ""));
  }
  close();
  const seen = new Set();
  return found.filter((item) => { const key = item.name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).map((item) => {
    const body = labelled(item.body);
    if (item.listed || body.join(" ").length < 60) return { name: item.name, url: pageUrl, metadata: null, nameOnly: true };
    return { name: item.name, url: pageUrl, metadata: extractMetadata(body.map((text) => ({ text, heading: false, url: pageUrl }))), lines: body.length };
  });
}

// Detail pages often print a label and its value on separate lines, in either order
// ("Awards Per Year:" / "1 scholarship", or "$1000" / "Scholarship Value"). Join each pair
// into one "Label: value" line so the rules can read it.
const VALUE_LABEL = /^(scholarship (value|amount)|award (value|amount)|amount|application deadline|deadline|due date|frequency|application type)$/i;
const MONTH_DAY = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(st|nd|rd|th)?$/i;
export function labelled(lines, today = new Date()) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];
    let joined = null;
    if (/:$/.test(line) && line.length <= 40 && next && !/:$/.test(next)) { joined = `${line} ${next}`; i += 1; }
    else if (next && VALUE_LABEL.test(next) && line.length <= 60) { joined = `${next}: ${line}`; i += 1; }
    if (joined) {
      // A deadline given without a year means its next occurrence.
      const dated = joined.match(/^((?:application )?deadline|due date): (.+)$/i);
      if (dated && MONTH_DAY.test(dated[2])) {
        const thisYear = new Date(`${dated[2].replace(/(st|nd|rd|th)$/i, "")}, ${today.getFullYear()}`);
        joined = `${dated[1]}: ${dated[2].replace(/(st|nd|rd|th)$/i, "")}, ${thisYear < today ? today.getFullYear() + 1 : today.getFullYear()} (year assumed)`;
      }
      out.push(joined);
    } else out.push(line);
  }
  return out;
}

// Sections that follow the scholarship's own description on a detail page.
const AFTER_DESCRIPTION = /^# (frequently asked|faqs?\b|contact|related|recent|past |our |about the (foundation|fund)|news|stay |subscribe|share|recipients?|testimonials?|how your scholarship)/i;

// A page that is about one scholarship ("/scholarship/community-spirit-scholarship/"): the
// page's main heading is the name and the whole page is its description.
const DETAIL_PATH = /\/(scholarships?|scholarship-funds?|funds?|awards?)\/[^/?]{3,}\/?$/i;
export function scholarshipPage(lines, pageUrl) {
  if (!DETAIL_PATH.test(new URL(pageUrl).pathname)) return null;
  const heading = lines.find((line) => line.startsWith("# "))?.slice(2).trim();
  if (!heading || !isName(heading)) return null;
  const start = lines.findIndex((line) => line.startsWith("# "));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => AFTER_DESCRIPTION.test(line));
  // Thank-you quotes from past recipients describe nothing about the award.
  const body = labelled((end >= 0 ? rest.slice(0, end) : rest).filter((line) => !line.startsWith("# ") && !/^["“]|\bRecipient$/.test(line)).map((line) => line.replace(/^- /, "")));
  if (body.join(" ").length < 60) return null;
  return { name: heading, url: pageUrl, metadata: extractMetadata(body.map((text) => ({ text, heading: false, url: pageUrl }))), lines: body.length, ownPage: true };
}

export { baseDomain, cleanLines, isName };
