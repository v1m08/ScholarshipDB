// Look over the built rows for things a student should never see: odd names, repeats,
// rows with nothing to go on. Prints counts and examples; changes nothing.
// Usage: node --max-old-space-size=6000 scripts/check-records.mjs [--examples 8]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const examples = Number(arg("examples", 8));
const rows = readFileSync(join(root, "data", "records", "scholarships.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const today = new Date().toISOString().slice(0, 10);

const checks = {
  "name is all capitals": (row) => row.name.length > 8 && row.name === row.name.toUpperCase(),
  "name has no vowel-bearing word of 4+ letters": (row) => !/[a-z]{4,}/i.test(row.name),
  "name looks cut off or coded (digits run, c/o, trailing initials)": (row) => /\d{4,}|\bc\/o\b|\b(t u a|tua|u a|uw|u w|irr tr|pfdn|tw)\b/i.test(row.name),
  "name over 90 characters": (row) => row.name.length > 90,
  "name is a sentence (ends with a period or has 14+ words)": (row) => /\.$/.test(row.name) || row.name.split(/\s+/).length >= 14,
  "name repeats the provider and adds nothing": (row) => row.name.toLowerCase().replace(/ scholarship$/, "") === row.provider_name.toLowerCase() && row.source !== "irs-filing",
  "provider is a web address or very short": (row) => /^https?:|\.(com|org|edu)$/i.test(row.provider_name) || row.provider_name.length < 4,
  "read by the model but no summary": (row) => row.criteria_read && !row.summary,
  "read by the model, no criteria, no amount, no deadline": (row) => row.criteria_read && !row.criteria.length && !row.award_max && !row.deadline,
  "not read by the model": (row) => !row.criteria_read,
  "no address to apply at": (row) => !row.url && !row.apply_url && !row.contact,
  "award over $50,000": (row) => row.award_max > 50000,
  "award under $50": (row) => row.award_max && row.award_max < 50,
  "deadline more than 18 months away": (row) => row.deadline && row.deadline > `${Number(today.slice(0, 4)) + 2}-06-01`,
  "open scope but a college is required (may be school-only)": (row) => row.scope === "open" && row.criteria.some((item) => item.kind === "college" && item.strength === "required" && item.values.length === 1),
};
console.log(`${rows.length} rows`);
for (const [label, test] of Object.entries(checks)) {
  const hits = rows.filter(test);
  const bySource = {};
  for (const row of hits) bySource[row.source] = (bySource[row.source] || 0) + 1;
  console.log(`\n${hits.length}  ${label}  ${JSON.stringify(bySource)}`);
  const step = Math.max(1, Math.floor(hits.length / examples));
  for (const row of hits.filter((_, index) => index % step === 0).slice(0, examples)) console.log(`     ${row.name}  |  ${row.provider_name}  |  ${row.source}${row.award_max ? `  |  $${row.award_max}` : ""}${row.deadline ? `  |  ${row.deadline}` : ""}`);
}

// The same scholarship twice: same provider and same name in plain words.
const plain = (text) => text.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(the|scholarship|scholarships|fund|award|memorial|endowed|endowment|annual)\b/g, " ").replace(/\s+/g, " ").trim();
const seen = new Map();
for (const row of rows) { const key = `${row.scope === "school" ? row.school_unitid : plain(row.provider_name)}|${plain(row.name)}`; seen.set(key, [...(seen.get(key) || []), row]); }
const repeats = [...seen.values()].filter((list) => list.length > 1);
console.log(`\n${repeats.reduce((sum, list) => sum + list.length - 1, 0)}  likely repeats (same owner, same name apart from filler words), in ${repeats.length} groups`);
for (const list of repeats.filter((_, index) => index % Math.max(1, Math.floor(repeats.length / examples)) === 0).slice(0, examples)) console.log(`     ${list.map((row) => `${row.name} [${row.source}]`).join("  ==  ")}`);
