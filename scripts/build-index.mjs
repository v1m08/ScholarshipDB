import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_US_STATE_CODES, CANONICAL_GRADES, normalizeRecord } from "./lib/normalize-record.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordsPath = join(root, "data", "scholarships.json");
const importsPath = join(root, "data", "imports");
const enrichmentPath = join(root, "data", "enrichment", "records.jsonl");
const taggingPath = join(root, "data", "tagging", "records.jsonl");
const taxonomyPath = join(root, "data", "taxonomy", "scholarship-taxonomy.json");
const outputPath = join(root, "src", "generated", "catalog.json");
const metadataPath = join(root, "src", "generated", "metadata.json");
const directoryPath = join(root, "src", "generated", "directory");
const searchPath = join(root, "src", "generated", "search");
const initialDirectoryPath = join(root, "src", "generated", "directory-initial.json");
const initialSummaryPath = join(root, "src", "generated", "directory-summary.json");
const sitemapPath = join(root, "src", "generated", "sitemap.json");
const relatedScholarshipsPath = join(root, "src", "generated", "related-scholarships.json");
const categoryCountsPath = join(root, "src", "generated", "category-counts.json");
const bigFutureQueuePath = join(root, "data", "queues", "bigfuture-urls.jsonl");
const DIRECTORY_PAGE_SIZE = 100;
const INITIAL_DIRECTORY_SIZE = 200;
const INITIAL_SUMMARY_SIZE = 30;
const SEARCH_SHARD_SIZE = 500;

const records = JSON.parse(await readFile(recordsPath, "utf8"));
const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf8"));
const allowedTags = new Set(taxonomy.tags.map((tag) => tag.id));
if (!Array.isArray(records)) {
  throw new Error("data/scholarships.json must contain an array.");
}

