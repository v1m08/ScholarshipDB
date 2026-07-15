import { effectiveVetting, isClosed, localDateString, type Scholarship, type SearchResponse } from "@/lib/scholarship";
import { gradeFilterMatches } from "@/lib/facets";

export interface SearchQuery {
  q?: string;
  grade?: string;
  tag?: string;
  state?: string;
  minimumAward?: number;
  institutionScope?: "all" | "general" | "institution";
  includeClosed?: boolean;
  vettedOnly?: boolean;
  asOfDate?: string;
  page?: number;
  limit?: number;
}

export function searchScholarships(records: Scholarship[], query: SearchQuery = {}): SearchResponse {
  return createSearchResponse(filterScholarships(records, query), query);
}

function filterScholarships(records: Scholarship[], query: SearchQuery = {}): Scholarship[] {
  const terms = (query.q || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const asOfDate = query.asOfDate || localDateString();
  return records.filter((scholarship) => {
    if (query.includeClosed === false && isClosed(scholarship, asOfDate)) return false;
    if (terms.some((term) => !scholarship.searchText.includes(term))) return false;
    if (query.grade && !gradeFilterMatches(scholarship.eligibility.grades, query.grade)) return false;
    if (query.tag && !scholarship.eligibility.tags.includes(query.tag)) return false;
    if (query.state && !scholarship.eligibility.states.includes(query.state)) return false;
    if (query.minimumAward && (scholarship.award.maximum ?? 0) < query.minimumAward) return false;
    if (query.institutionScope === "general" && scholarship.institutionSpecific) return false;
    if (query.institutionScope === "institution" && !scholarship.institutionSpecific) return false;
    if (query.vettedOnly && effectiveVetting(scholarship).status === "unvetted") return false;
    return true;
  });
}

function createSearchResponse(
  matches: Scholarship[],
  query: SearchQuery = {},
): SearchResponse {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(500, Math.max(1, query.limit || 100));
  const asOfDate = query.asOfDate || localDateString();
  const grouped = groupSimilarScholarships(matches, asOfDate);
  const offset = (page - 1) * limit;
  return {
    records: grouped.slice(offset, offset + limit),
    total: grouped.length,
    rawTotal: matches.length,
    page,
    limit,
    hasMore: offset + limit < grouped.length,
  };
}

function groupSimilarScholarships(matches: Scholarship[], asOfDate: string): Scholarship[] {
  const groups = new Map<string, Scholarship[]>();
  for (const scholarship of matches) {
    const key = groupKey(scholarship);
    groups.set(key, [...(groups.get(key) || []), scholarship]);
  }

  return Array.from(groups.values())
    .map((group) => {
      if (group.length === 1) return group[0];
      const variants = [...group].sort((a, b) => compareForRepresentative(a, b, asOfDate));
      const representative = variants[0];
      return {
        ...representative,
        sourceUrls: Array.from(new Set(variants.flatMap((variant) => variant.sourceUrls || [variant.sourceUrl]))),
        variantCount: variants.length,
        variantIds: variants.map((variant) => variant.id),
        variantTitles: variants.map((variant) => variant.title),
      };
    })
    .sort((a, b) => compareForRepresentative(a, b, asOfDate));
}

function groupKey(scholarship: Scholarship): string {
  return `${normalizeProvider(scholarship.provider)}|${normalizeTitleForGrouping(scholarship.title)}`;
}

function normalizeProvider(provider: string): string {
  return provider.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTitleForGrouping(title: string): string {
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
  const tokenCount = normalized ? normalized.split(" ").length : 0;
  if (tokenCount >= 2) return normalized;
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compareForRepresentative(a: Scholarship, b: Scholarship, asOfDate: string): number {
  const aClosed = isClosed(a, asOfDate);
  const bClosed = isClosed(b, asOfDate);
  if (aClosed !== bClosed) return aClosed ? 1 : -1;
  const aDeadline = a.deadline || "9999-12-31";
  const bDeadline = b.deadline || "9999-12-31";
  if (aDeadline !== bDeadline) return aDeadline.localeCompare(bDeadline);
  return a.title.localeCompare(b.title);
}
