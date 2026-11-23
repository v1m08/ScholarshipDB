// Step 1: list every URL a site publishes (sitemaps + links on the start page), keep the
// ones that look like scholarship pages, and group them into one bundle per scholarship.
import { USER_AGENT } from "./fetcher.mjs";
import { parseRobots } from "./robots.mjs";

const GOOD = [
  [/scholarship/, 4], [/eligib|who-should-apply|who should apply|who can apply/, 5], [/how-to-apply|apply|application/, 4], [/faq|frequently/, 4],
  [/deadline|dates|timeline/, 4], [/requirement|criteria|selection/, 4], [/nominat/, 3], [/award|benefit|fellowship|grant/, 2],
  [/overview|about-the|bulletin/, 2], [/program/, 1], [/student|candidate/, 1],
];
const BAD = /resources?|get-help|campus-rep|outreach|partners?|news|blog|press|stories|story|spotlight|donat|give|career|job|staff|board|team|event|webinar|podcast|video|privacy|terms|contact|login|sign-?in|account|cart|tag\/|category\/|author\/|feed|wp-|\.(pdf|jpg|png|zip|docx?)$|alumni|annual-report|research\/|educator|newsletter|notify|\/20\d\d\//;
const PROGRAM_PARENT = /^(our-)?(scholarships?|programs?|awards?|fellowships?|opportunities)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry after a pause: sites that ask for a crawl delay drop requests that arrive in a burst.
export async function getText(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (response.ok) return await response.text();
      // Missing or refused: retrying will not help.
      if ([401, 403, 404, 410].includes(response.status)) return "";
    } catch { /* retry */ }
    await sleep(3000);
  }
  return "";
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map((match) => match[1].trim().replace(/&amp;/g, "&"));

async function sitemapUrls(origin, robots) {
  // Some sites give the sitemap as a path ("Sitemap: /sitemap.do?..."), so resolve it against the site.
  const starts = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].flatMap((match) => {
    try { return [new URL(match[1], origin).toString()]; } catch { return []; }
  });
  if (!starts.length) starts.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`);
  const pages = new Set();
  const queue = [...new Set(starts)];
  let fetched = 0;
  while (queue.length && fetched < 12 && pages.size < 8000) {
    if (fetched) await sleep(1000);
    const xml = await getText(queue.shift());
    fetched += 1;
    if (!xml) continue;
    if (/<sitemapindex/i.test(xml)) {
      // Post, tag and author sitemaps are news; page and program sitemaps are what we want.
      const children = locs(xml).filter((url) => !/post|tag|author|category|news|event|attachment|video/i.test(url) || /scholar|page|program/i.test(url));
      queue.push(...children);
    } else {
      for (const url of locs(xml)) pages.add(url);
    }
  }
  return [...pages];
}

export function linksOn(html, baseUrl) {
  const out = [];
  for (const match of html.matchAll(/<a\b[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), baseUrl);
      if (!/^https?:$/.test(url.protocol)) continue;
      url.hash = "";
      out.push({ url: url.toString(), text: match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() });
    } catch { /* skip malformed links */ }
  }
  return out;
}

export function scoreUrl(url, linkText = "") {
  // The query string counts too: some sites name every page there ("/en?id=smart_eligibility").
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`.toLowerCase().replace(/_/g, "-");
  if (BAD.test(path)) return 0;
  const target = `${path} ${linkText.toLowerCase()}`;
  let score = 0;
  for (const [pattern, points] of GOOD) if (pattern.test(target)) score += points;
  // Deep paths are usually individual stories, not program pages.
  return score - Math.max(0, parsed.pathname.split("/").filter(Boolean).length - 4);
}

// "/our-scholarships/college-scholarship-program/faqs/" -> "/our-scholarships/college-scholarship-program"
export function programKey(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const parent = segments.findIndex((segment) => PROGRAM_PARENT.test(segment.toLowerCase()));
  if (parent >= 0 && segments[parent + 1]) return `/${segments.slice(0, parent + 2).join("/")}`;
  const named = segments.findIndex((segment) => /scholarship|fellowship/i.test(segment));
  return named >= 0 ? `/${segments.slice(0, named + 1).join("/")}` : "/";
}

