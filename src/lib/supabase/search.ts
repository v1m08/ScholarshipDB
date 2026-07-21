import "server-only";

import type { SearchQuery } from "@/lib/catalog-search";
import type { Scholarship, ScholarshipSummary, SearchResponse, SearchSummaryResponse } from "@/lib/scholarship";
import { scholarshipSummary } from "@/lib/scholarship";
import { publicSupabaseFetch } from "@/lib/supabase/server";
import { fromRow } from "@/lib/supabase/scholarships";

interface SearchRpcRow {
  record: Record<string, unknown>;
  total_count: number;
}

interface SummaryRpcRow {
  record: ScholarshipSummary;
  total_count: number;
}

interface CursorValue {
  deadline: string | null;
  id: string;
}

export async function searchPublishedScholarships(
  query: SearchQuery & { cursor?: string },
): Promise<SearchResponse> {
  const limit = Math.min(200, Math.max(1, query.limit || 100));
  const cursor = decodeCursor(query.cursor);
  const response = await publicSupabaseFetch("/rpc/search_published_scholarships", {
    method: "POST",
    body: JSON.stringify(rpcParameters(query, cursor, limit + 1, !cursor)),
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Published scholarship search failed: ${response.status}`);
  const rows = await response.json() as SearchRpcRow[];
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit).map((row) => fromRow(row.record as never));
  const last = records.at(-1);
  return { records, total: Number(rows[0]?.total_count || 0), rawTotal: Number(rows[0]?.total_count || 0), page: Math.max(1, query.page || 1), limit, hasMore, nextCursor: hasMore && last ? encodeCursor({ deadline: last.deadline, id: last.id }) : undefined };
}

export async function searchPublishedScholarshipSummaries(
  query: SearchQuery & { cursor?: string },
): Promise<SearchSummaryResponse> {
  const limit = Math.min(100, Math.max(1, query.limit || 30));
  const cursor = decodeCursor(query.cursor);
  const response = await publicSupabaseFetch("/rpc/search_published_scholarship_summaries", {
    method: "POST",
    body: JSON.stringify(rpcParameters(query, cursor, limit + 1, !cursor)),
    next: { revalidate: 300 },
  });
  // Keep production available while an older database receives this migration.
  // This fallback still fetches only one page; it never loads the catalog into memory.
  if (response.status === 404) {
    const full = await searchPublishedScholarships({ ...query, limit });
    return { ...full, records: full.records.map(scholarshipSummary) };
  }
  if (!response.ok) throw new Error(`Published scholarship summary search failed: ${response.status}`);
  const rows = await response.json() as SummaryRpcRow[];
  const hasMore = rows.length > limit;
  const records = rows.slice(0, limit).map((row) => row.record);
  const last = records.at(-1);
  return { records, total: Number(rows[0]?.total_count || 0), rawTotal: Number(rows[0]?.total_count || 0), page: Math.max(1, query.page || 1), limit, hasMore, nextCursor: hasMore && last ? encodeCursor({ deadline: last.deadline, id: last.id }) : undefined };
}

export async function getPublishedScholarship(id: string): Promise<Scholarship | null> {
  const response = await publicSupabaseFetch("/scholarships", {
    next: { revalidate: 300 },
  }, {
    select: "*",
    id: `eq.${id}`,
    publication_status: "eq.published",
    limit: 1,
  });
  if (!response.ok) return null;
  const rows = await response.json() as Array<Record<string, unknown>>;
  return rows[0] ? fromRow(rows[0] as never) : null;
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value?: string): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorValue;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function rpcParameters(query: SearchQuery, cursor: CursorValue | null, limit: number, includeTotal: boolean) {
  return {
    p_query: query.q || null,
    p_grade: query.grade || null,
    p_tag: query.tag || null,
    p_state: query.state || null,
    p_minimum_award: query.minimumAward || null,
    p_institution_scope: query.institutionScope || "all",
    p_include_closed: query.includeClosed === true,
    p_vetted_only: query.vettedOnly === true,
    p_as_of_date: query.asOfDate || new Date().toISOString().slice(0, 10),
    p_cursor_deadline: cursor?.deadline || null,
    p_cursor_id: cursor?.id || null,
    p_limit: limit,
    p_include_total: includeTotal,
  };
}
