// Put every field of study the criteria name into one of a fixed list of groups.
// Scholarships word fields thousands of ways ("AC, heating and refrigeration", "pre-med",
// "informatics"); Claude Haiku assigns each distinct wording to a group once, and the answer
// is kept in data/taxonomy/field-groups.json so it is never asked twice.
// Reads data/records/criteria.jsonl. Needs ANTHROPIC_API_KEY (or LLM_API_KEY) in .env.
// Usage: node scripts/group-fields.mjs [--limit 500]
import Anthropic from "@anthropic-ai/sdk";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };

export const FIELD_GROUPS = {
  "agriculture": "farming, animal science, veterinary, forestry, horticulture, natural resources",
  "architecture-construction": "architecture, construction management, building trades, HVAC, plumbing, electrical work, welding",
  "arts-design": "visual art, graphic design, fashion, film, photography, creative writing",
  "aviation-transportation": "pilots, aviation maintenance, logistics, automotive, trucking, maritime",
  "business": "business, accounting, finance, marketing, management, economics, entrepreneurship, real estate, insurance",
  "communications": "journalism, media, broadcasting, public relations, advertising",
  "computing": "computer science, information technology, cybersecurity, data science, software, informatics",
  "education": "teaching, education, early childhood, library science, school counseling",
  "engineering": "any engineering, engineering technology, surveying",
  "environment": "environmental science, conservation, sustainability, marine science, geology, energy",
  "health": "medicine, dentistry, pharmacy, therapy, public health, allied health, health administration, pre-med",
  "nursing": "nursing of any level",
  "hospitality-culinary": "culinary, hospitality, tourism, cosmetology, event management",
  "humanities": "history, English, philosophy, languages, religion, theology, liberal arts",
  "law-public-service": "law, criminal justice, government, public administration, policy, fire and police, military science, social work",
  "life-sciences": "biology, biochemistry, neuroscience, genetics, kinesiology",
  "math-physical-sciences": "mathematics, statistics, physics, chemistry, astronomy",
  "performing-arts": "music, theater, dance",
  "social-sciences": "psychology, sociology, anthropology, political science, international relations",
  "sports-recreation": "sports management, athletic training, coaching, recreation",
  "stem-general": "STEM or science named in general, with no one subject",
  "trades-technical": "skilled trades and technical or vocational programs not covered above, manufacturing, machining",
  "any": "any field, undecided, or not a field of study at all",
};

const plain = (value) => String(value).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);

async function main() {
  const env = { ...process.env };
  for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) { const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (match && !env[match[1]]) env[match[1]] = match[2].trim(); }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || env.LLM_API_KEY, maxRetries: 4 });
  const path = join(root, "data", "taxonomy", "field-groups.json");
  const known = existsSync(path) ? JSON.parse(await readFile(path, "utf8")).map : {};

  // Every wording used in a field or career rule, latest reading of each scholarship.
  const latest = new Map();
  for await (const line of createInterface({ input: createReadStream(join(root, "data", "records", "criteria.jsonl")), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); latest.set(row.id, row); } catch { /* cut-off line */ }
  }
  const wanted = new Set();
  for (const row of latest.values()) for (const item of row.criteria || []) if (item.kind === "field" || item.kind === "career") for (const value of item.values) wanted.add(plain(value));
  let todo = [...wanted].filter((value) => value && !known[value]);
  const limit = Number(arg("limit", 0));
  if (limit) todo = todo.slice(0, limit);
  console.log(`${wanted.size} wordings, ${wanted.size - todo.length} already grouped, ${todo.length} to group`);

  const system = `You sort fields of study and careers into groups. For each numbered line, answer with the one group it belongs to.\nGroups:\n${Object.entries(FIELD_GROUPS).map(([group, covers]) => `- ${group}: ${covers}`).join("\n")}\nReply with JSON only: an object from the line's number to the group name, for example {"1": "nursing", "2": "business"}. Use only the group names above.`;
  let spent = 0, done = 0;
  const chunks = [];
  for (let start = 0; start < todo.length; start += 120) chunks.push(todo.slice(start, start + 120));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        const message = await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 6000, output_config: { effort: "low" }, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: chunk.map((value, index) => `${index + 1}. ${value}`).join("\n") }] });
        spent += ((message.usage.input_tokens || 0) * 0.1 + (message.usage.cache_read_input_tokens || 0) * 0.01 + (message.usage.cache_creation_input_tokens || 0) * 0.125 + (message.usage.output_tokens || 0) * 0.5) / 1e6;
        const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
        const answer = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        for (const [number, group] of Object.entries(answer)) { const value = chunk[Number(number) - 1]; if (value && Object.hasOwn(FIELD_GROUPS, group)) { known[value] = group; done += 1; } }
      } catch (error) { console.log(`a chunk failed: ${String(error.message).slice(0, 100)}`); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ note: "Each wording of a field of study or career, and the group it belongs to. Built by scripts/group-fields.mjs.", groups: FIELD_GROUPS, map: Object.fromEntries(Object.entries(known).sort()) }, null, 0)}\n`);
  // Counted with the reading spend.
  const spendPath = join(root, "data", "records", "spend.json");
  let total = 0;
  try { total = JSON.parse(await readFile(spendPath, "utf8")).dollars || 0; } catch { /* none yet */ }
  await writeFile(spendPath, `${JSON.stringify({ dollars: Math.round((total + spent) * 10000) / 10000, updated: new Date().toISOString(), note: "Model spending so far, estimated from token counts and list prices." })}\n`);
  console.log(`Grouped ${done} of ${todo.length}. Cost about $${spent.toFixed(2)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
