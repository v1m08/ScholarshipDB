// Job 2: for every portal the survey found open, walk its award lists and record one line
// per portal with every award link on it. Reads data/raw/portal-survey/results.jsonl,
// writes data/raw/portal-links/results.jsonl. Resumable; --retry-errors retries failures.
// Usage: node collect-portal-links.mjs [--limit 20] [--concurrency 3]
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectPortal } from "./lib/academicworks.mjs";
import { fetchPage, politePool } from "./lib/fetcher.mjs";
import { openJob, repoRoot } from "./lib/store.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

// Only AcademicWorks has a reader so far; other platforms are added here as they are built.
const COLLECTORS = { academicworks: collectPortal };

// "All Opportunities - Alamo Colleges District Scholarships" -> "Alamo Colleges District"
const portalName = (title) => (title || "").replace(/^.*? - /, "").replace(/\s+scholarships?( opportunities)?$/i, "").trim();

async function main() {
  let survey;
  try {
    survey = (await readFile(join(repoRoot, "data", "raw", "portal-survey", "results.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    console.error("No survey results found. Run survey-portals.mjs first.");
    process.exit(1);
  }
  // Later lines win, so a retried portal uses its newest survey result.
  const latest = new Map(survey.map((row) => [row.key, row]));
  const open = [...latest.values()].filter((row) => COLLECTORS[row.platform] && !row.error && row.status === 200 && row.awardLinks > 0 && !row.leftPlatform && !/sign_in/.test(row.finalUrl || ""));
  const job = await openJob("portal-links");
  const limit = Number(arg("limit", 0));
  let todo = limit ? open.slice(0, limit) : open;
  const total = todo.length;
  todo = todo.filter((row) => { const previous = job.done.get(row.key); return !previous || (process.argv.includes("--retry-errors") && previous.error); });
  console.log(`${latest.size} portals surveyed, ${open.length} open with awards; ${total} selected, ${total - todo.length} already done, ${todo.length} to walk`);

  // One request at a time per portal; the gap is shared across the whole platform.
  const gapMs = 350;
  let nextSlot = 0;
  const get = async (url) => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + gapMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    let page = await fetchPage(url, { render: "never" });
    if (page.status === 429 || page.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      page = await fetchPage(url, { render: "never" });
    }
    return page;
  };

  let finished = 0;
  await politePool(todo, { concurrency: Number(arg("concurrency", 3)), keyOf: (row) => row.key, gapMs: 0 }, async (portal) => {
    const row = { key: portal.key, platform: portal.platform, unitids: portal.unitids, portalName: portalName(portal.title), collectedAt: new Date().toISOString() };
    try {
      Object.assign(row, await COLLECTORS[portal.platform](portal.key, get));
    } catch (error) {
      row.error = error.message.split("\n")[0].slice(0, 200);
    }
    await job.record(row);
    finished += 1;
    console.log(`  ${finished}/${todo.length}  ${portal.key}  ${row.error ? `ERROR ${row.error}` : `${row.awards.length} awards on ${row.pages} pages${row.signIn ? " (sign-in)" : ""}`}`);
  });

  const rows = [...job.done.values()];
  const awards = rows.reduce((sum, row) => sum + (row.awards?.length || 0), 0);
  const outside = rows.reduce((sum, row) => sum + (row.awards?.filter((award) => award.external).length || 0), 0);
  console.log(`\n${rows.length} portals walked, ${rows.filter((row) => row.error).length} errors, ${awards} award links (${outside} from outside organizations)`);
  console.log("Results: data/raw/portal-links/results.jsonl");
}

await main();
