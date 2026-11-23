// Raw page store. Every job writes under data/raw/<job>/ (git-ignored): one HTML file per
// page named by content hash, plus results.jsonl with one line per finished item. A job
// is resumable because finished item keys are read back from results.jsonl on start.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function openJob(job) {
  const dir = join(repoRoot, "data", "raw", job);
  const resultsPath = join(dir, "results.jsonl");
  await mkdir(join(dir, "pages"), { recursive: true });
  const done = new Map();
  try {
    for (const line of (await readFile(resultsPath, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      done.set(row.key, row);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    dir,
    done,
    async savePage(html) {
      const sha = createHash("sha256").update(html).digest("hex").slice(0, 32);
      await writeFile(join(dir, "pages", `${sha}.html`), html);
      return sha;
    },
    async record(row) {
      done.set(row.key, row);
      await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
    },
  };
}
