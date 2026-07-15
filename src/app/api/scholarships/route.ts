import { NextRequest, NextResponse } from "next/server";
import { searchScholarships } from "@/lib/catalog-search";
import { loadFullCatalogIntoMemory } from "@/lib/directory-store";
import { canUseSnapshotFallback, hasSupabaseConfig } from "@/lib/supabase/server";
import { searchPublishedScholarships } from "@/lib/supabase/search";

export async function GET(request: NextRequest) {
  const parameters = request.nextUrl.searchParams;
  if (parameters.get("all") === "true") {
    return NextResponse.json(
      { error: "Bulk exports are generated offline; use the paginated API." },
      { status: 410 },
    );
  }
  if (!hasSupabaseConfig() && !canUseSnapshotFallback()) {
    return NextResponse.json({ error: "Supabase is required in production." }, { status: 503 });
  }
  const page = boundedNumber(parameters.get("page"), 1, 10_000) || 1;
  const limit = boundedNumber(parameters.get("limit"), 1, 200) || 100;
  const result = hasSupabaseConfig()
    ? await searchPublishedScholarships({
        includeClosed: true,
        page,
        limit,
        cursor: parameters.get("cursor") || undefined,
      })
    : searchScholarships(await loadFullCatalogIntoMemory(), { includeClosed: true, page, limit });
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    count: result.total,
    page: result.page,
    limit: result.limit,
    scholarships: result.records,
  });
}

function boundedNumber(value: string | null, minimum: number, maximum: number): number | undefined {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}
