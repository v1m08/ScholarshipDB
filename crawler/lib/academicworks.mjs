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
