// Archive published Supabase rows that are no longer in the generated catalog
// (curated exclusions, retired ids). Reversible: rows are archived, not deleted.
// Dry run by default; pass --yes to apply.
import { readFile } from "node:fs/promises";

for (const filename of [".env.local", ".env"]) {
  try {
    for (const line of (await readFile(filename, "utf8")).split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Set SUPABASE_URL and local-only SUPABASE_SECRET_KEY.");
const headers = {
  apikey: key,
  ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}),
  "content-type": "application/json",
};

const catalogIds = new Set(
  JSON.parse(await readFile("src/generated/catalog.json", "utf8")).map((record) => record.id),
);

const publishedIds = [];
const PAGE = 1000;
for (let offset = 0; ; offset += PAGE) {
  const response = await fetch(
    `${url}/rest/v1/scholarships?select=id&publication_status=eq.published&order=id`,
    { headers: { ...headers, range: `${offset}-${offset + PAGE - 1}` } },
  );
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  publishedIds.push(...rows.map((row) => row.id));
  if (rows.length < PAGE) break;
}

const stale = publishedIds.filter((id) => !catalogIds.has(id));
console.log(`Published rows: ${publishedIds.length}; in catalog: ${catalogIds.size}; stale: ${stale.length}`);
for (const id of stale.slice(0, 50)) console.log(`  ${id}`);
if (stale.length > 50) console.log(`  ... and ${stale.length - 50} more`);

if (!process.argv.includes("--yes")) {
  console.log("Dry run only. Add --yes to archive these rows.");
  process.exit(0);
}

for (let index = 0; index < stale.length; index += 100) {
  const batch = stale.slice(index, index + 100);
  const response = await fetch(
    `${url}/rest/v1/scholarships?id=in.(${batch.map((id) => `"${id}"`).join(",")})`,
    {
      method: "PATCH",
      headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify({ publication_status: "archived", updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) throw new Error(`Archive failed: ${response.status} ${await response.text()}`);
  console.log(`Archived ${Math.min(index + 100, stale.length)}/${stale.length}`);
}
