// Scholarship listing sites that are not tied to one college. From each one we take only
// leads: the scholarship's name, who offers it, and the address of the provider's own page.
// Descriptions and requirements are never copied from these sites; they are read later from
// the provider's page. Each site lists its scholarship pages in a sitemap.
import { decodeEntities } from "./clean.mjs";

const clean = (html) => decodeEntities((html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const attr = (value) => decodeEntities(value || "").trim();
const titleOf = (html, suffix) => clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).replace(suffix, "").trim();
const firstHref = (html, pattern) => attr((html.match(pattern) || [])[1]) || null;

export const LISTING_SITES = [
  {
    id: "bigfuture",
    name: "BigFuture Scholarship Search (College Board)",
    sitemap: "https://bigfuture.collegeboard.org/scholarships/sitemap.xml",
    page: /^https:\/\/bigfuture\.collegeboard\.org\/scholarships\/(?!sitemap\.xml$)[^/?]+$/,
    gapMs: 700,
    leads(html) {
      const json = (html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
      if (!json) return [];
      const data = JSON.parse(json)?.props?.pageProps?.data;
      if (!data?.scholarshipName) return [];
      return [{ name: data.scholarshipName, provider: data.programOrgName || null, url: data.programUrl || data.applicationUrl || null }];
    },
  },
  {
    id: "fastweb",
    name: "Fastweb",
    sitemap: "https://www.fastweb.com/sitemap.xml.gz",
    childSitemaps: /\/sitemapS\d*\.xml\.gz$/,
    page: /^https:\/\/www\.fastweb\.com\/college-scholarships\/scholarships\/[^/?]+$/,
    gapMs: 700,
    leads(html) {
      // The page's structured data names the funder and the funder's own address.
      const funder = html.match(/"funder":\{"@type":"Organization","name":"((?:[^"\\]|\\.)*)"(?:,"url":"((?:[^"\\]|\\.)*)")?/);
      const unescape = (value) => (value ? JSON.parse(`"${value}"`) : null);
      return [{ name: titleOf(html, /\s*\|\s*Fastweb.*$/i), provider: funder ? unescape(funder[1]) : null, url: funder ? unescape(funder[2]) : null }];
    },
  },
  {
    id: "scholarships360",
    name: "Scholarships360",
    sitemap: "https://scholarships360.org/sitemap.xml",
    childSitemaps: /scholarship_new-sitemap/,
    page: /^https:\/\/scholarships360\.org\/scholarships\/search\/[^/?]+\/?$/,
    gapMs: 1000,
    leads(html) {
      return [{ name: titleOf(html, /\s*[-|]\s*Scholarships360.*$/i), provider: null, url: firstHref(html, /re-scholarship-main-learn-on-website[\s\S]{0,200}?<a href="([^"]+)"/) }];
    },
  },
  {
    id: "access-scholarships",
    name: "Access Scholarships",
    sitemap: "https://accessscholarships.com/sitemap_index.xml",
    childSitemaps: /\/scholarship-sitemap\d*\.xml/,
    page: /^https:\/\/accessscholarships\.com\/scholarship\/[^/?]+\/?$/,
    gapMs: 1000,
    leads(html) {
      return [{ name: titleOf(html, /\s*[-|]\s*Access Scholarships.*$/i), provider: null, url: firstHref(html, /<a href="(https?:\/\/[^"]+)"[^>]*class="[^"]*ajax_apply/) }];
    },
  },
  {
    id: "sallie",
    name: "Sallie scholarship search (Scholly)",
    sitemap: "https://www.sallie.com/sitemap.xml",
    page: /^https:\/\/www\.sallie\.com\/scholarships\/scholly\/[^/?]+$/,
    gapMs: 1000,
    leads(html) {
      return [{ name: titleOf(html, /\s*[-|]\s*Sallie.*$/i), provider: null, url: firstHref(html, /scholarship-apply-popup__secondary"\s+href="(https?:\/\/[^"]+)"/) }];
    },
  },
  {
    id: "petersons",
    name: "Peterson's scholarship search",
    sitemap: "https://www.petersons.com/sitemap.xml",
    childSitemaps: /scholar_site_map/,
    page: /^https:\/\/www\.petersons\.com\/scholarship\/[^/?]+\.aspx$/,
    gapMs: 1000,
    leads(html) {
      const name = titleOf(html, /\s*[-|]\s*Apply for Scholarships.*$/i);
      // A scholarship that was removed redirects to the search page.
      if (/^Scholarship Search Engine/i.test(name)) return [];
      return [{ name, provider: null, url: firstHref(html, /class="btn btn-rmi[^"]*"[^>]*href="(https?:\/\/[^"]+)"/) || firstHref(html, /<a href="(https?:\/\/[^"]+)"[^>]*>\s*For more info, please visit/) }];
    },
  },
  {
    // A weekly newsletter-style post listing about ten scholarships, each linked to its provider.
    id: "jlv",
    name: "JLV College Counseling (Scholarship Saturday)",
    sitemap: "https://jlvcollegecounseling.com/sitemap.xml",
    page: /^https:\/\/jlvcollegecounseling\.com\/20\d\d\/\d\d\/\d\d\/[^/?]*scholarship[^/?]*\/?$/,
    gapMs: 1500,
    leads(html) {
      const out = [];
      for (const match of html.matchAll(/<strong>\s*<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/strong>(?:\s*<br\s*\/?>\s*<strong>Sponsor<\/strong>:\s*([^<]*))?/g)) {
        const name = clean(match[2]);
        // Links to the site's own earlier posts ("November", "last Scholarship Saturday") are not scholarships.
        if (name.length >= 4 && !/jlvcollegecounseling\.com|wp\.me/i.test(match[1])) out.push({ name, provider: clean(match[3]) || null, url: attr(match[1]) });
      }
      return out;
    },
  },
];

// Links that point back at a listing site, a social network or an app store are not a
// provider's own page.
const NOT_A_PROVIDER = /(^|\.)(collegeboard\.org|scholarships360\.org|accessscholarships\.com|sallie\.com|salliemae\.com|petersons\.com|jlvcollegecounseling\.com|bold\.org|fastweb\.com|scholarships\.com|niche\.com|unigo\.com|appily\.com|cappex\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|apple\.com|google\.com|wp\.me)$/i;

export function tidyLeads(leads) {
  const out = [];
  for (const lead of leads) {
    const name = (lead.name || "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    let url = null;
    try {
      const parsed = new URL(lead.url);
      if (/^https?:$/.test(parsed.protocol) && !NOT_A_PROVIDER.test(parsed.host)) url = parsed.toString();
    } catch { /* no usable address; the lead is kept by name */ }
    out.push({ name, provider: lead.provider ? lead.provider.replace(/\s+/g, " ").trim() : null, url });
  }
  return out;
}
