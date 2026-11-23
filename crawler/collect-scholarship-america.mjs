// Scholarship America publishes one page per program and lists them all in a sitemap.
// Writes data/raw/scholarship-america/results.jsonl, one line per program page.
// Usage: node collect-scholarship-america.mjs
import { USER_AGENT } from "./lib/fetcher.mjs";
import { openJob } from "./lib/store.mjs";

const SITEMAP = "https://scholarshipamerica.org/scholarship-sitemap.xml";
const response = await fetch(SITEMAP, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30000) });
if (!response.ok) { console.error(`Sitemap returned HTTP ${response.status}`); process.exit(1); }
const urls = [...(await response.text()).matchAll(/<loc>\s*([^<\s]+)/g)].map((match) => match[1]).filter((url) => /\/scholarship\/[^/]+\/?$/.test(url));
const job = await openJob("scholarship-america");
let added = 0;
for (const url of urls) {
  if (job.done.has(url)) continue;
  // The address is the only name available here; the real title is read when the page is scraped.
  const slug = url.replace(/\/$/, "").split("/").pop();
  await job.record({ key: url, url, slug, name: slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "), collectedAt: new Date().toISOString() });
  added += 1;
}
console.log(`${urls.length} programs in the sitemap, ${added} new. Results: data/raw/scholarship-america/results.jsonl`);
