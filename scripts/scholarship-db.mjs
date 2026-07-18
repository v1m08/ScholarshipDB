import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COLUMNS = [
  "id", "title", "provider", "source_name", "source_url", "source_urls",
  "source_checked_at", "source_missing_fields", "application_url", "opens",
  "deadline", "description", "award", "requirements", "eligibility",
  "institution_specific", "institution_name", "institution_types", "search_text",
  "vetting", "publication_status", "published_at", "created_at", "updated_at",
];
const EDITABLE = new Set(COLUMNS.filter((column) => !["id", "created_at", "updated_at"].includes(column)));
const ARRAY_FIELDS = new Set([
  "countries", "states", "counties", "cities", "regions", "grades", "degreeLevels",
  "fields", "citizenship", "tags", "other", "institutions", "institutionDesignations",
  "employers", "unions", "tribes", "organizations", "medicalConditions", "exactCriteria",
]);
const BLOCKED_PATHS = new Set(["__proto__", "prototype", "constructor"]);

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

function parseValue(raw, current) {
  if (raw === "null") return null;
  if (Array.isArray(current)) {
    if (!raw) return [];
    if (raw.startsWith("[")) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Array fields require a JSON array or | separated values.");
      return parsed;
    }
    return raw.split("|").map((value) => value.trim()).filter(Boolean);
  }
  if (typeof current === "boolean") {
    if (raw !== "true" && raw !== "false") throw new Error("Expected true or false, received " + raw + ".");
    return raw === "true";
  }
  if (typeof current === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("Expected a number, received " + raw + ".");
    return value;
  }
  if (typeof current === "string") return raw;
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("{") || raw.startsWith("[")) return JSON.parse(raw);
  return raw;
}

export function applyAssignment(record, assignment) {
  const separator = assignment.indexOf("=");
  if (separator < 1) throw new Error("Invalid --set value: " + assignment + ". Use path=value.");
  const path = assignment.slice(0, separator).trim();
  const parts = path.split(".");
  if (!EDITABLE.has(parts[0]) || parts.some((part) => !part || BLOCKED_PATHS.has(part))) {
    throw new Error("Field is not editable: " + path + ".");
  }
  let target = record;
  for (const part of parts.slice(0, -1)) {
    if (target[part] === null || target[part] === undefined) target[part] = {};
    if (typeof target[part] !== "object" || Array.isArray(target[part])) {
      throw new Error("Cannot set a child field under " + part + ".");
    }
    target = target[part];
  }
  const field = parts.at(-1);
  target[field] = parseValue(assignment.slice(separator + 1), target[field]);
  return parts[0];
}