// Addresses like "interior.aspx?pgid=1876" or "/en?id=eligibility" carry their identity in the
// query string, so it is kept. Tracking, sorting and paging parameters are dropped.
const NOISE_PARAM = /^(utm_.*|fbclid|gclid|msclkid|mc_[a-z]+|ref|source|share|replytocom|sort|order|orderby|page|paged|lang|hsa_.*|_ga|_gl)$/i;
export function cleanUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) if (NOISE_PARAM.test(name)) parsed.searchParams.delete(name);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/(\?|$)/, (match, tail) => (parsed.pathname === "/" ? tail : match)).replace(/\?$/, "");
}

export async function discover(startUrl, startHtml, { maxPrograms = 8, pagesPerProgram = 6, robotsText = null } = {}) {
  const start = new URL(startUrl);
  const startClean = cleanUrl(startUrl);
  const startPath = start.pathname.replace(/\/$/, "");
  const sameSite = (url) => new URL(url).host.replace(/^www\./, "") === start.host.replace(/^www\./, "");
  const candidates = new Map();
  const add = (url, text = "", bonus = 0) => {
    if (!sameSite(url)) return;
    const clean = cleanUrl(url);
    // Pages the site asks crawlers to stay out of are never candidates.
    const target = new URL(clean);
    if (!rules.allowed(`${target.pathname}${target.search}`)) return;
    const base = scoreUrl(clean, text);
    if (base <= 0) return;
    const existing = candidates.get(clean);
    // A page the start page links to with relevant wording is very likely part of the same scholarship.
    if (!existing || base + bonus > existing.score) candidates.set(clean, { url: clean, score: base + bonus, linked: bonus > 0 || existing?.linked || false });
  };
  const robots = robotsText ?? await getText(`${start.origin}/robots.txt`);
  const rules = parseRobots(robots);
  const crawlDelay = Number((robots.match(/^crawl-delay:\s*(\d+(?:\.\d+)?)/im) || [])[1] || 0);
  const fromSitemap = await sitemapUrls(start.origin, robots);
  for (const url of fromSitemap) add(url);
  for (const link of linksOn(startHtml, startUrl)) add(link.url, link.text, 3);
  candidates.delete(startClean);

  const top = (pool, count) => pool.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, count);
  const startEntry = { url: startClean, score: 99 };
  const withStart = (key, pool) => ({ key, pages: [startEntry, ...top(pool, pagesPerProgram - 1)] });
  const summary = { sitemapCount: fromSitemap.length, candidateCount: candidates.size, crawlDelay };

  // Case 1: the start address is a page inside the site. That page is the scholarship; add
  // its siblings (same folder or same program path) and the relevant pages it links to.
  if (startPath) {
    const programPath = programKey(startUrl);
    const folder = startPath.split("/").slice(0, -1).join("/");
    // "/smart" has no folder above it; the pages beneath it ("/smart/en?id=...") are its own.
    const scope = programPath !== "/" ? programPath : folder;
    const under = (candidate) => { const path = new URL(candidate.url).pathname; return (scope && path.startsWith(`${scope}/`)) || path.startsWith(`${startPath}/`); };
    const pool = [...candidates.values()]
      // A linked page that sits in a different scholarship's folder belongs to that scholarship, not this one.
      .filter((candidate) => under(candidate)
        || (candidate.linked && (programPath === "/" || [programPath, "/"].includes(programKey(candidate.url)))))
      .map((candidate) => ({ ...candidate, score: candidate.score + (under(candidate) ? 2 : 0) }));
    return { ...summary, programs: [withStart(scope || "/", pool)] };
  }

  // Case 2: the start address is the site's home page. If the site keeps each scholarship in
  // its own folder under "scholarships/programs", make one bundle per folder.
  const programs = new Map();
  for (const candidate of candidates.values()) {
    const key = programKey(candidate.url);
    const segments = key.split("/").filter(Boolean);
    if (segments.length < 2 || !PROGRAM_PARENT.test(segments.at(-2).toLowerCase())) continue;
    if (!programs.has(key)) programs.set(key, []);
    programs.get(key).push(candidate);
  }
  // A real program folder has more than one page; single pages there are usually stories.
  const structured = [...programs.entries()].filter(([, pages]) => pages.length >= 2);
  if (structured.length) {
    const ranked = structured
      .map(([key, pages]) => ({ key, pages: top(pages, pagesPerProgram) }))
      .sort((a, b) => b.pages.reduce((sum, page) => sum + page.score, 0) - a.pages.reduce((sum, page) => sum + page.score, 0))
      .slice(0, maxPrograms);
    return { ...summary, programs: ranked };
  }
  // Otherwise treat the whole site as one scholarship: the home page plus its best pages.
  return { ...summary, programs: [withStart("/", [...candidates.values()])] };
}
