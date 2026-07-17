import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PAGE_SIZE = 1000;
const COLUMNS = [
  "id", "title", "provider", "source_name", "source_url", "source_urls",
  "source_checked_at", "application_url", "deadline", "description", "award",
  "requirements", "eligibility", "vetting", "publication_status", "updated_at",
].join(",");
const GENERIC_TITLE_WORDS = new Set([
  "application", "applications", "award", "awards", "fund", "funds", "grant",
  "grants", "program", "programs", "scholarship", "scholarships",
]);

async function loadEnvironment() {
  for (const filename of [".env.local", ".env"]) {
    try {
      for (const line of (await readFile(filename, "utf8")).split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
      }
    } catch {}
  }
}

function words(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(spring|summer|fall|autumn|winter)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function duplicateKey(record) {
  const providerWords = words(record.provider);
  const provider = providerWords.join(" ");
  const providerSet = new Set(providerWords);
  const title = words(record.title)
    .filter((word) => !providerSet.has(word) && !GENERIC_TITLE_WORDS.has(word))
    .join(" ");
  return provider && title ? `${provider}|${title}` : null;
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return "";
  }
}

function directApplication(record) {
  try {
    return new URL(record.application_url).hostname !== new URL(record.source_url).hostname;
  } catch {
    return false;
  }
}

function titleCompatibility(a, b) {
  if (normalizedUrl(a.application_url) && normalizedUrl(a.application_url) === normalizedUrl(b.application_url)) {
    return true;
  }
  const left = new Set(words(a.title).filter((word) => !GENERIC_TITLE_WORDS.has(word)));
  const right = new Set(words(b.title).filter((word) => !GENERIC_TITLE_WORDS.has(word)));
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (!smaller.size) return false;
  let overlap = 0;
  for (const word of smaller) if (larger.has(word)) overlap += 1;
  return overlap / smaller.size >= 0.75;
}

function completeness(record) {
  let score = 0;
  if (record.deadline) score += 2;
  if ((record.description || "").trim().length >= 80) score += 2;
  if (record.award?.maximum !== null && record.award?.maximum !== undefined) score += 2;
  if (record.award?.minimum !== null && record.award?.minimum !== undefined) score += 1;
  score += Object.values(record.requirements || {}).filter((value) => value !== null && value !== undefined).length;
  for (const value of Object.values(record.eligibility || {})) {
    if (Array.isArray(value) && value.length) score += 1;
    else if (value !== null && value !== undefined && !Array.isArray(value) && value !== "unknown") score += 1;
  }
  return score;
}

function vettingScore(record) {
  if (record.vetting?.status === "human") return 2;
  if (record.vetting?.status === "ai") return 1;
  return 0;
}

function deadlineScore(record, today) {
  if (!record.deadline) return 0;
  return record.deadline >= today ? 2 : 1;
}

function compareCandidates(a, b, today) {
  const aScores = [
    vettingScore(a), deadlineScore(a, today), completeness(a), Number(directApplication(a)),
    Date.parse(a.source_checked_at || 0) || 0, Date.parse(a.updated_at || 0) || 0,
  ];
  const bScores = [
    vettingScore(b), deadlineScore(b, today), completeness(b), Number(directApplication(b)),
    Date.parse(b.source_checked_at || 0) || 0, Date.parse(b.updated_at || 0) || 0,
  ];
  for (let index = 0; index < aScores.length; index += 1) {
    if (aScores[index] !== bScores[index]) return bScores[index] - aScores[index];
  }
  return a.id.localeCompare(b.id);
}

function sourceUrls(records) {
  return [...new Set(records.flatMap((record) => [record.source_url, ...(record.source_urls || [])]).filter(Boolean))].sort();
}

function matchesTitle(record, query) {
  const queryWords = words(query);
  const titleWords = new Set(words(record.title));
  return record.id === query || queryWords.every((word) => titleWords.has(word));
}

