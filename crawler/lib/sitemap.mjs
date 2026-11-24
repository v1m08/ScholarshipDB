// Find a scholarship's own page on a site from the site's sitemap: the list of its pages
// that the site itself publishes for crawlers. No guessing of addresses and no site search.
import { gunzipSync } from "node:zlib";
import { USER_AGENT } from "./fetcher.mjs";
import { core } from "./named-reader.mjs";

const MAX_URLS = 60000;
const MAX_CHILDREN = 25;
const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((match) => match[1].replace(/&amp;/g, "&"));

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!response.ok) return "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 30e6) return "";
  // Some sitemaps are served compressed.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) { try { return gunzipSync(bytes).toString("utf8"); } catch { return ""; } }
  return bytes.toString("utf8");
}

// Every page address the site lists, up to a limit. `robotsText` is the site's robots.txt,
// which usually names the sitemap; the two usual addresses are tried when it does not.
export async function sitemapUrls(origin, robotsText = "", { allowed = () => true } = {}) {
  const named = [...robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((match) => match[1]);
  const queue = named.length ? named : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`, `${origin}/sitemap-index.xml`];
  const seen = new Set();
  const urls = new Set();
  let children = 0;
  while (queue.length && urls.size < MAX_URLS) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    let xml = "";
    try { xml = await fetchText(next); } catch { continue; }
    if (!xml) continue;
    const found = locs(xml);
    if (/<sitemapindex/i.test(xml)) {
      // An index of sitemaps: the ones about scholarships and ordinary pages first.
      const ranked = found.sort((a, b) => Number(/scholar|fund|award|grant|page/i.test(b)) - Number(/scholar|fund|award|grant|page/i.test(a)));
      for (const child of ranked) { if (children >= MAX_CHILDREN) break; children += 1; queue.push(child); }
      continue;
    }
    for (const url of found) {
      if (urls.size >= MAX_URLS) break;
      try { const parsed = new URL(url); if (allowed(`${parsed.pathname}${parsed.search}`)) urls.add(parsed.toString()); } catch { /* not an address */ }
    }
  }
  return [...urls];
}

// The words in the last part of an address: ".../scholarships/jane-doe-memorial/" -> "jane doe memorial".
const slugWords = (url) => {
  try {
    const parts = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
    return ` ${core(parts.slice(-2).join(" ").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+.]/g, " "))} `;
  } catch { return " "; }
};
const NOT_A_PAGE = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|zip|mp4|xml)(\?|$)/i;
// News and blog posts mention scholarships without describing how to get one.
const NEWS = /\/(news|blog|press|stories|story|events?|media|announcements?|articles?|category|tag|author|\d{4}\/\d{2})\//i;
const ABOUT_AWARD = /scholar|fellow|award|grant|fund|prize/i;

// For each name, the addresses whose last part spells that name. A name needs at least two
// distinguishing words ("Jane Doe"), all of them in the address (one may be missing from four or more).
export function candidatesFor(names, urls, { perName = 2 } = {}) {
  const pages = urls.filter((url) => !NOT_A_PAGE.test(url) && !(NEWS.test(url) && !ABOUT_AWARD.test(url.split("/").filter(Boolean).at(-1) || ""))).map((url) => ({ url, words: slugWords(url) }));
  const out = new Map();
  for (const name of names) {
    const words = [...new Set(core(name).split(" ").filter((word) => word.length > 1))];
    if (words.length < 2) continue;
    const need = words.length >= 4 ? words.length - 1 : words.length;
    const hits = [];
    for (const page of pages) {
      const have = words.filter((word) => page.words.includes(` ${word} `)).length;
      if (have >= need) hits.push({ url: page.url, score: have / words.length - page.words.trim().split(" ").length / 100 });
    }
    if (hits.length) out.set(name, hits.sort((a, b) => b.score - a.score).slice(0, perName).map((hit) => hit.url));
  }
  return out;
}
