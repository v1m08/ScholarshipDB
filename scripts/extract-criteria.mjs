// Read each scholarship's text with a model and write the criteria it sets.
// Every criterion must quote the text; database/criteria.mjs drops any whose quote is not there.
//
// Reads data/records/texts.jsonl (one line per scholarship: id, name, provider, tier, text).
// Writes data/records/criteria.jsonl (one line per scholarship; a later line for the same id wins).
// A scholarship is read again only when its text has changed.
//
// Needs in .env (never committed):
//   LLM_BASE_URL   an OpenAI-style address, e.g. https://api.openai.com/v1
//   LLM_MODEL      the model's name
//   LLM_API_KEY
// Usage: node scripts/extract-criteria.mjs [--limit 50] [--tier page|filing] [--concurrency 16] [--show 5] [--retry-errors]
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkCriteria, PROMPT, question } from "../database/criteria.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = (text) => createHash("sha256").update(text.join("\n")).digest("hex").slice(0, 12);

async function settings() {
  const env = { ...process.env };
  try {
    for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch { /* no .env file */ }
  const base = (env.LLM_BASE_URL || "").replace(/\/$/, "");
  if (!base || !env.LLM_MODEL || !env.LLM_API_KEY) {
    console.error("Missing model settings. Add to .env at the top of the repo:\n  LLM_BASE_URL=https://api.openai.com/v1\n  LLM_MODEL=<model name>\n  LLM_API_KEY=<key>");
    process.exit(1);
  }
  return { base, model: env.LLM_MODEL, key: env.LLM_API_KEY };
}

async function* jsonLines(path) {
  if (!existsSync(path)) return;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) { try { yield JSON.parse(line); } catch { /* a cut-off line */ } }
}

async function ask({ base, model, key }, item, usage) {
  const body = { model, response_format: { type: "json_object" }, messages: [{ role: "system", content: PROMPT }, { role: "user", content: question(item) }] };
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try { response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) }); }
    catch (error) { if (attempt >= 4) throw error; await sleep(2000 * 2 ** attempt); continue; }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 6) throw new Error(`model refused (HTTP ${response.status})`);
      await sleep(Math.min(60000, 2000 * 2 ** attempt + Math.random() * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const data = await response.json();
    usage.in += data.usage?.prompt_tokens || 0;
    usage.out += data.usage?.completion_tokens || 0;
    return JSON.parse(data.choices[0].message.content);
  }
}

async function main() {
  const model = await settings();
  const outPath = join(root, "data", "records", "criteria.jsonl");
  const done = new Map();
  for await (const row of jsonLines(outPath)) done.set(row.id, row);
  const tier = arg("tier", null);
  const retry = process.argv.includes("--retry-errors");
  let items = [];
  for await (const item of jsonLines(join(root, "data", "records", "texts.jsonl"))) {
    if (tier && item.tier !== tier) continue;
    const previous = done.get(item.id);
    if (previous && previous.text_hash === hashOf(item.text) && !(retry && previous.error)) continue;
    items.push(item);
  }
  const limit = Number(arg("limit", 0));
  if (limit) { const step = Math.max(1, Math.floor(items.length / limit)); items = items.filter((_, index) => index % step === 0).slice(0, limit); }
  console.log(`${done.size} already read, ${items.length} to read with ${model.model}`);

  const out = createWriteStream(outPath, { flags: "a" });
  const usage = { in: 0, out: 0 };
  const counts = { read: 0, scholarships: 0, notScholarships: 0, criteria: 0, dropped: {}, errors: 0 };
  const show = Number(arg("show", 0));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      const row = { id: item.id, text_hash: hashOf(item.text), model: model.model, at: new Date().toISOString() };
      try {
        const { record, dropped } = checkCriteria(await ask(model, item, usage), item.text);
        Object.assign(row, record);
        for (const [reason, number] of Object.entries(dropped)) counts.dropped[reason] = (counts.dropped[reason] || 0) + number;
        if (record.is_scholarship) { counts.scholarships += 1; counts.criteria += record.criteria.length; } else counts.notScholarships += 1;
      } catch (error) { row.error = error.message.split("\n")[0].slice(0, 160); counts.errors += 1; }
      out.write(`${JSON.stringify(row)}\n`);
      counts.read += 1;
      if (counts.read <= show) console.log(`\n== ${item.name} (${item.provider})\n${item.text.join("\n").slice(0, 1500)}\n-> ${JSON.stringify(row, null, 1)}`);
      if (counts.read % 200 === 0) console.log(`${counts.read}/${items.length}  ${JSON.stringify(counts)}  tokens in ${usage.in} out ${usage.out}`);
    }
  };
  await Promise.all(Array.from({ length: Number(arg("concurrency", 16)) }, worker));
  await new Promise((resolve) => out.end(resolve));
  console.log(`Done. ${JSON.stringify(counts)}  tokens in ${usage.in} out ${usage.out}`);
}

main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
