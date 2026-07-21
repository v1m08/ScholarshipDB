import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

import { normalizeRecord } from "../lib/normalize-record.mjs";

export const BIGFUTURE_SOURCE = "BigFuture Scholarship Search";
export const BIGFUTURE_PRIORITY = 100;

const IMPORTANT_FIELDS = [
  "title",
  "provider",
  "sourceUrl",
  "applicationUrl",
  "opens",
  "deadline",
  "description",
  "award.maximum",
  "award.varies",
  "requirements.essay",
  "requirements.needBased",
  "requirements.meritBased",
  "requirements.fee",
  "eligibility.countries",
  "eligibility.states",
  "eligibility.grades",
  "eligibility.degreeLevels",
  "eligibility.fields",
  "eligibility.minimumGpa",
  "eligibility.minimumAge",
  "eligibility.citizenship",
  "eligibility.other",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(record, path) {
  return path.split(".").reduce((value, key) => value?.[key], record);
}

function stableValue(value) {
  return JSON.stringify(value ?? null);
}

function hasValue(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function isDate(value) {
  if (value === null || value === undefined || value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isWebUrl(value, expectedHost = null) {
  if (!hasValue(value)) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && (!expectedHost || url.hostname === expectedHost);
  } catch {
    return false;
  }
}

function isTriState(value) {
  return value === true || value === false || value === null || value === undefined;
}

function addIssue(issues, line, field, reason) {
  issues.push({ line, field, reason });
}

export function validateBigFutureRecord(record, line = 0) {
  const issues = [];
  if (!isObject(record)) return [{ line, field: "$", reason: "record_must_be_an_object" }];
  if (record.sourceName !== BIGFUTURE_SOURCE) addIssue(issues, line, "sourceName", "unexpected_source");
  if (typeof record.id !== "string" || !record.id.startsWith("bigfuture-")) addIssue(issues, line, "id", "invalid_bigfuture_id");
  if (!hasValue(record.title)) addIssue(issues, line, "title", "missing_title");
  if (!hasValue(record.provider)) addIssue(issues, line, "provider", "missing_provider");
  if (!isWebUrl(record.sourceUrl, "bigfuture.collegeboard.org")) addIssue(issues, line, "sourceUrl", "invalid_bigfuture_url");
  if (!isWebUrl(record.applicationUrl)) addIssue(issues, line, "applicationUrl", "invalid_application_url");
  for (const field of ["sourceCheckedAt", "opens", "deadline"]) {
    if (!isDate(record[field])) addIssue(issues, line, field, "invalid_date");
  }

  const maximum = record.award?.maximum;
  if (maximum !== null && maximum !== undefined && (typeof maximum !== "number" || maximum < 0)) {
    addIssue(issues, line, "award.maximum", "invalid_nonnegative_number");
  }
  if (typeof record.award?.varies !== "boolean") addIssue(issues, line, "award.varies", "must_be_boolean");
  for (const field of ["essay", "needBased", "meritBased", "fee"]) {
    if (!isTriState(record.requirements?.[field])) addIssue(issues, line, `requirements.${field}`, "must_be_boolean_or_null");
  }
  for (const field of ["countries", "states", "grades", "degreeLevels", "fields", "citizenship", "tags", "other"]) {
    if (!Array.isArray(record.eligibility?.[field])) addIssue(issues, line, `eligibility.${field}`, "must_be_array");
  }
  for (const field of ["minimumGpa", "minimumAge"]) {
    const value = record.eligibility?.[field];
    if (value !== null && value !== undefined && (typeof value !== "number" || value < 0)) {
      addIssue(issues, line, `eligibility.${field}`, "invalid_nonnegative_number");
    }
  }
  return issues;
}

export function scholarshipFingerprint(record) {
  return `${String(record.title || "").toLowerCase()}|${String(record.provider || "").toLowerCase()}|${record.applicationUrl || record.sourceUrl || ""}`;
}

function mergeMissing(target, candidate) {
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(candidate)) {
    if (!hasValue(result[key]) && hasValue(value)) result[key] = structuredClone(value);
    else if (isObject(result[key]) && isObject(value)) result[key] = mergeMissing(result[key], value);
  }
  return result;
}

export function canonicalizeBigFutureGroup(records) {
  if (records.length === 0) throw new Error("Cannot canonicalize an empty group");
  const merged = records.slice(1).reduce(mergeMissing, records[0]);
  const normalized = normalizeRecord(merged);
  return {
    ...normalized,
    sourceUrls: [...new Set(records.flatMap((record) => record.sourceUrls || [record.sourceUrl]).filter(Boolean))].sort(),
  };
}

export function findConflictingFields(records) {
  return IMPORTANT_FIELDS.filter((fieldName) => fieldName !== "sourceUrl").filter((fieldName) => {
    const supportedValues = records
      .map((record) => valueAt(record, fieldName))
      .filter(hasValue)
      .map(stableValue);
    return new Set(supportedValues).size > 1;
  });
}

function indexMany(records, keys) {
  const index = new Map();
  for (const record of records) {
    for (const key of keys(record)) {
      if (!key) continue;
      const matches = index.get(key) || [];
      matches.push(record);
      index.set(key, matches);
    }
  }
  return index;
}

export function matchCurrentRecord(source, indexes) {
  const candidates = [
    ["id", indexes.byId.get(source.id) || []],
    ["source_url", [...new Set(source.sourceUrls.flatMap((url) => indexes.byUrl.get(url) || []))]],
    ["fingerprint", indexes.byFingerprint.get(scholarshipFingerprint(source)) || []],
  ];
  for (const [matchedBy, matches] of candidates) {
    if (matches.length === 1) return { status: "matched", matchedBy, record: matches[0] };
    if (matches.length > 1) return { status: "ambiguous", matchedBy, records: matches };
  }
  return { status: "missing" };
}

export function buildFieldDecisions(source, current) {
  const changes = [];
  const retainedCurrentFields = [];
  for (const fieldName of IMPORTANT_FIELDS) {
    const sourceValue = valueAt(source, fieldName);
    const currentValue = valueAt(current, fieldName);
    if (!hasValue(sourceValue) && hasValue(currentValue)) {
      retainedCurrentFields.push({
        fieldName,
        sourceName: BIGFUTURE_SOURCE,
        sourcePriority: BIGFUTURE_PRIORITY,
        rawValue: null,
        normalizedValue: null,
        currentValue,
        chosenValue: currentValue,
        chosenReason: "bigfuture_missing_preserve_current_for_review",
        confidenceScore: 0.5,
        updatedAt: source.sourceCheckedAt || null,
      });
    } else if (hasValue(sourceValue) && stableValue(sourceValue) !== stableValue(currentValue)) {
      changes.push({
        fieldName,
        sourceName: BIGFUTURE_SOURCE,
        sourcePriority: BIGFUTURE_PRIORITY,
        rawValue: sourceValue,
        normalizedValue: sourceValue,
        currentValue: currentValue ?? null,
        chosenValue: sourceValue,
        chosenReason: "bigfuture_structured_source_priority",
        confidenceScore: 0.99,
        updatedAt: source.sourceCheckedAt || null,
      });
    }
  }
  return { changes, retainedCurrentFields };
}

async function readJsonLines(path) {
  const records = [];
  const parseIssues = [];
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  let line = 0;
  for await (const text of lines) {
    line += 1;
    if (!text.trim()) continue;
    try {
      records.push({ line, record: JSON.parse(text) });
    } catch (error) {
      parseIssues.push({ line, field: "$", reason: "invalid_json", message: error.message });
    }
  }
  return { records, parseIssues };
}

async function writeJsonLines(path, records) {
  const stream = createWriteStream(path, "utf8");
  for (const record of records) {
    if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function runAudit({ root = resolve(dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
  const sourcePath = join(root, "data/imports/bigfuture/records.jsonl");
  const catalogPath = join(root, "src/generated/catalog.json");
  const outputDir = join(root, "data/phase-a");
  await mkdir(outputDir, { recursive: true });

  const { records: sourceRows, parseIssues } = await readJsonLines(sourcePath);
  const validationIssues = [...parseIssues];
  const ids = new Map();
  const urls = new Map();
  const groups = new Map();
  for (const { line, record } of sourceRows) {
    validationIssues.push(...validateBigFutureRecord(record, line));
    if (ids.has(record.id)) addIssue(validationIssues, line, "id", `duplicate_of_line_${ids.get(record.id)}`);
    else ids.set(record.id, line);
    if (urls.has(record.sourceUrl)) addIssue(validationIssues, line, "sourceUrl", `duplicate_of_line_${urls.get(record.sourceUrl)}`);
    else urls.set(record.sourceUrl, line);
    const fingerprint = scholarshipFingerprint(record);
    const group = groups.get(fingerprint) || [];
    group.push(record);
    groups.set(fingerprint, group);
  }

  const canonicalRecords = [...groups.values()]
    .map(canonicalizeBigFutureGroup)
    .sort((left, right) => left.id.localeCompare(right.id));
  const duplicateGroups = [...groups.entries()]
    .filter(([, records]) => records.length > 1)
    .map(([fingerprint, records]) => ({
      fingerprint,
      ids: records.map((record) => record.id).sort(),
      conflictingFields: findConflictingFields(records),
    }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const duplicateConflictsById = new Map(
    duplicateGroups
      .filter((group) => group.conflictingFields.length > 0)
      .map((group) => [groups.get(group.fingerprint)[0].id, group]),
  );

  const currentCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const indexes = {
    byId: indexMany(currentCatalog, (record) => [record.id]),
    byUrl: indexMany(currentCatalog, (record) => record.sourceUrls || [record.sourceUrl]),
    byFingerprint: indexMany(currentCatalog, (record) => [scholarshipFingerprint(record)]),
  };

  const restorationPlan = [];
  const reviewQueue = [...duplicateConflictsById.entries()].map(([sourceId, group]) => ({
    sourceId,
    sourceUrl: groups.get(group.fingerprint)[0].sourceUrl,
    reason: "conflicting_bigfuture_source_rows",
    candidateIds: group.ids,
    fields: group.conflictingFields,
  }));
  const matchCounts = { id: 0, source_url: 0, fingerprint: 0, missing: 0, ambiguous: 0 };
  let changedFields = 0;
  let lowerPriorityWinners = 0;
  for (const source of canonicalRecords) {
    const match = matchCurrentRecord(source, indexes);
    if (match.status !== "matched") {
      matchCounts[match.status] += 1;
      reviewQueue.push({
        sourceId: source.id,
        sourceUrl: source.sourceUrl,
        reason: match.status === "missing" ? "current_record_not_found" : `ambiguous_${match.matchedBy}_match`,
        candidateIds: match.records?.map((record) => record.id).sort() || [],
      });
      continue;
    }

    matchCounts[match.matchedBy] += 1;
    const decisions = buildFieldDecisions(source, match.record);
    const conflictingFields = new Set(duplicateConflictsById.get(source.id)?.conflictingFields || []);
    const safeChanges = decisions.changes.filter((change) => !conflictingFields.has(change.fieldName));
    const sourceWinnerConflict = match.record.sourceName !== BIGFUTURE_SOURCE;
    if (sourceWinnerConflict) lowerPriorityWinners += 1;
    if (decisions.retainedCurrentFields.length > 0) {
      reviewQueue.push({
        sourceId: source.id,
        currentId: match.record.id,
        sourceUrl: source.sourceUrl,
        reason: "bigfuture_missing_value_current_value_retained",
        fields: decisions.retainedCurrentFields.map((decision) => decision.fieldName),
      });
    }
    if (safeChanges.length > 0 || sourceWinnerConflict) {
      changedFields += safeChanges.length;
      restorationPlan.push({
        sourceId: source.id,
        currentId: match.record.id,
        matchedBy: match.matchedBy,
        sourceUrl: source.sourceUrl,
        sourceWinnerConflict,
        changes: safeChanges,
        retainedCurrentFields: decisions.retainedCurrentFields,
      });
    }
  }

  restorationPlan.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  reviewQueue.sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.reason.localeCompare(right.reason));
  const restorationFieldsByName = Object.fromEntries(
    [...IMPORTANT_FIELDS]
      .map((fieldName) => [fieldName, restorationPlan.reduce(
        (count, item) => count + item.changes.filter((change) => change.fieldName === fieldName).length,
        0,
      )])
      .filter(([, count]) => count > 0),
  );
  const reviewItemsByReason = Object.fromEntries(
    [...new Set(reviewQueue.map((item) => item.reason))]
      .sort()
      .map((reason) => [reason, reviewQueue.filter((item) => item.reason === reason).length]),
  );

  const baselinePath = join(outputDir, "bigfuture-baseline.jsonl");
  const planPath = join(outputDir, "restoration-plan.jsonl");
  const reviewPath = join(outputDir, "review-queue.jsonl");
  await writeJsonLines(baselinePath, canonicalRecords);
  await writeJsonLines(planPath, restorationPlan);
  await writeJsonLines(reviewPath, reviewQueue);

  const report = {
    phase: "A",
    mode: "local_file_audit_no_database_writes",
    source: BIGFUTURE_SOURCE,
    sourcePriority: BIGFUTURE_PRIORITY,
    sourceRows: sourceRows.length,
    canonicalRecords: canonicalRecords.length,
    duplicateFingerprintGroups: duplicateGroups.length,
    duplicateFingerprintRowsCollapsed: sourceRows.length - canonicalRecords.length,
    duplicateFingerprintGroupsWithConflicts: duplicateConflictsById.size,
    duplicateGroups,
    currentCatalogRecords: currentCatalog.length,
    validationIssueCount: validationIssues.length,
    validationIssues,
    matches: matchCounts,
    restorationRecords: restorationPlan.length,
    restorationFields: changedFields,
    restorationFieldsByName,
    lowerPrioritySourceWinners: lowerPriorityWinners,
    reviewQueueItems: reviewQueue.length,
    reviewItemsByReason,
    taxonomy: "preserved_in_baseline_but_excluded_from_automatic_restoration_pending_phase_b",
    rollback: "No database was changed. Discard data/phase-a artifacts to roll back this audit.",
  };
  const reportPath = join(outputDir, "audit-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdownPath = join(outputDir, "audit-report.md");
  await writeFile(markdownPath, `# Phase A BigFuture audit\n\n- Mode: local file audit; no database writes\n- Source rows: ${report.sourceRows}\n- Canonical BigFuture records: ${report.canonicalRecords}\n- Exact duplicate rows collapsed: ${report.duplicateFingerprintRowsCollapsed} across ${report.duplicateFingerprintGroups} groups\n- Validation issues: ${report.validationIssueCount}\n- Current records matched: ${report.matches.id + report.matches.source_url + report.matches.fingerprint}\n- Missing or ambiguous matches: ${report.matches.missing + report.matches.ambiguous}\n- Records requiring restoration: ${report.restorationRecords}\n- Fields requiring restoration: ${report.restorationFields}\n- Current lower-priority source winners: ${report.lowerPrioritySourceWinners}\n- Review queue items: ${report.reviewQueueItems}\n- Taxonomy: retained for inspection, excluded from automatic restoration until Phase B\n\nRollback is deletion of the generated \`data/phase-a\` directory because this command never writes to Supabase.\n`);

  const manifest = {
    inputs: {
      "data/imports/bigfuture/records.jsonl": await sha256(sourcePath),
      "src/generated/catalog.json": await sha256(catalogPath),
    },
    outputs: {
      "bigfuture-baseline.jsonl": await sha256(baselinePath),
      "restoration-plan.jsonl": await sha256(planPath),
      "review-queue.jsonl": await sha256(reviewPath),
      "audit-report.json": await sha256(reportPath),
      "audit-report.md": await sha256(markdownPath),
    },
  };
  await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (validationIssues.length > 0 || matchCounts.ambiguous > 0) process.exitCode = 1;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await runAudit();
  console.log(JSON.stringify({
    sourceRows: report.sourceRows,
    canonicalRecords: report.canonicalRecords,
    validationIssues: report.validationIssueCount,
    restorationRecords: report.restorationRecords,
    restorationFields: report.restorationFields,
    reviewQueueItems: report.reviewQueueItems,
  }, null, 2));
}
