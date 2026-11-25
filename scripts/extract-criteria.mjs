// Read each scholarship's text with Claude and write the criteria it sets.
// Every criterion must quote the text; database/criteria.mjs drops any whose quote is not there.
//
// Reads data/records/texts.jsonl (one line per scholarship: id, name, provider, tier, text).
// Writes data/records/criteria.jsonl (one line per scholarship; a later line for the same id wins).
// A scholarship is read again only when its text has changed.
//
// Needs in .env (never committed): ANTHROPIC_API_KEY (or LLM_API_KEY). Optional: LLM_MODEL.
//
// Two ways to run:
//   direct   one request per scholarship, answers straight away (for trials)
//   --batch  requests are queued with the Message Batches API at half price and collected
//            when ready (usually within the hour); --collect picks up batches sent earlier
//
// Spending: every call's cost is added to data/records/spend.json and nothing is sent that
// would take the total past --budget (default $60 across all runs). Prices are dollars per
// million tokens, set for Claude Haiku 5.5.
//
// Usage: node scripts/extract-criteria.mjs [--limit 50] [--tier page|filing] [--scope open|school]
//        [--batch | --collect] [--wait] [--concurrency 8] [--show 5] [--retry-errors] [--budget 60]
//        [--model claude-haiku-5-5] [--effort low] [--out criteria.jsonl]
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkCriteria, PROMPT, question } from "../database/criteria.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const records = join(root, "data", "records");
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = (text) => createHash("sha256").update(text.join("\n")).digest("hex").slice(0, 12);

// Dollars per million tokens. A batch costs half.
const PRICE = { in: Number(arg("price-in", 0.1)), cacheRead: Number(arg("price-cache-read", 0.01)), cacheWrite: Number(arg("price-cache-write", 0.125)), out: Number(arg("price-out", 0.5)) };
const costOf = (usage, half) => ((usage.input_tokens || 0) * PRICE.in + (usage.cache_read_input_tokens || 0) * PRICE.cacheRead + (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (usage.output_tokens || 0) * PRICE.out) / 1e6 * (half ? 0.5 : 1);

async function settings() {
  const env = { ...process.env };
  try {
    for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch { /* no .env file */ }
  const key = env.ANTHROPIC_API_KEY || env.LLM_API_KEY;
  if (!key) { console.error("Missing key. Add ANTHROPIC_API_KEY=<key> to .env at the top of the repo."); process.exit(1); }
  return { client: new Anthropic({ apiKey: key, maxRetries: 4 }), model: arg("model", /^claude-/.test(env.LLM_MODEL || "") ? env.LLM_MODEL : "claude-haiku-5-5") };
}

async function* jsonLines(path) {
  if (!existsSync(path)) return;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) { try { yield JSON.parse(line); } catch { /* a cut-off line */ } }
}

// One request. The instructions are the same for every scholarship, so they are marked for caching.
const paramsFor = (model, item) => ({
  model, max_tokens: 4000,
  output_config: { effort: arg("effort", "low") },
  system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: question(item) }],
});

// The model's reply as JSON, whether or not it wrapped it in a code fence.
function answerFrom(message) {
  if (message.stop_reason === "refusal") throw new Error("the model declined to read this text");
  if (message.stop_reason === "max_tokens") throw new Error("the reply was cut off");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply was not JSON");
  return JSON.parse(text.slice(start, end + 1));
}

