import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Coverage of each pipeline stage per source, computed from the generated
// catalog. "tagged" counts records with at least one canonical tag from any
// stage; "tagOverlay" and "enriched" count records the model overlays reached.
export function sourceCoverage(records) {
  const bySource = new Map();
  for (const record of records) {
    const counts = bySource.get(record.sourceName) || {
      records: 0, tagged: 0, tagOverlay: 0, enriched: 0, vetted: 0, deadline: 0, award: 0,
    };
    counts.records += 1;
    if (record.eligibility?.tags?.length) counts.tagged += 1;
    if (record.taggedAt) counts.tagOverlay += 1;
    if (record.enrichedAt) counts.enriched += 1;
    if (record.vetting) counts.vetted += 1;
    if (record.deadline) counts.deadline += 1;
    if (record.award?.maximum !== null && record.award?.maximum !== undefined) counts.award += 1;
    bySource.set(record.sourceName, counts);
  }
  return bySource;
}

async function rawImportCounts() {
  const importsPath = join(root, "data", "imports");
  const counts = new Map();
  let files = [];
  try {
    files = await readdir(importsPath, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return counts;
    throw error;
  }
  for (const file of files.filter((f) => f.replaceAll("\\", "/").endsWith("/records.jsonl"))) {
    const source = file.replaceAll("\\", "/").split("/")[0];
    const contents = await readFile(join(importsPath, file), "utf8");
    counts.set(source, contents.split(/\r?\n/).filter((line) => line.trim()).length);
  }
  return counts;
}

async function main() {
  const catalog = JSON.parse(await readFile(join(root, "src", "generated", "catalog.json"), "utf8"));
  const coverage = sourceCoverage(catalog);
  const raw = await rawImportCounts();

  const percent = (part, whole) => whole ? `${Math.round((part / whole) * 100)}%` : "-";
  const sources = [...coverage.entries()].sort((a, b) => b[1].records - a[1].records);
  const header = ["source", "records", "tagged", "tagOverlay", "enriched", "vetted", "deadline", "award"];
  const table = sources.map(([source, counts]) => [
    source,
    String(counts.records),
    ...["tagged", "tagOverlay", "enriched", "vetted", "deadline", "award"]
      .map((stage) => `${counts[stage]} (${percent(counts[stage], counts.records)})`),
  ]);
  const widths = header.map((_, column) => Math.max(header[column].length, ...table.map((row) => row[column].length)));
  console.log(header.map((cell, column) => cell.padEnd(widths[column])).join("  "));
  for (const row of table) console.log(row.map((cell, column) => cell.padEnd(widths[column])).join("  "));
  console.log(`\nRaw imports: ${[...raw.entries()].map(([source, count]) => `${source}=${count}`).join(", ")}`);
  console.log(`Catalog total: ${catalog.length}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
