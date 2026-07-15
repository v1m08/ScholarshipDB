import { NextRequest, NextResponse } from "next/server";
import {
  searchScholarships,
  type SearchQuery,
} from "@/lib/catalog-search";
import { loadFullCatalogIntoMemory } from "@/lib/directory-store";
import { canonicalTag } from "@/lib/facets";
import { type SearchResponse } from "@/lib/scholarship";
import { canUseSnapshotFallback, hasSupabaseConfig } from "@/lib/supabase/server";
import { searchPublishedScholarships } from "@/lib/supabase/search";

export async function GET(request: NextRequest) {
  const parameters = request.nextUrl.searchParams;
  const query = parseSearchQuery(parameters);
  try {
    if (!hasSupabaseConfig() && !canUseSnapshotFallback()) {
      throw new Error("Supabase is required in production.");
    }
    const result = hasSupabaseConfig()
      ? await searchPublishedScholarships({ ...query, cursor: parameters.get("cursor") || undefined })
      : await searchSnapshot(query);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        "X-Directory-Mode": hasSupabaseConfig() ? "supabase-keyset" : "snapshot-fallback",
      },
    });
  } catch (error) {
    console.error("Scholarship search failed", error);
    return NextResponse.json(
      { error: "Scholarship search is temporarily unavailable." },
      { status: 500 },
    );
  }
}

async function searchSnapshot(query: SearchQuery): Promise<SearchResponse> {
  const catalog = await loadFullCatalogIntoMemory();
  return searchScholarships(catalog, query);
}

function parseSearchQuery(query: URLSearchParams): SearchQuery {
  const asOfDate = query.get("asOfDate") || "";
  return {
    q: cleanParameter(query.get("q"), 160),
    grade: cleanParameter(query.get("grade"), 80),
    tag: query.get("tag") ? canonicalTag(query.get("tag") || "") : undefined,
    state: cleanParameter(query.get("state"), 2)?.toUpperCase(),
    minimumAward: boundedNumber(query.get("minimumAward"), 0, 1_000_000),
    institutionScope: normalizeInstitutionScope(query.get("institutionScope")),
    includeClosed: query.get("includeClosed") === "true",
    vettedOnly: query.get("vettedOnly") === "true",
    page: boundedNumber(query.get("page"), 1, 10_000) || 1,
    limit: boundedNumber(query.get("limit"), 1, 200) || 100,
    asOfDate: /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ? asOfDate : undefined,
  };
}

function normalizeInstitutionScope(value: string | null): SearchQuery["institutionScope"] {
  if (value === "general" || value === "institution") return value;
  return "all";
}

function cleanParameter(value: string | null, maximum: number): string | undefined {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  return cleaned || undefined;
}

function boundedNumber(value: string | null, minimum: number, maximum: number): number | undefined {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
