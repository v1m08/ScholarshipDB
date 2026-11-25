// Try the matching function with a few made-up students and print what each would see.
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env. Reads only; changes nothing.
// With the secret key, --drafts also matches scholarships that are not published yet.
// Usage: node scripts/try-match.mjs [--rows 8] [--only "Polk County senior"] [--drafts]
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const env = { ...process.env };
for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) { const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (match && !env[match[1]]) env[match[1]] = match[2].trim(); }
const url = env.SUPABASE_URL.replace(/\/$/, ""), key = env.SUPABASE_SECRET_KEY;
const drafts = process.argv.includes("--drafts");

export const STUDENTS = {
  "Polk County senior": { state: "IA", state_name: "Iowa", county: "Polk County", city: "Des Moines", high_school: "Roosevelt High School", level: "grade-12", gpa: 3.6, citizenship: "us-citizen", gender: "women", need: true, first_generation: true, fields: ["nursing"], careers: ["nurse"], heritage: ["Hispanic", "Mexican"], religion: ["Catholic"], affiliations: ["4-H"], family: ["child of a veteran"], activities: ["soccer", "volunteering"] },
  "Texas engineering sophomore": { state: "TX", state_name: "Texas", county: "Travis County", city: "Austin", level: "college-sophomore", gpa: 3.2, citizenship: "us-citizen", gender: "men", enrollment: "full-time", fields: ["mechanical engineering", "engineering"], heritage: ["Indian", "Asian"], activities: ["robotics", "tennis"], affiliations: ["Boy Scouts", "Eagle Scout"] },
  "Ohio adult returning": { state: "OH", state_name: "Ohio", county: "Summit County", city: "Akron", level: "adult-returning", citizenship: "us-citizen", gender: "women", need: true, enrollment: "part-time", fields: ["accounting", "business"], family: ["single parent", "single mother"] },
  "Nothing given": {},
};

const rows = Number(arg("rows", 8));
const rpc = (name, body) => fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
for (const [label, profile] of Object.entries(STUDENTS)) {
  if (arg("only", label) !== label) continue;
  const started = Date.now();
  const response = await rpc("match_scholarships", { profile, max_rows: 500, include_drafts: drafts });
  if (!response.ok) { console.log(`${label}: ${response.status} ${(await response.text()).slice(0, 300)}`); continue; }
  const found = await response.json();
  const tally = {};
  for (const row of found) tally[row.fit] = (tally[row.fit] || 0) + 1;
  console.log(`\n=== ${label}: ${found.length}${found.length === 500 ? "+" : ""} matches in ${Date.now() - started} ms  ${JSON.stringify(tally)}`);
  const show = (item) => `${item.kind}=${item.values.slice(0, 3).join("/")}`;
  for (const row of found.slice(0, rows)) console.log(`  [${row.fit} ${Number(row.score).toFixed(1)}] ${row.name} (${row.provider_name}; ${row.tier})\n      matched: ${row.matched.map(show).join("; ") || "-"}\n      to confirm: ${row.to_confirm.map(show).join("; ") || "-"}`);
  const asked = await rpc("match_questions", { profile, max_rows: 6, include_drafts: drafts });
  if (asked.ok) console.log(`  questions worth asking: ${(await asked.json()).map((item) => `${item.kind}: ${item.value} (${item.scholarships})`).join(" | ")}`);
}
