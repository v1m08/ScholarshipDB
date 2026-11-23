// Score the keyword pipeline against the hand-checked gold set. For each gold record it
// runs the site, picks the scholarship whose name matches best, and compares field by field.
// Fields the gold set marked as assumed or unverified are not scored.
//   node eval-gold.mjs [--only jkcf] [--save]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { closeBrowser } from "./lib/fetcher.mjs";
import { analyzeSite } from "./lib/pipeline.mjs";
import { repoRoot } from "./lib/store.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const gold = JSON.parse(await readFile(join(repoRoot, "data", "gold", "gold-set.json"), "utf8"));
const words = (text) => new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 3 && !["scholarship", "scholarships", "program", "foundation", "scholars", "national"].includes(word)));
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const TOOL_CITIZENSHIP = ["us-citizen", "permanent-resident", "daca-undocumented", "any"];

// Gold value for each tool field, or undefined when the gold set has nothing to compare.
function expected(record) {
  const skip = new Set([...(record.assumed || []), ...(record.unverified || [])]);
  const later = record.application.laterPhases || [];
  const out = {};
  const put = (field, path, value) => { if (!skip.has(path) && value !== null && value !== undefined) out[field] = value; };
  put("opens", "cycle.opens", record.cycle.opens);
  put("deadline", "cycle.deadline", record.cycle.deadline);
  put("awardMaximum", "award.maximum", record.award.maximum);
  put("minimumGpa", "eligibility.minimumGpa", record.eligibility.minimumGpa);
  if (typeof record.eligibility.incomeCeiling === "number") put("incomeCeiling", "eligibility.incomeCeiling", record.eligibility.incomeCeiling);
  if (record.eligibility.citizenship) put("citizenship", "eligibility.citizenship", record.eligibility.citizenship.filter((status) => TOOL_CITIZENSHIP.includes(status)));
  put("gradeLevels", "eligibility.gradeLevels", record.eligibility.gradeLevels);
  put("need", "selection.need", record.selection.need);
  put("renewable", "award.renewable", record.award.renewable);
  put("fee", "application.fee", record.application.fee);
  // The tool describes the first round only, so a component that is only asked later is "false".
  for (const field of ["essay", "recommendations", "interview", "nomination"]) put(field, `application.${field}`, record.application[field] && !later.includes(field));
  return out;
}

function toolValue(field, metadata) {
  const entry = metadata[field];
  if (!entry) return undefined;
  if (field === "gradeLevels") return entry.value.flatMap((grade) => (grade === "college-sophomore-or-junior" ? ["college-sophomore", "college-junior"] : [grade]));
  return entry.value;
}

const equal = (field, goldValue, value) => (Array.isArray(goldValue) ? same(new Set(goldValue), new Set(value || [])) : goldValue === value);

const rows = [];
const perField = {};
for (const record of gold.records) {
  if (only && !record.id.includes(only)) continue;
  const start = (record.labeledFrom || []).find((url) => /^https?:\/\/\S+$/.test(url)) || record.homepage;
  const result = await analyzeSite(start, { maxPrograms: 6, pagesPerProgram: 6 });
  const titleWords = words(record.title);
  const pick = result.scholarships
    .map((scholarship) => ({ scholarship, overlap: [...words(`${scholarship.name} ${scholarship.key}`)].filter((word) => titleWords.has(word)).length }))
    .sort((a, b) => b.overlap - a.overlap)[0]?.scholarship;
  const row = { id: record.id.replace("gold-", ""), start, status: result.blocked ? "blocked" : result.error ? `failed: ${result.error}` : !pick ? "no pages found" : "ok", picked: pick?.name, pages: pick?.pages.length || 0, digestTokens: pick?.sizes.digestTokens || 0, fields: {} };
  const want = expected(record);
  for (const [field, goldValue] of Object.entries(want)) {
    const value = pick ? toolValue(field, pick.metadata) : undefined;
    const outcome = !pick ? "unreached" : value === undefined ? "missing" : equal(field, goldValue, value) ? "correct" : "wrong";
    row.fields[field] = { outcome, gold: goldValue, tool: value, evidence: pick?.metadata[field]?.evidence?.slice(0, 140) || null, assumed: pick?.metadata[field]?.assumed || false };
    (perField[field] ||= { correct: 0, wrong: 0, missing: 0, unreached: 0 })[outcome] += 1;
  }
  rows.push(row);
  const tally = Object.values(row.fields).reduce((sum, entry) => ({ ...sum, [entry.outcome]: (sum[entry.outcome] || 0) + 1 }), {});
  console.log(`${row.id.padEnd(26)} ${row.status.padEnd(16)} pages=${row.pages} correct=${tally.correct || 0} wrong=${tally.wrong || 0} missing=${tally.missing || 0}  ${row.picked ? `[${row.picked.slice(0, 40)}]` : ""}`);
}
await closeBrowser();

console.log("\nBy field (reached sites only):");
console.table(Object.fromEntries(Object.entries(perField).map(([field, tally]) => [field, { correct: tally.correct, wrong: tally.wrong, missing: tally.missing, accuracy: tally.correct + tally.wrong + tally.missing ? `${Math.round((100 * tally.correct) / (tally.correct + tally.wrong + tally.missing))}%` : "-" }])));
const reached = rows.filter((row) => row.status === "ok");
const all = reached.flatMap((row) => Object.values(row.fields));
console.log(`Sites reached: ${reached.length}/${rows.length}. Fields scored: ${all.length}. Correct: ${all.filter((entry) => entry.outcome === "correct").length} (${Math.round((100 * all.filter((entry) => entry.outcome === "correct").length) / (all.length || 1))}%).`);

console.log("\nWrong values:");
for (const row of reached) for (const [field, entry] of Object.entries(row.fields)) {
  if (entry.outcome === "wrong") console.log(`  ${row.id} ${field}: gold=${JSON.stringify(entry.gold)} tool=${JSON.stringify(entry.tool)}${entry.assumed ? " (assumed)" : ""}  "${(entry.evidence || "").slice(0, 100)}"`);
}
await mkdir(join(repoRoot, "data", "raw", "eval"), { recursive: true });
await writeFile(join(repoRoot, "data", "raw", "eval", "gold-comparison.json"), JSON.stringify({ ranAt: new Date().toISOString(), rows, perField }, null, 2));
