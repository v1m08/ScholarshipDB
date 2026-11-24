// Build the clean rows that go into the database, from what the crawl jobs wrote.
// Writes data/records/schools.jsonl, scholarships.jsonl, evidence.jsonl and summary.json.
// Every row passes the rules in database/schema.sql (see database/clean-record.mjs).
// Sources handled so far: school portal award pages (data/raw/portal-awards). Awards a
// portal lists for outside organizations are left out: they are read from the
// organization's own site instead.
// Usage: node scripts/build-records.mjs
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { acceptedFields, cleanRecord, nameKey } from "../database/clean-record.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
async function* lines(path) {
  const reader = createInterface({ input: createReadStream(join(root, path)) });
  for await (const line of reader) if (line.trim()) yield JSON.parse(line);
}

// Schools: the registry, in the database's shape.
const registry = JSON.parse(await readFile(join(root, "data", "registry", "institutions.json"), "utf8"));
const institutions = Array.isArray(registry) ? registry : registry.institutions;
const schools = new Map();
for (const school of institutions) {
  const website = school.website ? `https://${school.website.replace(/^https?:\/\//i, "").replace(/\/$/, "")}` : null;
  schools.set(String(school.unitid), {
    unitid: Number(school.unitid),
    name: school.name.replace(/\s+/g, " ").trim(),
    city: school.city || null,
    state: /^[A-Z]{2}$/.test(school.state || "") ? school.state : null,
    level: ["less-than-two-year", "two-year", "four-year"].includes(school.level) ? school.level : null,
    control: ["public", "private-nonprofit", "private-for-profit"].includes(school.control) ? school.control : null,
    website: website && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(website) ? website : null,
  });
}

// Which school each portal belongs to. A portal shared by several schools is skipped.
const portalSchool = new Map();
for await (const portal of lines("data/raw/portal-links/results.jsonl")) portalSchool.set(portal.key, portal.unitids || []);

// First pass: which fields of study are named often enough to trust.
const fieldCounts = new Map();
for await (const result of lines("data/raw/portal-awards/results.jsonl")) {
  for (const field of result.record?.metadata?.fieldsOfStudy?.value || []) { const key = String(field).toLowerCase().trim(); fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1); }
}
const knownFields = acceptedFields(fieldCounts);

// Second pass: clean each record. Later lines replace earlier ones for the same address.
const summary = { read: 0, kept: 0, rejected: {}, duplicatesMerged: 0, fieldsOfStudyAccepted: knownFields.size };
const rejectedBecause = (reason) => { summary.rejected[reason] = (summary.rejected[reason] || 0) + 1; };
const byId = new Map();
for await (const result of lines("data/raw/portal-awards/results.jsonl")) {
  summary.read += 1;
  const record = result.record;
  if (!record) { rejectedBecause(result.error ? "page could not be read" : "page had no scholarship"); continue; }
  if (record.external) { rejectedBecause("outside organization (read from its own site instead)"); continue; }
  const unitids = portalSchool.get(new URL(record.url).host) || [];
  if (unitids.length !== 1 || !schools.has(unitids[0])) { rejectedBecause(unitids.length > 1 ? "portal shared by several schools" : "school not identified"); continue; }
  const school = schools.get(unitids[0]);
  const cleaned = cleanRecord({ url: record.url, name: record.name, metadata: record.metadata, checkedAt: result.readAt }, { scope: "school", source: "school-portal", providerName: school.name, schoolUnitid: school.unitid, knownFields });
  if (cleaned.rejected) { rejectedBecause(cleaned.rejected); continue; }
  byId.set(cleaned.row.id, cleaned);
}

// A portal keeps last year's copy of a scholarship beside this year's. One school, one
// name: keep the copy with the latest deadline (a copy with no deadline loses).
const byName = new Map();
for (const cleaned of byId.values()) {
  const key = `${cleaned.row.school_unitid}|${nameKey(cleaned.row.name)}`;
  const current = byName.get(key);
  if (!current) { byName.set(key, cleaned); continue; }
  summary.duplicatesMerged += 1;
  if ((cleaned.row.deadline || "") > (current.row.deadline || "")) byName.set(key, cleaned);
}

await mkdir(join(root, "data", "records"), { recursive: true });
const write = async (file, rows) => {
  const out = createWriteStream(join(root, "data", "records", file));
  for (const row of rows) out.write(`${JSON.stringify(row)}\n`);
  await new Promise((resolve) => out.end(resolve));
};
const kept = [...byName.values()].sort((a, b) => a.row.id.localeCompare(b.row.id));
const usedSchools = new Set(kept.map((cleaned) => String(cleaned.row.school_unitid)));
await write("schools.jsonl", [...schools.values()]);
await write("scholarships.jsonl", kept.map((cleaned) => cleaned.row));
await write("evidence.jsonl", kept.flatMap((cleaned) => cleaned.evidence));

const today = new Date().toISOString().slice(0, 10);
summary.kept = kept.length;
summary.schools = { inRegistry: schools.size, withScholarships: usedSchools.size };
summary.open = kept.filter((cleaned) => cleaned.row.deadline && cleaned.row.deadline >= today).length;
summary.closed = kept.filter((cleaned) => cleaned.row.deadline && cleaned.row.deadline < today).length;
summary.noDeadline = kept.filter((cleaned) => !cleaned.row.deadline).length;
summary.withAward = kept.filter((cleaned) => cleaned.row.award_max).length;
summary.builtAt = today;
await writeFile(join(root, "data", "records", "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
