// Several listed scholarships can share one address (a school's or foundation's
// "scholarships" page). Given the names we were told about and the cleaned text of the pages
// read from that site, find where each name is described and read its details from there.
import { extractMetadata } from "./digest.mjs";
import { AFTER_DESCRIPTION, labelled } from "./school-pages.mjs";

// Lower case, no punctuation: "The Jane O'Neil Scholarship (Nursing)" -> "the jane o neil scholarship".
export const nameKey = (text) => text.toLowerCase().replace(/&amp;|&/g, " and ").replace(/\(.*?\)/g, " ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// The words that tell one scholarship from another; "Fund", "Scholarship", "Memorial" do not.
const FILLER = /\b(the|a|an|of|for|and|in|at|scholarships?|fellowships?|grants?|awards?|prize|program|funds?|endowed|endowment|memorial|annual)\b/g;
export const core = (text) => nameKey(text).replace(FILLER, " ").replace(/\s+/g, " ").trim();

// Listing sites often put the provider in front: "Adelphi University Academic Talent Scholarship".
function keysFor(lead) {
  const keys = new Set([core(lead.name)]);
  if (lead.provider) {
    const provider = nameKey(lead.provider);
    const full = nameKey(lead.name);
    if (provider && full.startsWith(`${provider} `)) keys.add(core(full.slice(provider.length)));
  }
  return { names: [...keys].filter(Boolean), provider: lead.provider ? core(lead.provider) : null };
}

// How well a title (a heading, a short line, the part of a line before ":") names the lead.
// 3: the same name. 2: one is the start of the other. 1: the title contains the name. 0: no.
function titleScore(title, { names: keys, provider }) {
  const have = core(title);
  // A title that is only the provider's name ("Scholarships at Aquinas College") names none of its scholarships.
  if (!have || have === provider) return 0;
  const haveWords = have.split(" ").length;
  let best = 0;
  for (const key of keys) {
    const words = key.split(" ").length;
    if (have === key) { best = 3; break; }
    // One distinguishing word ("Presidential Scholarship") must match exactly.
    if (words < 2 || haveWords < 2) continue;
    if (have.startsWith(`${key} `) && haveWords <= words + 4) best = Math.max(best, 2);
    else if (key.startsWith(`${have} `) && haveWords >= words * 0.6) best = Math.max(best, 2);
    else if (` ${have} `.includes(` ${key} `) && haveWords <= words + 4) best = Math.max(best, 1);
  }
  return best;
}

// "Name: description", "Name - description" and "Name | description" entries.
const ENTRY = /^(.{6,110}?)\s*(?::| [-–—] | \| )\s*(.{40,})$/;

// Every place on one page where a lead is named: { lead, line, score, inline }.
function titlesOn(lines, leads) {
  const hits = [];
  lines.forEach((raw, index) => {
    const heading = raw.startsWith("# ");
    const text = raw.replace(/^[#-] /, "");
    const entry = text.match(ENTRY);
    leads.forEach((lead, leadIndex) => {
      let score = 0;
      let inline = null;
      if (text.length <= 150) score = titleScore(text, lead.keys);
      if (!score && entry) { score = titleScore(entry[1], lead.keys); if (score) inline = entry[2]; }
      // "The Jane Doe Scholarship is awarded to ..." names it at the start of its own description.
      if (!score && text.length > 150) {
        const full = nameKey(lead.name).replace(/^the /, "");
        if (full.split(" ").length >= 3 && nameKey(text.slice(0, 200)).replace(/^the /, "").startsWith(`${full} `)) { score = 1; inline = text; }
      }
      if (score) hits.push({ lead: leadIndex, line: index, score: score + (heading ? 0.5 : 0), inline, heading });
    });
  });
  return hits;
}

const describe = (body, url) => {
  const lines = labelled(body.filter((line) => !line.startsWith("# ") && !/^["“]/.test(line)).map((line) => line.replace(/^- /, "")));
  if (lines.join(" ").length < 60) return { metadata: null, lines: lines.length };
  return { metadata: extractMetadata(lines.map((text) => ({ text, heading: false, url }))), lines: lines.length };
};

// `leads` is [{ name, provider }]; `pages` is [{ url, lines }]. Returns one entry per lead:
// { name, found, url, how, title, metadata, lines }. how is "own-page" (the page is about
// that scholarship), "section" (described under its name on a shared page) or "listed"
// (named there with nothing to read beneath it).
export function findNamed(leads, pages, { maxLines = 30 } = {}) {
  const wanted = leads.map((lead) => ({ ...lead, keys: keysFor(lead) }));
  const best = wanted.map(() => null);
  for (const page of pages) {
    const hits = titlesOn(page.lines, wanted);
    if (!hits.length) continue;
    const titleLines = new Set(hits.filter((hit) => hit.score >= 2).map((hit) => hit.line));
    const firstHeading = page.lines.findIndex((line) => line.startsWith("# "));
    for (const hit of hits) {
      let body;
      let how = "section";
      let rank = hit.score;
      // The page's main heading is this name and the page names at most one other: its own page.
      if (hit.line === firstHeading && hit.score >= 2 && titleLines.size <= 2) {
        const rest = page.lines.slice(hit.line + 1);
        const end = rest.findIndex((line) => AFTER_DESCRIPTION.test(line));
        body = end >= 0 ? rest.slice(0, end) : rest;
        how = "own-page";
        rank += 2;
      } else {
        body = hit.inline ? [hit.inline] : [];
        for (let index = hit.line + 1; index < page.lines.length && body.length < maxLines; index += 1) {
          // The next name, or the next heading, ends this one's description.
          if (titleLines.has(index) || page.lines[index].startsWith("# ")) break;
          // An entry that carried its description on its own line owns only that line.
          if (hit.inline && ENTRY.test(page.lines[index].replace(/^- /, ""))) break;
          body.push(page.lines[index]);
        }
      }
      const read = describe(body, page.url);
      if (!read.metadata) { how = "listed"; rank -= 1.5; }
      const current = best[hit.lead];
      if (!current || rank > current.rank) best[hit.lead] = { rank, url: page.url, how, title: page.lines[hit.line].replace(/^[#-] /, "").slice(0, 140), ...read };
    }
  }
  return wanted.map((lead, index) => {
    const hit = best[index];
    if (!hit) return { name: lead.name, found: false };
    const { rank, ...rest } = hit;
    return { name: lead.name, found: true, ...rest };
  });
}

// True when a link's text names one of the leads, so its page is worth reading.
export function linkNames(leads) {
  const wanted = leads.map((lead) => keysFor(lead));
  return (text) => text.length <= 150 && wanted.some((keys) => titleScore(text, keys) >= 2);
}
