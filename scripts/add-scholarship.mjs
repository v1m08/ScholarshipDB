import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareCandidate } from "./lib/candidate-pipeline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = "manual";
const SOURCE_NAMES = { manual: "Manual Intake" };

export function candidateFingerprint(record) {
  return `${String(record.title || "").toLowerCase()}|${String(record.provider || "").toLowerCase()}|${record.applicationUrl || record.sourceUrl || ""}`;
}

export function buildCandidate(input, { source = DEFAULT_SOURCE, today } = {}) {
  const record = {
    ...input,
    sourceName: input.sourceName || SOURCE_NAMES[source] || `${source} import`,
    sourceCheckedAt: input.sourceCheckedAt || today,
    applicationUrl: input.applicationUrl || input.sourceUrl,
  };
  if (!record.id) {
    const hash = createHash("sha256").update(candidateFingerprint(record)).digest("hex");
    record.id = `${source}-${hash.slice(0, 16)}`;
  }
  const prepared = prepareCandidate(record);
  return {
    record: prepared.candidateData,
    errors: prepared.errors,
    qualityFlags: prepared.qualityFlags,
  };
}

export function dedupeAgainstCatalog(candidates, catalog) {
  const byId = new Map(catalog.map((record) => [record.id, record]));
  const byUrl = new Map();
  const byFingerprint = new Map();
  for (const record of catalog) {
    for (const url of record.sourceUrls || [record.sourceUrl]) byUrl.set(url, record);
    byFingerprint.set(candidateFingerprint(record), record);
  }
  const seen = new Set();
  return candidates.map((candidate) => {
    const record = candidate.record;
    const fingerprint = candidateFingerprint(record);
    const existing = byId.get(record.id)
      || (record.sourceUrls || [record.sourceUrl]).map((url) => byUrl.get(url)).find(Boolean)
      || byFingerprint.get(fingerprint);
    if (existing) return { ...candidate, status: "duplicate", existingId: existing.id };
    if (seen.has(fingerprint)) return { ...candidate, status: "duplicate", existingId: "(earlier candidate in this batch)" };
    seen.add(fingerprint);
    return { ...candidate, status: candidate.errors.length ? "invalid" : "new" };
  });
}

async function loadCandidates(path) {
  const contents = await readFile(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return contents.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(contents);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function loadCatalog() {
  try {
    return JSON.parse(await readFile(join(root, "src", "generated", "catalog.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function usage() {
  return [
    "Usage: npm run add -- <candidates.json|candidates.jsonl> [--source name] [--yes] [--no-index]",
    "",
    "Candidates use the canonical scholarship schema (see docs/adding-scholarships.md).",
    "Runs as a dry run unless --yes is present. Accepted records are appended to",
    "data/imports/<source>/records.jsonl and the search index is rebuilt.",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const options = { source: DEFAULT_SOURCE, yes: false, index: true, file: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes") options.yes = true;
    else if (argument === "--no-index") options.index = false;
    else if (argument === "--source") options.source = args[++index];
    else if (argument.startsWith("--source=")) options.source = argument.slice(9);
    else if (argument === "--help") return console.log(usage());
    else if (!options.file) options.file = argument;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.file) throw new Error(usage());
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.source)) {
    throw new Error("--source must be a lowercase slug, for example: manual, counselor-list.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const inputs = await loadCandidates(resolve(options.file));
  const catalog = await loadCatalog();
  const results = dedupeAgainstCatalog(
    inputs.map((input) => buildCandidate(input, { source: options.source, today })),
    catalog,
  );

  const accepted = results.filter((result) => result.status === "new");
  for (const result of results) {
    if (result.status === "new") {
      const missing = result.qualityFlags.filter((flag) => flag.startsWith("missing:"));
      console.log(`ADD  ${result.record.id}  ${result.record.title}${missing.length ? `  (${missing.join(", ")})` : ""}`);
    } else if (result.status === "duplicate") {
      console.log(`SKIP ${result.record.id}  duplicate of ${result.existingId}`);
    } else {
      console.log(`FAIL ${result.record.id || "(no id)"}  ${result.errors.join(", ")}`);
    }
  }
  const failed = results.filter((result) => result.status === "invalid");
  console.log(`\n${accepted.length} new, ${results.length - accepted.length - failed.length} duplicates, ${failed.length} invalid.`);
  if (failed.length) process.exitCode = 1;
  if (!options.yes) return console.log("Dry run only. Add --yes to append the new records.");
  if (!accepted.length) return console.log("Nothing to append.");

  const importDir = join(root, "data", "imports", options.source);
  await mkdir(importDir, { recursive: true });
  const lines = accepted.map((result) => `${JSON.stringify(result.record)}\n`).join("");
  await appendFile(join(importDir, "records.jsonl"), lines);
  console.log(`Appended ${accepted.length} records to data/imports/${options.source}/records.jsonl`);
  if (options.index) {
    const build = spawnSync(process.execPath, [join(root, "scripts", "build-index.mjs")], { stdio: "inherit" });
    if (build.status !== 0) throw new Error("Index rebuild failed after appending records.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
