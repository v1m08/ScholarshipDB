// Refresh refreshable sources in place: re-fetch each source, update changed
// fields on existing records (deadlines above all), and append new ones.
// Records that disappear from a source are kept — the index marks them closed
// once their deadline passes. Dry run by default; pass --yes to apply.
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCandidate } from "./add-scholarship.mjs";
import { fetchBoldCandidates } from "./ingest-bold.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fields a refresh may change; everything else on an existing record is kept.
const REFRESH_FIELDS = ["title", "provider", "deadline", "opens", "description", "award", "requirements"];

const SOURCES = [
  { slug: "bold", fetch: async () => (await fetchBoldCandidates()).candidates },
];

async function jsonLines(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function refreshRecord(existing, fresh) {
  const changed = [];
  const next = { ...existing };
  for (const field of REFRESH_FIELDS) {
    if (fresh[field] === undefined) continue;
    if (JSON.stringify(existing[field] ?? null) !== JSON.stringify(fresh[field] ?? null)) {
      next[field] = fresh[field];
      changed.push(field);
    }
  }
  if (changed.length) next.sourceCheckedAt = fresh.sourceCheckedAt;
  return { next, changed };
}

async function refreshSource({ slug, fetch }, apply) {
  const today = new Date().toISOString().slice(0, 10);
  const importPath = join(root, "data", "imports", slug, "records.jsonl");
  const existing = await jsonLines(importPath);
  const byId = new Map(existing.map((record) => [record.id, record]));

  const summary = { slug, fetched: 0, added: 0, updated: 0, unchanged: 0, missingFromSource: 0, invalid: 0, changedFields: {} };
  const additions = [];
  const seen = new Set();
  for (const input of await fetch()) {
    const { record, errors } = buildCandidate(input, { source: slug, today });
    if (errors.length) {
      summary.invalid += 1;
      console.warn(`  SKIP invalid ${input.id || input.title}: ${errors.join(", ")}`);
      continue;
    }
    summary.fetched += 1;
    seen.add(record.id);
    const current = byId.get(record.id);
    if (!current) {
      additions.push(record);
      summary.added += 1;
      console.log(`  NEW    ${record.id}  ${record.title}`);
      continue;
    }
    const { next, changed } = refreshRecord(current, record);
    if (!changed.length) {
      summary.unchanged += 1;
      continue;
    }
    byId.set(record.id, next);
    summary.updated += 1;
    for (const field of changed) summary.changedFields[field] = (summary.changedFields[field] || 0) + 1;
    console.log(`  UPDATE ${record.id}  ${changed.join(", ")}  ${next.title}`);
  }
  summary.missingFromSource = existing.filter((record) => !seen.has(record.id)).length;

  if (apply && (summary.added || summary.updated)) {
    const rows = [...existing.map((record) => byId.get(record.id)), ...additions];
    await writeFile(importPath, rows.map((record) => `${JSON.stringify(record)}\n`).join(""));
  }
  return summary;
}

async function main() {
  const apply = process.argv.includes("--yes");
  let changes = 0;
  for (const source of SOURCES) {
    console.log(`Refreshing ${source.slug}...`);
    const summary = await refreshSource(source, apply);
    changes += summary.added + summary.updated;
    console.log(`${source.slug}: ${summary.fetched} fetched, ${summary.added} new, ${summary.updated} updated (${JSON.stringify(summary.changedFields)}), ${summary.unchanged} unchanged, ${summary.missingFromSource} no longer listed, ${summary.invalid} invalid.`);
  }
  if (!apply) return console.log("\nDry run only. Add --yes to apply and rebuild the index.");
  if (!changes) return console.log("\nNothing changed; index left as is.");
  const build = spawnSync(process.execPath, [join(root, "scripts", "build-index.mjs")], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("Index rebuild failed after refresh.");
  console.log("Refresh applied. Next: npm run db:publish (and db:archive-stale for retired records).");
}

await main();
