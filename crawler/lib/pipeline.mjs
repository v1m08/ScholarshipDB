// The whole flow for one site: find pages, group them per scholarship, clean, condense,
// and fill metadata. Returns data only; printing and saving belong to the callers.
import { cleanLines } from "./clean.mjs";
import { buildDigest, extractMetadata } from "./digest.mjs";
import { discover } from "./discover.mjs";
import { fetchPage, pageTitle, politePool } from "./fetcher.mjs";

const tokens = (chars) => Math.round(chars / 4);
const BLOCK_PAGE = /just a moment|attention required|access denied|are you a robot|captcha/i;

export async function analyzeSite(startUrl, { maxPrograms = 8, pagesPerProgram = 6, maxDelaySeconds = 3, log = () => {} } = {}) {
  let startPage;
  try {
    startPage = await fetchPage(startUrl);
  } catch (error) {
    return { site: startUrl, error: error.message.split("\n")[0].slice(0, 120), scholarships: [] };
  }
  // A site that refuses automated visitors is recorded as blocked, never worked around.
  if ([401, 403, 429].includes(startPage.status) || (startPage.status >= 400 && BLOCK_PAGE.test(pageTitle(startPage.html)))) {
    return { site: startUrl, blocked: true, status: startPage.status, scholarships: [] };
  }
  if (startPage.status >= 400) return { site: startUrl, error: `HTTP ${startPage.status}`, scholarships: [] };

  const found = await discover(startPage.finalUrl || startUrl, startPage.html, { maxPrograms, pagesPerProgram });
  const gapMs = found.crawlDelay ? Math.min(found.crawlDelay, maxDelaySeconds) * 1000 : 300;
  const scholarships = [];
  for (const program of found.programs) {
    const pages = [];
    await politePool(program.pages, { concurrency: found.crawlDelay ? 1 : 3, keyOf: () => "site", gapMs }, async (candidate) => {
      try {
        let page = await fetchPage(candidate.url);
        if (page.status === 429 || page.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          page = await fetchPage(candidate.url);
        }
        if (page.status >= 400) { log(`skip ${candidate.url} (HTTP ${page.status})`); return; }
        pages.push({ url: candidate.url, score: candidate.score, title: pageTitle(page.html), rawChars: page.html.length, lines: cleanLines(page.html), method: page.method, renderError: page.renderError });
      } catch (error) {
        log(`skip ${candidate.url} (${error.message.split("\n")[0].slice(0, 60)})`);
      }
    });
    if (!pages.length) continue;
    pages.sort((a, b) => b.score - a.score);
    // Two addresses can serve the same page ("/smart" and "/smart/en"); keep the first.
    const seenText = new Set();
    for (let i = 0; i < pages.length; i += 1) {
      const text = pages[i].lines.join("\n");
      if (seenText.has(text)) pages.splice(i--, 1); else seenText.add(text);
    }
    const cleanChars = pages.reduce((sum, page) => sum + page.lines.join("\n").length, 0);
    const digest = buildDigest(pages);
    // Rules read every cleaned line, not only the digest: a short statement such as
    // "There is no fee" may not rank into the digest but still settles a field.
    const metadata = extractMetadata(pages.flatMap((page) => page.lines.map((line) => ({ text: line.replace(/^[#-] /, ""), heading: line.startsWith("# "), url: page.url }))));
    const rootPage = pages.find((page) => page.url.replace(/\/$/, "").endsWith(program.key)) || pages[0];
    scholarships.push({
      name: rootPage.title.split(/ [-|–] /)[0].trim() || program.key,
      key: program.key,
      pages: pages.map(({ url, title, method, renderError }) => ({ url, title, method, renderError })),
      sizes: { rawHtmlTokens: tokens(pages.reduce((sum, page) => sum + page.rawChars, 0)), cleanTokens: tokens(cleanChars), digestTokens: tokens(digest.text.length), digestLines: digest.lines.length },
      metadata,
      digest: digest.lines.map(({ text, categories, url }) => ({ text, categories, url })),
    });
  }
  return { site: startUrl, sitemapCount: found.sitemapCount, candidateCount: found.candidateCount, crawlDelay: found.crawlDelay, gapMs, scholarships };
}
