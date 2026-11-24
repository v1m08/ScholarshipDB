// Read one organization's website (a school, a community foundation): start at the given
// page, follow the links about scholarships, and record each named scholarship those pages
// describe. robots.txt is obeyed per host; a site that refuses the crawler is recorded as blocked.
import { linksOn } from "./discover.mjs";
import { fetchPage, pageTitle, USER_AGENT } from "./fetcher.mjs";
import { parseRobots } from "./robots.mjs";
import { baseDomain, cleanLines, scholarshipLinks, scholarshipPage, scholarshipsOn } from "./school-pages.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// "http://x.org/a/" and "https://www.x.org/a" are one page.
const pageKey = (url) => { const parsed = new URL(url); return `${parsed.host.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`; };
export const withScheme = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

const robotsCache = new Map();
async function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, (async () => {
      try {
        const response = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
        return parseRobots(response.ok ? await response.text() : "");
      } catch { return parseRobots(""); }
    })());
  }
  return robotsCache.get(origin);
}

// `org` is { key, name, state, start, home }: start is the page most likely to lead to
// scholarships, home is the fallback when that address no longer works.
// `onPage(url, lines)` is given every page read; `wantedLink(text)` says a link is worth
// following whatever its address looks like (its text names a scholarship we are looking for).
const NOT_A_PAGE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|zip|mp4)(\?|$)|^mailto:|^tel:/i;
export async function readOrganization(org, job, maxPages, { onPage = null, wantedLink = null } = {}) {
  const row = { key: org.key, name: org.name, state: org.state || null, start: withScheme(org.start), readAt: new Date().toISOString(), pages: [], scholarships: [], portals: [] };
  const visited = new Set();
  const portals = new Set();
  let gapMs = 500;
  const read = async (url) => {
    const parsed = new URL(url);
    const robots = await robotsFor(parsed.origin);
    if (!robots.allowed(`${parsed.pathname}${parsed.search}`)) return { skipped: "robots" };
    gapMs = Math.max(gapMs, Math.min(robots.crawlDelay, 5) * 1000);
    if (visited.size) await sleep(gapMs);
    const page = await fetchPage(url);
    if ([401, 403, 405, 429].includes(page.status)) return { skipped: `refused (HTTP ${page.status})` };
    if (page.status >= 400) return { skipped: `HTTP ${page.status}` };
    return page;
  };

  let first = await read(row.start).catch((error) => ({ skipped: error.message.split("\n")[0].slice(0, 60) }));
  // A start address that no longer works: fall back to the organization's home page.
  const home = org.home ? withScheme(org.home) : null;
  if (first.skipped && !/robots|refused/.test(first.skipped) && home && home !== row.start) {
    row.startFailed = first.skipped;
    row.start = home;
    first = await read(home).catch((error) => ({ skipped: error.message.split("\n")[0].slice(0, 60) }));
  }
  if (first.skipped) { row[/robots|refused/.test(first.skipped) ? "blocked" : "error"] = first.skipped; return row; }
  const domain = baseDomain(new URL(first.finalUrl || row.start).host);
  const queue = [{ url: first.finalUrl || row.start, page: first, depth: 0, score: 99 }];
  while (queue.length && row.pages.length < maxPages) {
    queue.sort((a, b) => b.score - a.score);
    const item = queue.shift();
    const key = pageKey(item.url);
    if (visited.has(key)) continue;
    let page = item.page;
    if (!page) {
      try { page = await read(item.url); } catch (error) { page = { skipped: error.message.split("\n")[0].slice(0, 60) }; }
    }
    visited.add(key);
    if (page.skipped) { row.pages.push({ url: item.url, skipped: page.skipped }); continue; }
    visited.add(pageKey(page.finalUrl || item.url));
    const lines = cleanLines(page.html);
    const sha = await job.savePage(lines.join("\n"));
    if (onPage) onPage(page.finalUrl || item.url, lines);
    if (wantedLink) {
      for (const link of linksOn(page.html, page.finalUrl || item.url)) {
        let parsed;
        try { parsed = new URL(link.url); } catch { continue; }
        if (baseDomain(parsed.host) !== domain || NOT_A_PAGE.test(link.url) || !wantedLink(link.text.replace(/\s+/g, " ").trim())) continue;
        parsed.hash = "";
        if (!visited.has(pageKey(parsed.toString()))) queue.push({ url: parsed.toString(), depth: item.depth + 1, score: 7 });
      }
    }
    // A page about one scholarship counts as that scholarship; its sub-headings do not.
    const single = scholarshipPage(lines, page.finalUrl || item.url);
    const found = single ? [single] : scholarshipsOn(lines, page.finalUrl || item.url);
    row.pages.push({ url: page.finalUrl || item.url, title: pageTitle(page.html), lines: lines.length, scholarships: found.length, method: page.method, text: sha });
    for (const scholarship of found) {
      const earlier = row.scholarships.findIndex((other) => other.name.toLowerCase() === scholarship.name.toLowerCase());
      // A scholarship first seen only as a link is replaced by what its page says.
      if (earlier < 0) row.scholarships.push(scholarship);
      else if (scholarship.metadata && (!row.scholarships[earlier].metadata || (scholarship.ownPage && !row.scholarships[earlier].ownPage))) row.scholarships[earlier] = scholarship;
    }
    const links = scholarshipLinks(page.html, page.finalUrl || item.url, domain, { aidLinks: Boolean(row.startFailed) && item.depth === 0 });
    // Nothing about scholarships is linked from the start page: try the two usual addresses.
    if (item.depth === 0 && !links.pages.some((link) => /scholarship/i.test(`${link.url} ${link.text}`))) {
      for (const guess of [`https://scholarships.${domain}/`, `https://www.${domain}/scholarships`]) queue.push({ url: guess, depth: 1, score: 5 });
    }
    links.portals.forEach((portal) => portals.add(portal));
    // Links named after a scholarship are kept even if their page is never reached.
    for (const link of links.named) {
      if (!row.scholarships.some((other) => other.name.toLowerCase() === link.name.toLowerCase())) row.scholarships.push({ name: link.name, url: link.url, metadata: null, linkOnly: true });
      // A scholarship's own page is worth reading wherever its link was found.
      if (!visited.has(pageKey(link.url))) queue.push({ url: link.url, depth: item.depth + 1, score: 6 });
    }
    // Follow scholarship links from the start page and from the pages it leads to, no further.
    if (item.depth < 2) for (const link of links.pages) if (!visited.has(pageKey(link.url))) queue.push({ url: link.url, depth: item.depth + 1, score: link.score - item.depth });
  }
  row.portals = [...portals];
  return row;
}
