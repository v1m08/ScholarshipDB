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
if (!url || !key) throw new Error("Set SUPABASE_URL and local-only SUPABASE_SECRET_KEY before publishing.");

const catalog = JSON.parse(await readFile("src/generated/catalog.json", "utf8"));
const rows = catalog.map((record) => ({
  id: record.id,
  title: record.title,
  provider: record.provider,
  source_name: record.sourceName,
  source_url: record.sourceUrl,
  source_urls: record.sourceUrls || [record.sourceUrl],
  source_checked_at: record.sourceCheckedAt,
  source_missing_fields: record.sourceMissingFields || record.vetting?.missingFields || [],
  application_url: record.applicationUrl,
  opens: record.opens || null,
  deadline: record.deadline || null,
  description: record.description || "",
  award: record.award,
  requirements: record.requirements,
  eligibility: record.eligibility,
  institution_specific: record.institutionSpecific || false,
  institution_name: record.institutionName || null,
  institution_types: record.institutionTypes || [],
  search_text: record.searchText || "",
  vetting: record.vetting,
  publication_status: "published",
  published_at: record.vetting?.vettedAt || null,
  updated_at: new Date().toISOString(),
}));

for (let index = 0; index < rows.length; index += 100) {
  const response = await fetch(`${url}/rest/v1/scholarships?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: key,
      ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows.slice(index, index + 100)),
  });
  if (!response.ok) throw new Error(`Supabase publish failed: ${response.status} ${await response.text()}`);
  console.log(`Published ${Math.min(index + 100, rows.length)}/${rows.length}`);
}