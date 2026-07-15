import "server-only";

type QueryValue = string | number | boolean | null | undefined;
type SupabaseRequestInit = RequestInit & {
  next?: { revalidate?: number; tags?: string[] };
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";

export function hasSupabaseConfig(): boolean {
  return Boolean(url && publishableKey);
}

export function canUseSnapshotFallback(): boolean {
  return !hasSupabaseConfig() && (
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_SNAPSHOT_FALLBACK === "true"
  );
}

export function requireSupabaseConfig() {
  if (!hasSupabaseConfig()) {
    throw new Error("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
}

function endpoint(path: string, queryValues?: Record<string, QueryValue>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(queryValues || {})) {
    if (value !== null && value !== undefined) query.set(key, String(value));
  }
  return `${url}/rest/v1${path}${query.size ? `?${query}` : ""}`;
}

function requestHeaders(key: string, init: SupabaseRequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("content-type", "application/json");
  if (!headers.has("prefer")) headers.set("prefer", "return=representation");
  return headers;
}

export async function publicSupabaseFetch(
  path: string,
  init: SupabaseRequestInit = {},
  query?: Record<string, QueryValue>,
) {
  requireSupabaseConfig();
  return fetch(endpoint(path, query), {
    ...init,
    headers: requestHeaders(publishableKey, init),
  });
}
