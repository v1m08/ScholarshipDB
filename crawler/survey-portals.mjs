// Job 1: visit every portal in data/registry/portals.json once, store the page, and record
// what a signed-out visitor can see: is it the right school, is there a sign-in wall, and
// how many awards are listed. Resumable; rerun to retry errors with --retry-errors.
// Usage: node survey-portals.mjs [--platform academicworks] [--limit 50] [--concurrency 4]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser, fetchPage, pageTitle, politePool, visibleText } from "./lib/fetcher.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Where a signed-out visitor would find the list of awards, and whether the platform is a
// JavaScript app that always needs rendering.
const PLATFORMS = {
  academicworks: { path: "/opportunities", render: "auto" },
  scholarshipuniverse: { path: "/", render: "always" },
  awardspring: { path: "/", render: "auto" },
  communityforce: { path: "/", render: "auto" },
};

const SIGN_IN = /\b(sign in|sign-in|log ?in|single sign[- ]on|sso|netid|password|authenticate)\b/i;
const STOP_WORDS = new Set(["university", "college", "of", "the", "at", "and", "community", "state", "institute", "school", "campus", "technical", "main"]);

function ownershipMatch(text, names) {
  const haystack = text.toLowerCase();
  return names.some((name) => {
    const words = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word));
    return words.length > 0 && words.every((word) => haystack.includes(word));
  });
}

function countAwards(platform, html) {
  if (platform === "academicworks") return new Set(html.match(/href="\/opportunities\/\d+"/g) || []).size;
  // Unknown layouts: count distinct links whose address or text mentions a scholarship.
  const links = html.match(/<a\b[^>]*href="[^"]*"[^>]*>[\s\S]{0,200}?<\/a>/gi) || [];
  return new Set(links.filter((link) => /scholarship|award|opportunit/i.test(link)).map((link) => link.match(/href="([^"]*)"/)[1])).size;
}

async function main() {
  const { portals } = JSON.parse(await readFile(join(repoRoot, "data", "registry", "portals.json"), "utf8"));
  const { institutions } = JSON.parse(await readFile(join(repoRoot, "data", "registry", "institutions.json"), "utf8"));
  const nameOf = new Map(institutions.map((institution) => [institution.unitid, institution.name]));
  const job = await openJob("portal-survey");

  const onlyPlatform = arg("platform", null);
  const limit = Number(arg("limit", 0));
  let todo = portals.filter((portal) => PLATFORMS[portal.platform] && (!onlyPlatform || portal.platform === onlyPlatform));
  if (limit) todo = todo.slice(0, limit);
  const total = todo.length;
  todo = todo.filter((portal) => {
    const previous = job.done.get(portal.host);
    return !previous || (flag("retry-errors") && previous.error);
  });
  console.log(`${total} portals selected, ${total - todo.length} already done, ${todo.length} to fetch`);

  let finished = 0;
  await politePool(todo, {
    concurrency: Number(arg("concurrency", 4)),
    keyOf: (portal) => portal.platform,
    gapMs: 400,
  }, async (portal) => {
    const config = PLATFORMS[portal.platform];
    const url = `https://${portal.host}${config.path}`;
    const row = { key: portal.host, platform: portal.platform, url, unitids: portal.unitids, fetchedAt: new Date().toISOString() };
    try {
      const page = await fetchPage(url, { render: config.render });
      const text = visibleText(page.html);
      const finalHost = new URL(page.finalUrl).host;
      Object.assign(row, {
        status: page.status,
        finalUrl: page.finalUrl,
        method: page.method,
        renderError: page.renderError,
        elapsedMs: page.elapsedMs,
        title: pageTitle(page.html),
        textLength: text.length,
        leftPlatform: finalHost !== portal.host,
        signInWords: SIGN_IN.test(text),
        awardLinks: countAwards(portal.platform, page.html),
        ownershipMatch: ownershipMatch(`${pageTitle(page.html)} ${text.slice(0, 3000)}`, portal.unitids.map((unitid) => nameOf.get(unitid) || "")),
        sha: await job.savePage(page.html),
      });
    } catch (error) {
      row.error = error.message.split("\n")[0].slice(0, 200);
    }
    await job.record(row);
    finished += 1;
    if (finished % 25 === 0 || finished === todo.length) console.log(`  ${finished}/${todo.length}`);
  });
  await closeBrowser();

  const rows = [...job.done.values()];
  const summary = {};
  for (const row of rows) {
    const bucket = summary[row.platform] ||= { portals: 0, errors: 0, rendered: 0, needsBrowser: 0, leftPlatform: 0, ownershipMatch: 0, withAwards: 0, awardLinks: 0 };
    bucket.portals += 1;
    if (row.error) { bucket.errors += 1; continue; }
    if (row.method === "browser") bucket.rendered += 1;
    if (row.renderError) bucket.needsBrowser += 1;
    if (row.leftPlatform) bucket.leftPlatform += 1;
    if (row.ownershipMatch) bucket.ownershipMatch += 1;
    if (row.awardLinks > 0) bucket.withAwards += 1;
    bucket.awardLinks += row.awardLinks;
  }
  console.table(summary);
  console.log(`Results: data/raw/portal-survey/results.jsonl (${rows.length} portals)`);
}

await main();