async function importedRecords() {
  let files = [];
  try {
    files = await readdir(importsPath, { recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const jsonlFiles = files.filter((file) => file.replaceAll("\\", "/").endsWith("/records.jsonl"));
  const values = [];
  for (const file of jsonlFiles) {
    const contents = await readFile(join(importsPath, file), "utf8");
    for (const [lineNumber, line] of contents.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        values.push(JSON.parse(line));
      } catch {
        throw new Error(`Invalid JSON in data/imports/${file}:${lineNumber + 1}`);
      }
    }
  }
  return values;
}

records.push(...await importedRecords());

const normalizedRecords = new Map();
const fingerprints = new Map();
for (const unnormalizedRecord of records) {
  const record = normalizeRecord({
    ...unnormalizedRecord,
    requirements: {
      ...(unnormalizedRecord.requirements || {}),
      // ponytail: legacy imports used false for "not stated"; enrichment can still verify false later.
      essay: unnormalizedRecord.requirements?.essay === false ? null : unnormalizedRecord.requirements?.essay,
    },
  });
  for (const required of ["id", "title", "provider", "sourceUrl", "sourceCheckedAt"]) {
    if (!record[required]) throw new Error(`${record.id || "Unknown record"} is missing ${required}.`);
  }
  if (!/^https?:\/\//.test(record.sourceUrl)) {
    throw new Error(`${record.id} does not have a public source URL.`);
  }
  const fingerprint = `${record.title.toLowerCase()}|${record.provider.toLowerCase()}|${record.applicationUrl || record.sourceUrl}`;
  const existing = normalizedRecords.get(record.id) || fingerprints.get(fingerprint);
  if (existing) {
    existing.sourceUrls = [
      ...new Set([...(existing.sourceUrls || [existing.sourceUrl]), record.sourceUrl]),
    ];
    continue;
  }
  const normalized = { ...record, sourceUrls: record.sourceUrls || [record.sourceUrl] };
  normalizedRecords.set(record.id, normalized);
  fingerprints.set(fingerprint, normalized);
}

async function jsonLines(path) {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function enrichments() {
  return jsonLines(enrichmentPath);
}

function fillMissing(existing, enrichment) {
  const verified = new Set(enrichment.verifiedFields || []);
  const supported = (field, value) => verified.has(field) ? value : undefined;
  const replace = enrichment.mode === "replace";
  const fill = (current, next, field) => {
    if (replace && verified.has(field) && next !== null && next !== "" && next !== undefined) return next;
    if ((current === null || current === "" || current === undefined) && next !== null && next !== "" && next !== undefined) return next;
    if (Array.isArray(current) && current.length === 0 && Array.isArray(next) && next.length) return next;
    return current;
  };
  const verifiedEnrichmentTags = verified.has("eligibility.tags")
    ? (enrichment.eligibility?.tags || []).filter((tag) => allowedTags.has(tag))
    : [];
  return normalizeRecord({
    ...existing,
    description: fill(existing.description, supported("description", enrichment.description), "description"),
    award: {
      maximum: fill(existing.award.maximum, supported("award.maximum", enrichment.award?.maximum), "award.maximum"),
      varies: replace && verified.has("award.varies")
        ? enrichment.award?.varies
        : existing.award.maximum === null
          ? (supported("award.varies", enrichment.award?.varies) ?? existing.award.varies)
          : existing.award.varies,
    },
    requirements: {
      essay: fill(existing.requirements.essay, supported("requirements.essay", enrichment.requirements?.essay), "requirements.essay"),
      needBased: fill(existing.requirements.needBased, supported("requirements.needBased", enrichment.requirements?.needBased), "requirements.needBased"),
      meritBased: fill(existing.requirements.meritBased, supported("requirements.meritBased", enrichment.requirements?.meritBased), "requirements.meritBased"),
      fee: fill(existing.requirements.fee, supported("requirements.fee", enrichment.requirements?.fee), "requirements.fee"),
    },
    eligibility: {
      ...existing.eligibility,
      countries: fill(existing.eligibility.countries, supported("eligibility.countries", enrichment.eligibility?.countries), "eligibility.countries"),
      states: fill(existing.eligibility.states, supported("eligibility.states", enrichment.eligibility?.states), "eligibility.states"),
      grades: fill(existing.eligibility.grades, supported("eligibility.grades", enrichment.eligibility?.grades), "eligibility.grades"),
      degreeLevels: fill(existing.eligibility.degreeLevels, supported("eligibility.degreeLevels", enrichment.eligibility?.degreeLevels), "eligibility.degreeLevels"),
      fields: fill(existing.eligibility.fields, supported("eligibility.fields", enrichment.eligibility?.fields), "eligibility.fields"),
      minimumGpa: fill(existing.eligibility.minimumGpa, supported("eligibility.minimumGpa", enrichment.eligibility?.minimumGpa), "eligibility.minimumGpa"),
      minimumAge: fill(existing.eligibility.minimumAge, supported("eligibility.minimumAge", enrichment.eligibility?.minimumAge), "eligibility.minimumAge"),
      citizenship: fill(existing.eligibility.citizenship, supported("eligibility.citizenship", enrichment.eligibility?.citizenship), "eligibility.citizenship"),
      tags: replace && verified.has("eligibility.tags")
        ? enrichment.eligibility.tags.filter((tag) => allowedTags.has(tag))
        : [...new Set([...(existing.eligibility.tags || []), ...(supported("eligibility.tags", enrichment.eligibility?.tags) || [])])]
          .filter((tag) => allowedTags.has(tag)),
      other: replace && verified.has("eligibility.other")
        ? enrichment.eligibility.other
        : [...new Set([...(existing.eligibility.other || []), ...(supported("eligibility.other", enrichment.eligibility?.other) || [])])],
    },
    enrichedFromUrl: enrichment.enrichedFromUrl || existing.enrichedFromUrl,
    enrichedAt: enrichment.enrichedAt || existing.enrichedAt,
    enrichedCanonicalTags: [
      ...new Set([...(existing.enrichedCanonicalTags || []), ...verifiedEnrichmentTags]),
    ],
  });
}

for (const enrichment of await enrichments()) {
  if (![2, 3].includes(enrichment.pipelineVersion) || !Array.isArray(enrichment.verifiedFields)) continue;
  const record = normalizedRecords.get(enrichment.id);
  if (record) normalizedRecords.set(enrichment.id, fillMissing(record, enrichment));
}

for (const overlay of await jsonLines(taggingPath)) {
  const record = normalizedRecords.get(overlay.id);
  if (
    !record ||
    overlay.mode !== "replace" ||
    overlay.pipelineVersion !== 6 ||
    overlay.taxonomyVersion !== taxonomy.version ||
    !Array.isArray(overlay.tags)
  ) continue;
  normalizedRecords.set(overlay.id, normalizeRecord({
    ...record,
    eligibility: {
      ...record.eligibility,
      tags: [...new Set([
        ...overlay.tags.filter((tag) => allowedTags.has(tag)),
        ...(record.enrichedCanonicalTags || []),
      ])],
    },
    tagEvidence: overlay.evidence || [],
    taggedAt: overlay.taggedAt,
    taggedByModel: overlay.model,
  }));
}

const indexed = [...normalizedRecords.values()]
  .map((record) => {
    const eligibility = {
      ...record.eligibility,
      tags: record.eligibility.tags.filter((tag) => allowedTags.has(tag)),
    };
    const outputRecord = {
      ...record,
      tags: eligibility.tags,
      eligibility,
    };
    const searchable = [
      record.title,
      record.provider,
      record.description,
      ...eligibility.countries,
      ...eligibility.states,
      ...eligibility.grades,
      ...eligibility.degreeLevels,
      ...eligibility.fields,
      ...eligibility.tags,
      ...eligibility.other,
      record.institutionSpecific ? "college-specific institution-specific" : "general scholarship",
      record.institutionName || "",
      ...(record.institutionTypes || []),
    ].join(" ");
    return {
      ...outputRecord,
      searchText: searchable.toLowerCase().replace(/\s+/g, " ").trim(),
    };
  })
  .sort((a, b) => (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31"));

const output = `${JSON.stringify(indexed, null, 2)}\n`;
const values = (pick) => [...new Set(indexed.flatMap(pick))].sort((a, b) => a.localeCompare(b));
async function lineCount(path) {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
const discoveredBigFuture = await lineCount(bigFutureQueuePath);
const generatedOn = new Date().toISOString().slice(0, 10);
const directoryRecords = groupSimilarScholarships(indexed, generatedOn);
const activeDirectoryCount = directoryRecords.filter((record) => !isClosed(record, generatedOn)).length;
const activeDirectoryRecords = directoryRecords.filter((record) => !isClosed(record, generatedOn));
const summary = (record) => ({
  id: record.id,
  title: record.title,
  provider: record.provider,
  deadline: record.deadline,
  description: record.description.slice(0, 240),
  award: { maximum: record.award.maximum, varies: record.award.varies },
  requirements: { essay: record.requirements.essay },
  eligibility: { minimumGpa: record.eligibility.minimumGpa, tags: record.eligibility.tags.slice(0, 2) },
  institutionSpecific: record.institutionSpecific,
  institutionName: record.institutionName,
  vetting: record.vetting && { status: record.vetting.status, vettedAt: record.vetting.vettedAt },
});
const metadata = {
  count: indexed.length,
  directoryCount: directoryRecords.length,
  activeDirectoryCount,
  directoryPageSize: DIRECTORY_PAGE_SIZE,
  directoryPageCount: Math.ceil(directoryRecords.length / DIRECTORY_PAGE_SIZE),
  searchShardSize: SEARCH_SHARD_SIZE,
  searchShardCount: Math.ceil(indexed.length / SEARCH_SHARD_SIZE),
  discoveredCount: Math.max(indexed.length, discoveredBigFuture),
  bigFutureDiscoveredCount: discoveredBigFuture,
  generatedOn,
  sourceCount: new Set(indexed.map((record) => record.sourceName)).size,
  facets: {
    grades: [
      ...(indexed.some((record) => record.eligibility.grades.some((grade) => [
        "Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4",
        "Grade 5", "Grade 6", "Grade 7", "Grade 8",
      ].includes(grade))) ? ["K-8"] : []),
      ...CANONICAL_GRADES.filter((grade) =>
        !["Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Grade 8"].includes(grade)
        && indexed.some((record) => record.eligibility.grades.includes(grade))
      ),
    ],
    tags: values((record) => record.eligibility.tags),
    tagOptions: taxonomy.tags.map((tag) => tag.id),
    states: [...ALL_US_STATE_CODES].sort((a, b) => a.localeCompare(b)),
  },
};
const relatedScholarships = Object.fromEntries(
  values((record) => record.eligibility.tags).map((tag) => [
    tag,
    activeDirectoryRecords.filter((record) => record.eligibility.tags.includes(tag)).slice(0, 4).map(summary),
  ]),
);
const categoryCounts = {
  "international-students": activeDirectoryRecords.filter((record) => record.eligibility.tags.includes("international-students")).length,
  "international-students/no-essay": activeDirectoryRecords.filter((record) => record.eligibility.tags.includes("international-students") && record.eligibility.tags.includes("no-essay")).length,
  "international-students/graduate": activeDirectoryRecords.filter((record) => record.eligibility.tags.includes("international-students") && record.eligibility.degreeLevels.some((level) => level.toLowerCase().includes("graduate"))).length,
  "international-students/women": activeDirectoryRecords.filter((record) => record.eligibility.tags.includes("international-students") && record.eligibility.tags.includes("women")).length,
  "international-students/stem": activeDirectoryRecords.filter((record) => record.eligibility.tags.includes("international-students") && record.eligibility.tags.includes("stem")).length,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeAtomic(outputPath, output);
await writeAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
await rm(searchPath, { recursive: true, force: true });
await mkdir(searchPath, { recursive: true });
for (let offset = 0; offset < indexed.length; offset += SEARCH_SHARD_SIZE) {
  const shard = Math.floor(offset / SEARCH_SHARD_SIZE) + 1;
  await writeAtomic(
    join(searchPath, `shard-${String(shard).padStart(4, "0")}.json`),
    `${JSON.stringify(indexed.slice(offset, offset + SEARCH_SHARD_SIZE))}\n`,
  );
}
await rm(directoryPath, { recursive: true, force: true });
await mkdir(directoryPath, { recursive: true });
for (let offset = 0; offset < directoryRecords.length; offset += DIRECTORY_PAGE_SIZE) {
  const page = Math.floor(offset / DIRECTORY_PAGE_SIZE) + 1;
  const records = directoryRecords.slice(offset, offset + DIRECTORY_PAGE_SIZE);
  await writeAtomic(
    join(directoryPath, `page-${String(page).padStart(4, "0")}.json`),
    `${JSON.stringify(records)}\n`,
  );
}
await writeAtomic(initialDirectoryPath, `${JSON.stringify({
  records: directoryRecords.slice(0, INITIAL_DIRECTORY_SIZE),
  total: activeDirectoryCount,
  rawTotal: indexed.length,
  page: Math.ceil(INITIAL_DIRECTORY_SIZE / DIRECTORY_PAGE_SIZE),
  limit: DIRECTORY_PAGE_SIZE,
  hasMore: INITIAL_DIRECTORY_SIZE < directoryRecords.length,
})}\n`);
await writeAtomic(initialSummaryPath, `${JSON.stringify({
  records: directoryRecords.filter((record) => !isClosed(record, generatedOn)).slice(0, INITIAL_SUMMARY_SIZE).map(summary),
  total: activeDirectoryCount,
  rawTotal: indexed.length,
  page: 1,
  limit: INITIAL_SUMMARY_SIZE,
  hasMore: activeDirectoryCount > INITIAL_SUMMARY_SIZE,
})}\n`);
await writeAtomic(sitemapPath, `${JSON.stringify(indexed.map((record) => ({ id: record.id, lastModified: record.sourceCheckedAt }))) }\n`);
await writeAtomic(relatedScholarshipsPath, `${JSON.stringify(relatedScholarships)}\n`);
await writeAtomic(categoryCountsPath, `${JSON.stringify(categoryCounts)}\n`);
console.log(`Indexed ${indexed.length} scholarship records into ${metadata.directoryPageCount} directory pages.`);

async function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await writeFile(temporary, contents);
      await rename(temporary, path);
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "UNKNOWN"].includes(error.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

function groupSimilarScholarships(matches, asOfDate) {
  const groups = new Map();
  for (const scholarship of matches) {
    const group = groups.get(groupKey(scholarship)) || [];
    group.push(scholarship);
    groups.set(groupKey(scholarship), group);
  }
  return Array.from(groups.values())
    .map((group) => {
      if (group.length === 1) return group[0];
      const variants = [...group].sort((a, b) => compareForRepresentative(a, b, asOfDate));
      const representative = variants[0];
      return {
        ...representative,
        sourceUrls: [...new Set(variants.flatMap((variant) => variant.sourceUrls || [variant.sourceUrl]))],
        variantCount: variants.length,
        variantIds: variants.map((variant) => variant.id),
        variantTitles: variants.map((variant) => variant.title),
      };
    })
    .sort((a, b) => compareForRepresentative(a, b, asOfDate));
}

function groupKey(scholarship) {
  return `${normalizeProvider(scholarship.provider)}|${normalizeTitleForGrouping(scholarship.title)}`;
}

function normalizeProvider(provider) {
  return provider.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTitleForGrouping(title) {
  const normalized = title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(spring|summer|fall|autumn|winter)\b/g, " ")
    .replace(/\b(application|scholarships?|awards?|grants?|programs?|funds?)\b/g, " ")
    .replace(/\b(no\.?|number)\s*\d+\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized && normalized.split(" ").length >= 2
    ? normalized
    : title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compareForRepresentative(a, b, asOfDate) {
  const aClosed = isClosed(a, asOfDate);
  const bClosed = isClosed(b, asOfDate);
  if (aClosed !== bClosed) return aClosed ? 1 : -1;
  const aDeadline = a.deadline || "9999-12-31";
  const bDeadline = b.deadline || "9999-12-31";
  if (aDeadline !== bDeadline) return aDeadline.localeCompare(bDeadline);
  return a.title.localeCompare(b.title);
}

function isClosed(scholarship, asOfDate) {
  return scholarship.programStatus === "inactive"
    || Boolean(scholarship.deadline && scholarship.deadline.slice(0, 10) < asOfDate);
}
