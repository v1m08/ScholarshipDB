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
  const migration = await text("../supabase/migrations/20260717120000_optimize_public_search_projection.sql");
  assert.match(migration, /create table if not exists public\.published_scholarship_search/);
  assert.match(migration, /alter table public\.published_scholarship_search enable row level security/);
  assert.match(migration, /using \(true\)/);
  assert.match(migration, /using gin\(search_document\)/);
  assert.match(migration, /security invoker/);
  assert.doesNotMatch(migration, /security definer/);
  assert.match(migration, /from public\.published_scholarship_search s/);
  assert.match(migration, /with matched as materialized/);
  assert.match(migration, /select s.id, s.deadline/);
  assert.match(migration, /join public.scholarships s on s.id = p.id/);
  assert.match(migration, /create trigger sync_published_scholarship_search/);
  assert.ok(!migration.includes("count(*) over"));
});

test("the Phase A restoration schema is private and cannot mutate production", async () => {
  const migration = await text("../supabase/migrations/20260721112950_scholarship_knowledge_system.sql");
  assert.match(migration, /create schema if not exists internal/);
  assert.match(migration, /revoke all on schema internal from public, anon, authenticated/);
  assert.match(migration, /alter table internal\.scholarship_field_values enable row level security/);
  assert.match(migration, /alter table internal\.scholarship_restoration_snapshots enable row level security/);
  assert.doesNotMatch(migration, /security definer/);
  assert.doesNotMatch(migration, /grant .* to anon|grant .* to authenticated/);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from|alter table) public\.scholarships/);
});

test("winner contributions stay pending and cannot mutate scholarship records", async () => {
  const directory = await text("../src/components/SearchDirectory.tsx");
  const form = await text("../src/components/ContributionForm.tsx");
  const homepage = await text("../src/app/page.tsx");
  const navigation = await text("../src/components/SiteNav.tsx");
  const migration = await text("../supabase/migrations/20260716180000_scholarship_contributions.sql");
  assert.doesNotMatch(directory, /scholarship_contributions|Contribute/);
  assert.match(form, /rest\/v1\/scholarship_contributions/);
  assert.match(form, /Remain anonymous/);
  assert.match(form, /source_name/);
  assert.match(form, /source_url/);
  assert.match(form, /name="location"[^>]*required/);
  assert.match(form, /name="grade"[^>]*required/);
  assert.match(form, /name="citizenship"[^>]*required/);
  assert.match(form, /\["essay_required", "Essay required"\]/);
  assert.match(form, /name=\{name\} required/);
  assert.doesNotMatch(form, /source_notes/);
  assert.match(homepage, /Ways to help/);
  assert.match(homepage, /href="\/contribute"/);
  assert.match(navigation, /href: "\/contribute"/);
  assert.match(migration, /status text not null default 'pending'/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.scholarship_contributions from anon, authenticated/);
  assert.match(migration, /grant insert \([\s\S]*?\) on public\.scholarship_contributions to anon, authenticated/);
  assert.match(migration, /grade text not null check/);
  assert.match(migration, /citizenship text not null check/);
  assert.match(migration, /check \(application_url is not null or source_url is not null\)/);
  assert.doesNotMatch(migration, /source_notes/);
  assert.match(migration, /publication_status = 'published'/);
  assert.doesNotMatch(migration, /for (?:select|update|delete) to anon, authenticated/);
  assert.doesNotMatch(migration, /trigger|update public\.scholarships/i);
});

test("homepage count uses published Supabase rows and never renders a zero fallback", async () => {
  const homepage = await text("../src/app/page.tsx");
  assert.match(homepage, /publication_status=eq\.published/);
  assert.match(homepage, /method: "HEAD"/);
  assert.match(homepage, /Prefer: "count=exact"/);
  assert.match(homepage, /content-range/);
  assert.match(homepage, /: "Search scholarships"/);
  assert.doesNotMatch(homepage, /directoryMetadata\.count\.toLocaleString/);
});
