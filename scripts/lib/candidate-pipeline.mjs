import { createHash } from "node:crypto";
import { normalizeRecord } from "./normalize-record.mjs";

const COUNTRY_ALIASES = new Map([
  ["UNITED STATES", "US"],
  ["UNITED STATES OF AMERICA", "US"],
  ["USA", "US"],
  ["CANADA", "CA"],
  ["MEXICO", "MX"],
  ["UNITED KINGDOM", "GB"],
  ["PUERTO RICO", "PR"],
]);

export function prepareCandidate(record, context = {}) {
  const normalized = normalizeRecord({
    ...record,
    eligibility: {
      countries: [],
      states: [],
      grades: [],
      degreeLevels: [],
      fields: [],
      minimumGpa: null,
      minimumAge: null,
      citizenship: [],
      tags: [],
      other: [],
      ...(record.eligibility || {}),
    },
    requirements: {
      essay: null,
      needBased: null,
      meritBased: null,
      fee: null,
      ...(record.requirements || {}),
    },
    award: { maximum: null, varies: false, ...(record.award || {}) },
    institutionTypes: record.institutionTypes || [],
  });
  normalized.eligibility.countries = unique(normalized.eligibility.countries.map(countryCode));
  normalized.sourceUrls = unique([normalized.sourceUrl, ...(normalized.sourceUrls || [])]);
  normalized.sourceMissingFields = missingFields(normalized);

  const errors = validateCandidate(normalized);
  const qualityFlags = [
    ...errors.map((error) => `invalid:${error}`),
    ...normalized.sourceMissingFields.map((field) => `missing:${field}`),
    ...(context.inferredFields?.length ? ["contains_inferred_fields"] : []),
    "human_review_required",
  ];
  const fingerprint = createHash("sha256").update([
    canonical(normalized.title),
    canonical(normalized.provider),
    normalized.applicationUrl,
  ].join("|")).digest("hex");

  return {
    candidateData: normalized,
    normalizedFingerprint: fingerprint,
    qualityFlags: unique(qualityFlags),
    errors,
    evidence: (context.evidence || []).map((item) => ({
      fieldPath: String(item.fieldPath || item.field || ""),
      evidenceText: String(item.evidenceText || item.text || "").slice(0, 2000),
      extractionMethod: String(item.extractionMethod || context.extractionMethod || "source_adapter"),
      confidence: numericConfidence(item.confidence),
    })).filter((item) => item.fieldPath && item.evidenceText),
  };
}

export function validateCandidate(record) {
  const errors = [];
  for (const field of ["id", "title", "provider", "sourceName", "sourceUrl", "applicationUrl"]) {
    if (!record[field]) errors.push(`missing_${field}`);
  }
  for (const field of ["sourceUrl", "applicationUrl"]) {
    try {
      const url = new URL(record[field]);
      if (!["http:", "https:"].includes(url.protocol)) errors.push(`invalid_${field}`);
      if (isPrivateHost(url.hostname)) errors.push(`invalid_${field}`);
    } catch {
      errors.push(`invalid_${field}`);
    }
  }
  for (const field of ["opens", "deadline", "sourceCheckedAt"]) {
    if (record[field] && !/^\d{4}-\d{2}-\d{2}$/.test(record[field])) errors.push(`invalid_${field}`);
  }
  if (record.award.maximum !== null && (!Number.isFinite(record.award.maximum) || record.award.maximum < 0)) {
    errors.push("invalid_award");
  }
  return unique(errors);
}

function missingFields(record) {
  const fields = [];
  if (!record.deadline) fields.push("deadline");
  if (record.award.maximum === null && !record.award.varies) fields.push("award");
  if (!record.eligibility.grades.length) fields.push("grades");
  if (!record.eligibility.degreeLevels.length) fields.push("degree_levels");
  if (!record.eligibility.countries.length && !record.eligibility.states.length) fields.push("location");
  if (!record.description) fields.push("description");
  return unique([...(record.sourceMissingFields || []), ...fields]);
}

function countryCode(value) {
  const upper = String(value || "").trim().toUpperCase();
  return COUNTRY_ALIASES.get(upper) || upper;
}

function canonical(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function numericConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,2})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
