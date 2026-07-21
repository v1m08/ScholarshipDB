import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const text = (path) => readFile(new URL(path, import.meta.url), "utf8");
const supabaseSchema = async () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  return (await Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8")))).join("\n");
};

test("the deployed app has no privileged Supabase credential or admin mutation surface", async () => {
  const server = await text("../src/lib/supabase/server.ts");
  const nextConfig = await text("../next.config.ts");
  const prodCheck = await text("../scripts/prod-check.mjs");
  assert.doesNotMatch(server, /SERVICE_ROLE|INTAKE|authenticatedSupabaseFetch|method:\s*["'](?:POST|PATCH|DELETE)/);
  assert.match(prodCheck, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(nextConfig, /X-Content-Type-Options/);
  assert.match(nextConfig, /X-Frame-Options/);
  assert.match(nextConfig, /Permissions-Policy/);
  for (const path of ["../src/app/api/submissions/route.ts", "../src/app/api/edits/route.ts", "../src/app/api/review/candidates/route.ts"]) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});

test("Supabase exposes only published scholarships", async () => {
  const schema = await supabaseSchema();
  assert.match(schema, /enable row level security/);
  assert.match(schema, /publication_status = 'published'/);
  assert.doesNotMatch(schema, /on public\.scholarships for (?:insert|update|delete)/);
  assert.match(schema, /revoke all on public\.scholarships from anon, authenticated/);
  assert.match(schema, /grant select on public\.scholarships to anon, authenticated/);
  assert.match(schema, /security invoker/);
  assert.match(schema, /least\(greatest\(p_limit, 1\), 200\)/);
});

test("anonymous scholarship reports are insert-only and bounded", async () => {
  const directory = await text("../src/components/ScholarshipReportButton.tsx");
  const schema = await supabaseSchema();
  assert.match(schema, /create table if not exists public\.scholarship_reports/);
  assert.match(schema, /char_length\(trim\(issue\)\) between 10 and 1000/);
  assert.match(schema, /on public\.scholarship_reports for insert to anon, authenticated/);
  assert.match(schema, /grant insert \(scholarship_id, issue\) on public\.scholarship_reports to anon, authenticated/);
  assert.doesNotMatch(schema, /on public\.scholarship_reports for (?:select|update|delete)/);
  assert.match(directory, /rest\/v1\/scholarship_reports/);
  assert.match(directory, /Prefer: "return=minimal"/);
});

test("public search bounds input and production requires Supabase", async () => {
  const search = await text("../src/app/api/search/route.ts");
  const scholarships = await text("../src/app/api/scholarships/route.ts");
  const server = await text("../src/lib/supabase/server.ts");
  const nextConfig = await text("../next.config.ts");
  assert.match(search, /cleanParameter\(query\.get\("q"\), 160\)/);
  assert.match(search, /boundedNumber\(query\.get\("limit"\), 1, 200\)/);
  assert.match(scholarships, /boundedNumber\(parameters\.get\("limit"\), 1, 200\)/);
  assert.match(server, /ALLOW_SNAPSHOT_FALLBACK/);
  assert.match(server, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(server, /SUPABASE_ANON_KEY/);
  assert.match(search, /Supabase is required in production/);
});

test("vetted-only filtering crosses the UI, snapshot search, and Supabase RPC", async () => {
  const directory = await text("../src/components/SearchDirectory.tsx");
  const route = await text("../src/app/api/search/route.ts");
  const catalogSearch = await text("../src/lib/catalog-search.ts");
  const supabaseSearch = await text("../src/lib/supabase/search.ts");
  const schema = await supabaseSchema();
  assert.match(directory, /parameters\.set\("vettedOnly", "true"\)/);
  assert.match(route, /vettedOnly: query\.get\("vettedOnly"\) === "true"/);
  assert.match(catalogSearch, /effectiveVetting\(scholarship\)\.status === "unvetted"/);
  assert.match(supabaseSearch, /p_vetted_only: query\.vettedOnly === true/);
  assert.match(schema, /p_vetted_only boolean default false/);
  assert.match(schema, /s\.vetting ->> 'status'.*<> 'unvetted'/);
});
test("the local publisher uses a secret key that production rejects", async () => {
  const publisher = await text("../scripts/publish-supabase.mjs");
  const maintainer = await text("../scripts/scholarship-db.mjs");
  const prodCheck = await text("../scripts/prod-check.mjs");
  const gitignore = await text("../.gitignore");
  assert.match(publisher, /SUPABASE_SECRET_KEY/);
  assert.match(maintainer, /SUPABASE_SECRET_KEY/);
  assert.match(maintainer, /if \(!options\.yes\)/);
  assert.match(publisher, /resolution=merge-duplicates/);
  assert.match(prodCheck, /Do not deploy with a Supabase secret\/service-role key/);
  assert.match(gitignore, /\.env\.\*/);
});

test("Supabase search counts narrow IDs before hydrating records", async () => {
  const migration = await text("../supabase/migrations/20260715065342_optimize_search_rpc.sql");
  assert.match(migration, /with matched as materialized/);
  assert.match(migration, /select s.id, s.deadline/);
  assert.match(migration, /join public.scholarships s on s.id = p.id/);
  assert.ok(!migration.includes("count(*) over"));
});
