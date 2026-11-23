// AcademicWorks (Blackbaud Award Management) portals list awards in one table layout:
// amount cell, title link (/opportunities/{id}) with a short description, then a deadline
// or "Ended" cell. Lists are paged with ?page=N; a page past the end repeats the last one.
// Scholarships run by outside organizations sit in a second list at /opportunities/external.
const decode = (text) => text
  .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const text = (html) => decode(html.replace(/<[^>]+>/g, " "));

export function parseListingPage(html, host) {
  const rows = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const link = row.match(/<a href="(\/opportunities\/\d+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => text(match[1]));
    const snippet = row.match(/<\/span>\s*<div[^>]*>([\s\S]*?)<\/div>/);
    rows.push({
      host,
      url: `https://${host}${link[1]}`,
      title: text(link[2]),
      amountText: cells[0] || null,
      statusText: cells.at(-1) || null,
      snippet: snippet ? text(snippet[1]) || null : null,
    });
  }
  return rows;
}

// Walk one list to its end. `get(url)` returns { status, finalUrl, html }.
async function walkList(host, path, get, maxPages) {
  const awards = new Map();
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await get(`https://${host}${path}${page > 1 ? `?page=${page}` : ""}`);
    if (/\/users\/sign_in/.test(result.finalUrl || "")) return { awards: [...awards.values()], pages, signIn: true };
    if (result.status >= 400) break;
    pages += 1;
    const before = awards.size;
    for (const row of parseListingPage(result.html, host)) if (!awards.has(row.url)) awards.set(row.url, row);
    // No new awards means the list has ended (or this page repeated the last one).
    if (awards.size === before) break;
  }
  return { awards: [...awards.values()], pages, signIn: false };
}

export async function collectPortal(host, get, { maxPages = 80 } = {}) {
  const own = await walkList(host, "/opportunities", get, maxPages);
  if (own.signIn) return { signIn: true, pages: own.pages, awards: [] };
  const outside = await walkList(host, "/opportunities/external", get, maxPages);
  const ownUrls = new Set(own.awards.map((award) => award.url));
  return {
    signIn: false,
    pages: own.pages + outside.pages,
    awards: [
      ...own.awards.map((award) => ({ ...award, external: false })),
      ...outside.awards.filter((award) => !ownUrls.has(award.url)).map((award) => ({ ...award, external: true })),
    ],
  };
}

// ---- One award's own page -------------------------------------------------------------
// Layout: <h3> title, a description block, then <dl> pairs (Donor, Award, Deadline, any
// portal-defined ones) and the supplemental questions the applicant must answer.
const blockLines = (html) => html
  .replace(/<li\b[^>]*>/gi, "\n- ")
  .replace(/<\/?(p|div|ul|ol|br|h[1-6]|tr|table|blockquote)\b[^>]*>/gi, "\n")
  .split("\n").map((line) => text(line)).filter((line) => line.replace(/^- /, "").length >= 3);

// "$500 - $2,500" -> { min: 500, max: 2500 }; "Varies" -> nulls. Cents are dropped.
export function parseAward(awardText) {
  const values = [...(awardText || "").matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g)].map((match) => Number(match[1].replace(/,/g, ""))).filter((value) => value > 0);
  if (!values.length) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

const usDate = (value) => {
  const match = (value || "").match(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/);
  return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : null;
};

export function parseAwardPage(html) {
  const main = (html.match(/<section[^>]*class="[^"]*js-opportunity[\s\S]*?<footer/) || html.match(/<section id="main"[\s\S]*?<footer/) || [""])[0];
  const title = main.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  if (!title) return null;
  const header = (main.match(/<\/h3>([\s\S]*?)<\/header>/) || ["", ""])[1];
  const fields = {};
  let questions = [];
  let donor = null;
  for (const pair of main.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const label = text(pair[1]);
    if (/^supplemental questions$/i.test(label)) {
      // Each top-level question is one entry; its sub-items are joined to it.
      questions = pair[2].split(/<li class="[^"]*js-question[^"]*">/).slice(1).map((item) => text(item)).filter(Boolean);
    } else if (/^donors?$/i.test(label)) {
      donor = text(pair[2]) || null;
    } else if (label) {
      fields[label] = text(pair[2]);
    }
  }
  // Outside scholarships usually name the provider's own site in the description.
  const plain = text(header);
  const links = new Set();
  for (const match of header.matchAll(/href="(https?:\/\/[^"]+)"/g)) links.add(match[1].replace(/&amp;/g, "&"));
  for (const match of plain.matchAll(/\bhttps?:\/\/[^\s<>"')]+/g)) links.add(match[0].replace(/[.,;]+$/, ""));
  for (const match of plain.matchAll(/(?<![@/\w])www\.[a-z0-9-]+(\.[a-z0-9-]+)+[^\s<>"')]*/gi)) links.add(`https://${match[0].replace(/[.,;]+$/, "")}`);
  return {
    name: text(title[1]),
    donor,
    awardText: fields.Award || null,
    deadlineText: fields.Deadline || null,
    deadline: usDate(fields.Deadline),
    fields,
    description: blockLines(header),
    questions,
    links: [...links].filter((link) => !/academicworks\.com/.test(link)),
  };
}
