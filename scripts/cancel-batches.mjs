// Cancel the batches sent by scripts/extract-criteria.mjs that have not been collected yet,
// and wait until Anthropic reports them ended. Requests that had already finished are kept;
// run `node scripts/extract-criteria.mjs --collect` afterwards to take them in, then
// `--retry-errors` to read the cancelled ones directly.
// Usage: node scripts/cancel-batches.mjs
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) { const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/); if (match && !env[match[1]]) env[match[1]] = match[2].trim(); }
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || env.LLM_API_KEY });

const batches = JSON.parse(await readFile(join(root, "data", "records", "batches.json"), "utf8")).filter((entry) => !entry.collected);
for (const entry of batches) {
  const batch = await client.messages.batches.retrieve(entry.id);
  if (batch.processing_status === "in_progress") { await client.messages.batches.cancel(entry.id); console.log(`${entry.id}: cancel requested (${entry.requests} requests)`); }
  else console.log(`${entry.id}: ${batch.processing_status}`);
}
for (const entry of batches) {
  for (;;) {
    const batch = await client.messages.batches.retrieve(entry.id);
    if (batch.processing_status === "ended") { console.log(`${entry.id}: ended ${JSON.stringify(batch.request_counts)}`); break; }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}