export function planDuplicatePrune(records, options = {}) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const groups = new Map();
  for (const record of records) {
    const key = duplicateKey(record);
    if (key) groups.set(key, [...(groups.get(key) || []), record]);
  }

  let selectedKeys = null;
  if (options.title) {
    selectedKeys = new Set(records.filter((record) => matchesTitle(record, options.title)).map(duplicateKey).filter(Boolean));
  }

  const plans = [];
  const skipped = [];
  for (const [key, group] of groups) {
    if (group.length < 2 || (selectedKeys && !selectedKeys.has(key))) continue;
    if (!group.every((record, index) => index === 0 || titleCompatibility(group[0], record))) {
      skipped.push({ key, reason: "titles are not similar enough for automatic deletion", ids: group.map((row) => row.id) });
      continue;
    }
    if (group.filter((record) => record.vetting?.status === "human").length > 1) {
      skipped.push({ key, reason: "multiple human-vetted records require manual review", ids: group.map((row) => row.id) });
      continue;
    }
    const requested = options.keep ? group.find((record) => record.id === options.keep) : null;
    if (options.keep && !requested) continue;
    const ranked = [...group].sort((a, b) => compareCandidates(a, b, today));
    const survivor = requested || ranked[0];
    plans.push({
      key,
      survivor,
      duplicates: group.filter((record) => record.id !== survivor.id),
      sourceUrls: sourceUrls(group),
    });
  }
  return { plans, skipped };
}

export function parseOptions(args) {
  const options = { title: null, keep: null, yes: false, all: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes") options.yes = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--title") options.title = args[++index];
    else if (argument === "--keep") options.keep = args[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.title === undefined || options.keep === undefined) throw new Error("--title and --keep require a value.");
  if (options.keep && !options.title) throw new Error("--keep must be used with --title.");
  if (options.yes && !options.title && !options.all) throw new Error("Applying every group requires both --all and --yes.");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run db:prune-duplicates",
    "  npm run db:prune-duplicates -- --title \"Scholarship title\" [--keep scholarship-id]",
    "  npm run db:prune-duplicates -- --title \"Scholarship title\" [--keep scholarship-id] --yes",
    "  npm run db:prune-duplicates -- --all --yes",
    "",
    "The command is a dry run unless --yes is present. Full-database writes also require --all.",
  ].join("\n");
}

async function configuration() {
  await loadEnvironment();
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = secretKey || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Set the Supabase URL and publishable key in .env.local.");
  return { url: url.replace(/\/$/, ""), key, privileged: Boolean(secretKey) };
}

function headers(config, extra = {}) {
  return {
    apikey: config.key,
    ...(config.key.startsWith("eyJ") ? { authorization: `Bearer ${config.key}` } : {}),
    "content-type": "application/json",
    ...extra,
  };
}

async function fetchScholarships(config) {
  const records = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const endpoint = new URL(`${config.url}/rest/v1/scholarships`);
    endpoint.search = new URLSearchParams({ select: COLUMNS, order: "id.asc" });
    const response = await fetch(endpoint, {
      headers: headers(config, { range: `${offset}-${offset + PAGE_SIZE - 1}` }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Supabase read failed: ${response.status} ${body.slice(0, 500)}`);
    const page = JSON.parse(body);
    records.push(...page);
    if (page.length < PAGE_SIZE) return records;
  }
}

async function applyPlan(config, plan) {
  const endpoint = `${config.url}/rest/v1/rpc/prune_scholarship_duplicates`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      p_survivor_id: plan.survivor.id,
      p_duplicate_ids: plan.duplicates.map((record) => record.id),
      p_source_urls: plan.sourceUrls,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase prune failed: ${response.status} ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

function summarize(plan) {
  return {
    survivor: {
      id: plan.survivor.id,
      title: plan.survivor.title,
      source: plan.survivor.source_name,
      deadline: plan.survivor.deadline,
      vetting: plan.survivor.vetting?.status || "unvetted",
    },
    delete: plan.duplicates.map((record) => ({
      id: record.id,
      title: record.title,
      source: record.source_name,
      deadline: record.deadline,
      vetting: record.vetting?.status || "unvetted",
    })),
    preservedSourceUrls: plan.sourceUrls,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("help")) return console.log(usage());
  const options = parseOptions(args);
  const config = await configuration();
  const records = await fetchScholarships(config);
  const result = planDuplicatePrune(records, options);
  console.log(JSON.stringify({
    scanned: records.length,
    duplicateGroups: result.plans.length,
    recordsToDelete: result.plans.reduce((total, plan) => total + plan.duplicates.length, 0),
    plans: result.plans.map(summarize),
    skipped: result.skipped,
  }, null, 2));

  if (!result.plans.length) return console.log("No high-confidence duplicate groups matched.");
  if (!options.yes) return console.log("Dry run only. Review the survivors above, then add --yes to apply.");
  if (!config.privileged) throw new Error("Set local-only SUPABASE_SECRET_KEY in .env.local before using --yes.");
  for (const plan of result.plans) console.log(JSON.stringify(await applyPlan(config, plan)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