async function main() {
  const { client, model } = await settings();
  const outPath = join(records, arg("out", "criteria.jsonl"));
  const batchesPath = join(records, "batches.json");
  const spendPath = join(records, "spend.json");
  let spent = 0;
  try { spent = JSON.parse(await readFile(spendPath, "utf8")).dollars || 0; } catch { /* first run */ }
  const budget = Number(arg("budget", 60));
  const saveSpend = () => writeFile(spendPath, `${JSON.stringify({ dollars: Math.round(spent * 10000) / 10000, updated: new Date().toISOString(), note: "Model spending so far, estimated from token counts and list prices." })}\n`);

  const done = new Map();
  for await (const row of jsonLines(outPath)) done.set(row.id, row);
  const texts = new Map();
  const tier = arg("tier", null), scope = arg("scope", null);
  const scopes = new Map();
  if (scope) for await (const row of jsonLines(join(records, "scholarships.jsonl"))) scopes.set(row.id, row.scope);
  for await (const item of jsonLines(join(records, "texts.jsonl"))) texts.set(item.id, item);

  const out = createWriteStream(outPath, { flags: "a" });
  const counts = { read: 0, scholarships: 0, notScholarships: 0, criteria: 0, dropped: {}, errors: 0 };
  const tokens = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
  const show = Number(arg("show", 0));
  // Check one reply and write its line.
  const record = (item, message, error, half) => {
    const row = { id: item.id, text_hash: hashOf(item.text), model, at: new Date().toISOString() };
    try {
      if (error) throw error;
      spent += costOf(message.usage, half);
      tokens.in += message.usage.input_tokens || 0; tokens.cacheRead += message.usage.cache_read_input_tokens || 0; tokens.cacheWrite += message.usage.cache_creation_input_tokens || 0; tokens.out += message.usage.output_tokens || 0;
      const { record: clean, dropped } = checkCriteria(answerFrom(message), item.text);
      Object.assign(row, clean);
      for (const [reason, number] of Object.entries(dropped)) counts.dropped[reason] = (counts.dropped[reason] || 0) + number;
      if (clean.is_scholarship) { counts.scholarships += 1; counts.criteria += clean.criteria.length; } else counts.notScholarships += 1;
    } catch (problem) { row.error = String(problem.message || problem).split("\n")[0].slice(0, 160); counts.errors += 1; }
    out.write(`${JSON.stringify(row)}\n`);
    done.set(row.id, row);
    counts.read += 1;
    if (counts.read <= show) console.log(`\n== ${item.name} (${item.provider})\n${item.text.join("\n").slice(0, 1500)}\n-> ${JSON.stringify(row, null, 1)}`);
  };

  // Collect batches sent earlier (by this run or an earlier one).
  const collect = async (wait) => {
    let batches = [];
    try { batches = JSON.parse(await readFile(batchesPath, "utf8")); } catch { /* none sent */ }
    for (const entry of batches.filter((item) => !item.collected)) {
      let batch = await client.messages.batches.retrieve(entry.id);
      while (wait && batch.processing_status !== "ended") {
        console.log(`batch ${entry.id}: ${batch.request_counts.processing} still processing, ${batch.request_counts.succeeded} done`);
        await sleep(60000);
        batch = await client.messages.batches.retrieve(entry.id);
      }
      if (batch.processing_status !== "ended") { console.log(`batch ${entry.id} is not finished yet (${batch.request_counts.processing} processing)`); continue; }
      for await (const result of await client.messages.batches.results(entry.id)) {
        const item = texts.get(result.custom_id);
        if (!item) continue;
        if (result.result.type === "succeeded") record(item, result.result.message, null, true);
        else record(item, null, new Error(`batch request ${result.result.type}`), true);
      }
      entry.collected = new Date().toISOString();
      await writeFile(batchesPath, `${JSON.stringify(batches)}\n`);
      await saveSpend();
      console.log(`batch ${entry.id} collected. ${JSON.stringify(counts)}  spent so far $${spent.toFixed(2)}`);
    }
  };
  if (flag("collect")) { await collect(flag("wait")); await new Promise((resolve) => out.end(resolve)); return; }

  // What still needs reading.
  const retry = flag("retry-errors");
  const pending = new Set();
  try { for (const entry of JSON.parse(await readFile(batchesPath, "utf8"))) if (!entry.collected) entry.ids.forEach((id) => pending.add(id)); } catch { /* none sent */ }
  let items = [...texts.values()].filter((item) => {
    if (tier && item.tier !== tier) return false;
    if (scope && scopes.get(item.id) !== scope) return false;
    if (pending.has(item.id)) return false;
    const previous = done.get(item.id);
    return !(previous && previous.text_hash === hashOf(item.text) && !(retry && previous.error));
  });
  const limit = Number(arg("limit", 0));
  if (limit) { const step = Math.max(1, Math.floor(items.length / limit)); items = items.filter((_, index) => index % step === 0).slice(0, limit); }
  console.log(`${done.size} already read, ${items.length} to read with ${model}. Spent so far $${spent.toFixed(2)} of $${budget}.`);

  if (flag("batch")) {
    // What a request is expected to cost at half price: the instructions plus the text going
    // in, and about --expect-out tokens coming out (measured on a trial).
    const expectOut = Number(arg("expect-out", 600));
    const estimate = (item) => ((1700 + item.text.join("\n").length / 3.5) * PRICE.in + expectOut * PRICE.out) / 1e6 * 0.5;
    let batches = [];
    try { batches = JSON.parse(await readFile(batchesPath, "utf8")); } catch { /* none sent */ }
    let committed = spent + batches.filter((entry) => !entry.collected).reduce((sum, entry) => sum + (entry.estimate || 0), 0);
    for (let start = 0; start < items.length; start += 10000) {
      const slice = items.slice(start, start + 10000);
      const chunk = [];
      let cost = 0;
      for (const item of slice) { const next = estimate(item); if (committed + cost + next > budget) break; chunk.push(item); cost += next; }
      if (!chunk.length) { console.log("Stopped: the budget would be passed."); break; }
      const batch = await client.messages.batches.create({ requests: chunk.map((item) => ({ custom_id: item.id, params: paramsFor(model, item) })) });
      batches.push({ id: batch.id, sent: new Date().toISOString(), requests: chunk.length, estimate: Math.round(cost * 100) / 100, ids: chunk.map((item) => item.id) });
      committed += cost;
      await writeFile(batchesPath, `${JSON.stringify(batches)}\n`);
      console.log(`sent batch ${batch.id}: ${chunk.length} scholarships, about $${cost.toFixed(2)}`);
      if (chunk.length < slice.length) { console.log("Stopped: the budget would be passed."); break; }
    }
    if (flag("wait")) await collect(true);
  } else {
    let next = 0, stopped = false;
    const worker = async () => {
      while (next < items.length) {
        if (spent >= budget) { stopped = true; return; }
        const item = items[next++];
        try { record(item, await client.messages.create(paramsFor(model, item)), null, false); }
        catch (error) { record(item, null, error instanceof Anthropic.APIError ? new Error(`API error ${error.status}: ${error.message}`) : error, false); }
        if (counts.read % 200 === 0) { console.log(`${counts.read}/${items.length}  ${JSON.stringify(counts)}  spent $${spent.toFixed(2)} of $${budget}`); await saveSpend(); }
      }
    };
    await Promise.all(Array.from({ length: Number(arg("concurrency", 8)) }, worker));
    console.log(`${stopped ? "Stopped at the budget." : "Done."} ${JSON.stringify(counts)}  tokens ${JSON.stringify(tokens)}  Spent so far $${spent.toFixed(2)} of $${budget}.`);
  }
  await saveSpend();
  await new Promise((resolve) => out.end(resolve));
}

main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