export function buildSearchText(record) {
  const eligibility = record.eligibility || {};
  return [
    record.title,
    record.provider,
    record.description,
    ...[...ARRAY_FIELDS].flatMap((field) => eligibility[field] || []),
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

function validateRecord(record) {
  for (const field of ["source_url", "application_url"]) {
    if (!/^https?:\/\//.test(record[field] || "")) throw new Error(field + " must be an http(s) URL.");
  }
  for (const field of ["source_checked_at", "opens", "deadline"]) {
    if (record[field] !== null && record[field] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(record[field])) {
      throw new Error(field + " must use YYYY-MM-DD or null.");
    }
  }
  for (const [field, value] of Object.entries(record.requirements || {})) {
    if (value !== null && typeof value !== "boolean") {
      throw new Error("requirements." + field + " must be true, false, or null.");
    }
  }
  for (const field of ARRAY_FIELDS) {
    if (record.eligibility?.[field] !== undefined && !Array.isArray(record.eligibility[field])) {
      throw new Error("eligibility." + field + " must be an array.");
    }
  }
  for (const field of ["minimumGpa", "maximumGpa", "minimumAge", "maximumAge"]) {
    const value = record.eligibility?.[field];
    if (value !== null && value !== undefined && !Number.isFinite(value)) {
      throw new Error("eligibility." + field + " must be a number or null.");
    }
  }
  if (!new Set(["human", "ai", "unvetted"]).has(record.vetting?.status)) {
    throw new Error("vetting.status must be human, ai, or unvetted.");
  }
  if (!new Set(["draft", "published", "archived"]).has(record.publication_status)) {
    throw new Error("publication_status must be draft, published, or archived.");
  }
}

function parseOptions(args) {
  const options = { sets: [], vetter: null, vetMethod: "manual-review", yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes") options.yes = true;
    else if (argument === "--set") options.sets.push(args[++index]);
    else if (argument.startsWith("--set=")) options.sets.push(argument.slice(6));
    else if (argument === "--vet") options.vetter = args[++index];
    else if (argument === "--vet-method") options.vetMethod = args[++index];
    else throw new Error("Unknown option: " + argument);
  }
  if (options.sets.some((value) => !value)) throw new Error("--set requires path=value.");
  if (options.vetter === undefined || options.vetMethod === undefined) throw new Error("Vetting options require a value.");
  return options;
}

function usage() {
  return [
    "Usage:",
    "  npm run db:scholarship -- get <id-or-exact-title>",
    "  npm run db:scholarship -- update <id> --set path=value [--set path=value] [--vet name] [--vet-method method] [--yes]",
    "",
    "Updates are dry runs unless --yes is present. Use | between array values.",
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

async function request(config, parameters, init = {}) {
  const endpoint = new URL(config.url + "/rest/v1/scholarships");
  endpoint.search = new URLSearchParams({ select: COLUMNS.join(","), ...parameters });
  const response = await fetch(endpoint, {
    ...init,
    headers: {
      apikey: config.key,
      ...(config.key.startsWith("eyJ") ? { authorization: "Bearer " + config.key } : {}),
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase request failed: " + response.status + " " + body.slice(0, 500));
  return body ? JSON.parse(body) : [];
}

async function findScholarship(config, query) {
  let rows = await request(config, { id: "eq." + query, limit: "2" });
  if (!rows.length) rows = await request(config, { title: "ilike." + query, limit: "20" });
  if (!rows.length) {
    const cleaned = query.replace(/[%*_,()]/g, " ").replace(/\s+/g, " ").trim();
    rows = await request(config, { title: "ilike.*" + cleaned + "*", limit: "20" });
  }
  if (!rows.length) throw new Error("No scholarship matched: " + query);
  if (rows.length > 1) {
    const matches = rows.map((row) => row.id + ": " + row.title).join("\n");
    throw new Error("Multiple scholarships matched. Retry with an id:\n" + matches);
  }
  return rows[0];
}

async function updateScholarship(config, id, args) {
  const options = parseOptions(args);
  const current = await findScholarship(config, id);
  if (current.id !== id) throw new Error("Updates require the exact scholarship id returned by get.");
  const next = structuredClone(current);
  const changed = new Set(options.sets.map((assignment) => applyAssignment(next, assignment)));

  if (options.vetter) {
    const vettedAt = new Date().toISOString();
    next.vetting = {
      ...next.vetting,
      status: "human",
      vettedAt,
      vettedBy: options.vetter,
      confidence: 1,
      method: options.vetMethod,
      checkedUrl: next.source_url,
      missingFields: [],
    };
    next.source_checked_at = vettedAt.slice(0, 10);
    next.source_missing_fields = [];
    changed.add("vetting");
    changed.add("source_checked_at");
    changed.add("source_missing_fields");
  }
  if (changed.has("source_url")) {
    next.source_urls = [...new Set([next.source_url, ...(next.source_urls || [])])];
    changed.add("source_urls");
  }
  if (["title", "provider", "description", "eligibility"].some((field) => changed.has(field))) {
    next.search_text = buildSearchText(next);
    changed.add("search_text");
  }
  if (!changed.size) throw new Error("No updates were provided.");
  validateRecord(next);

  const payload = Object.fromEntries([...changed].map((field) => [field, next[field]]));
  payload.updated_at = new Date().toISOString();
  console.log(JSON.stringify({ id, update: payload }, null, 2));
  if (!options.yes) {
    console.log("Dry run only. Add --yes to apply this update.");
    return;
  }
  if (!config.privileged) {
    throw new Error("Set local-only SUPABASE_SECRET_KEY in .env.local before using --yes.");
  }
  const rows = await request(config, { id: "eq." + id }, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  if (rows.length !== 1) throw new Error("Expected one updated row, received " + rows.length + ".");
  console.log(JSON.stringify(rows[0], null, 2));
}

async function main() {
  const [command, subject, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") return console.log(usage());
  if (!subject) throw new Error(usage());
  const config = await configuration();
  if (command === "get") return console.log(JSON.stringify(await findScholarship(config, subject), null, 2));
  if (command === "update") return updateScholarship(config, subject, args);
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
