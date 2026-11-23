// Give it a scholarship site; it finds the relevant pages, splits them per scholarship,
// condenses each to a short digest and fills metadata by keyword rules.
//   node site.mjs https://www.jkcf.org/ [--programs 8] [--pages 6] [--quiet]
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser } from "./lib/fetcher.mjs";
import { analyzeSite } from "./lib/pipeline.mjs";
import { repoRoot } from "./lib/store.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? Number(args[args.indexOf(`--${name}`) + 1]) : fallback);
const startUrl = args.find((value) => /^https?:\/\//.test(value));
if (!startUrl) { console.error("Usage: node site.mjs <site address>"); process.exit(1); }
const quiet = args.includes("--quiet");
const started = Date.now();

const result = await analyzeSite(startUrl, {
  maxPrograms: option("programs", 8), pagesPerProgram: option("pages", 6), maxDelaySeconds: option("max-delay", 3),
  log: (message) => console.log(`   ${message}`),
});
await closeBrowser();

console.log(`\nSITE  ${startUrl}${result.crawlDelay ? `  (site asks for ${result.crawlDelay}s between requests; using ${result.gapMs / 1000}s)` : ""}`);
if (result.blocked) {
  console.log(`  BLOCKED: the site refuses automated visitors (HTTP ${result.status}). Add it to the manual-entry list.\n`);
} else if (result.error) {
  console.log(`  FAILED: ${result.error}\n`);
} else {
  console.log(`  ${result.sitemapCount} addresses in sitemaps, ${result.candidateCount} look relevant, grouped into ${result.scholarships.length} scholarship(s)\n`);
}

for (const scholarship of result.scholarships) {
  const { sizes, metadata } = scholarship;
  console.log(`━━ ${scholarship.name}`);
  for (const page of scholarship.pages) console.log(`   page  ${page.url}${page.renderError ? "  (needs a browser to render)" : ""}`);
  console.log(`   size  raw HTML ~${sizes.rawHtmlTokens.toLocaleString()} tokens -> cleaned ~${sizes.cleanTokens.toLocaleString()} -> digest ~${sizes.digestTokens.toLocaleString()} (${sizes.digestLines} lines)`);
  console.log("   metadata");
  for (const [field, entry] of Object.entries(metadata)) {
    if (field === "tags" || field === "doubts") continue;
    const value = Array.isArray(entry.value) ? entry.value.join(", ") : String(entry.value);
    const why = entry.assumed ? "(not mentioned; assumed)" : `"${(entry.evidence || "").slice(0, 110)}"`;
    console.log(`     ${field.padEnd(16)} ${value.padEnd(26)} ${why}`);
  }
  console.log(`     ${"tags".padEnd(16)} ${Object.keys(metadata.tags).join(", ") || "none"}`);
  for (const item of metadata.doubts) console.log(`     ${"! doubt".padEnd(16)} ${item.field}: ${item.reason}  "${(item.evidence || "").slice(0, 90)}"`);
  if (!quiet) console.log(`   digest\n${scholarship.digest.map((line) => `     - ${line.text}`).join("\n")}`);
  console.log("");
}

const outDir = join(repoRoot, "data", "raw", "sites");
await mkdir(outDir, { recursive: true });
const fileName = `${new URL(startUrl).host.replace(/^www\./, "")}.json`;
await writeFile(join(outDir, fileName), JSON.stringify({ ...result, fetchedAt: new Date().toISOString() }, null, 2));
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s. Saved to data/raw/sites/${fileName}`);
