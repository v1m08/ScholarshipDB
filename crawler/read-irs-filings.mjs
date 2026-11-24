// Job 9: read the tax returns that foundations and charities file with the IRS.
// The IRS publishes every e-filed Form 990 and 990-PF as XML, in zip files of about 0.5 GB,
// free for anyone to download (https://www.irs.gov/charities-non-profits/form-990-series-downloads).
// For each zip: download, unpack, read every 990 and 990-PF, write the results, delete the zip.
//
// Writes under data/raw/irs-filings/ (one set of files per zip, so the job can resume):
//   <zip>.kept.jsonl.gz    full record of every filer that mentions scholarships
//   <zip>.light.jsonl.gz   one short line for every foundation, and every charity that pays grants
//   <zip>.xml.jsonl.gz     the original XML of each kept filer, so more can be read later
//   <zip>.summary.json     counts for that zip
//
// Usage: node read-irs-filings.mjs [--years 2023,2024,2025,2026] [--limit 2] [--zip <local file>]
//        [--keep-zip]
// Needs the `unzip` program (the zips use a compression Node cannot read itself).
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { readFiling } from "./lib/irs-filing.mjs";
import { repoRoot } from "./lib/store.mjs";

const USER_AGENT = "Mozilla/5.0 (compatible; scholarship-directory-bot/1.0)";
const LISTING = "https://www.irs.gov/charities-non-profits/form-990-series-downloads";
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, errors }));
});

// A gzip file written line by line, renamed into place only when complete.
function lineWriter(path) {
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(`${path}.part`));
  return {
    async write(row) { if (!gzip.write(`${JSON.stringify(row)}\n`)) await new Promise((resolve) => gzip.once("drain", resolve)); },
    async close() { gzip.end(); await done; await rename(`${path}.part`, path); },
  };
}

async function zipLinks(years) {
  const response = await fetch(LISTING, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`The IRS download page answered ${response.status}`);
  const links = [...new Set([...(await response.text()).matchAll(/href="(https:\/\/apps\.irs\.gov\/pub\/epostcard\/990\/xml\/(\d{4})\/[^"]+\.zip)"/g)].filter((match) => years.includes(match[2])).map((match) => match[1]))];
  return links.sort();
}

async function download(url, path) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
      const expected = Number(response.headers.get("content-length"));
      const got = (await stat(path)).size;
      if (expected && got !== expected) throw new Error(`got ${got} of ${expected} bytes`);
      return got;
    } catch (error) {
      if (attempt === 3) throw new Error(`download failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 15000 * attempt));
    }
  }
}

// XML files can sit in a folder inside the zip.
async function* xmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* xmlFiles(path);
    else if (entry.name.endsWith(".xml")) yield path;
  }
}

async function readZip(zipPath, name, outDir, workDir) {
  const unpacked = join(workDir, name);
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  // The IRS zips end with a few stray bytes, so unzip reports a problem after unpacking every file.
  const { code, errors } = await run("unzip", ["-q", "-o", zipPath, "-d", unpacked]);
  const counts = { zip: name, files: 0, form990: 0, form990PF: 0, otherForms: 0, unreadable: 0, kept: 0, kept990: 0, kept990PF: 0, acceptsApplications: 0, keptAcceptingApplications: 0, withRestrictions: 0, withDeadlines: 0, withWebsite: 0, grantsToPeopleRows: 0, unzipCode: code };
  const kept = lineWriter(join(outDir, `${name}.kept.jsonl.gz`));
  const light = lineWriter(join(outDir, `${name}.light.jsonl.gz`));
  const raw = lineWriter(join(outDir, `${name}.xml.jsonl.gz`));
  for await (const path of xmlFiles(unpacked)) {
    counts.files += 1;
    const xml = await readFile(path, "utf8");
    let result;
    try { result = readFiling(xml, basename(path).replace(/_public\.xml$/, "")); }
    catch { counts.unreadable += 1; continue; }
    if (!result) { counts.otherForms += 1; continue; }
    const { record } = result;
    const foundation = record.form === "990PF";
    counts[foundation ? "form990PF" : "form990"] += 1;
    const accepts = foundation && !record.application.preselectedOnly && record.application.entries.length > 0;
    if (accepts) counts.acceptsApplications += 1;
    if (foundation || record.money.grantsPaid > 0 || result.keep) await light.write(result.light);
    if (!result.keep) continue;
    counts.kept += 1; counts[foundation ? "kept990PF" : "kept990"] += 1;
    if (accepts) counts.keptAcceptingApplications += 1;
    if (foundation && record.application.entries.some((entry) => entry.restrictions)) counts.withRestrictions += 1;
    if (foundation && record.application.entries.some((entry) => entry.deadlines)) counts.withDeadlines += 1;
    if (record.website) counts.withWebsite += 1;
    if (!foundation) counts.grantsToPeopleRows += record.grantsToPeople.length;
    await kept.write(record);
    await raw.write({ key: record.key, ein: record.ein, xml });
  }
  await Promise.all([kept.close(), light.close(), raw.close()]);
  await rm(unpacked, { recursive: true, force: true });
  if (!counts.files) throw new Error(`unzip produced no files (exit ${code}): ${errors.slice(-300)}`);
  await writeFile(join(outDir, `${name}.summary.json`), `${JSON.stringify(counts, null, 1)}\n`);
  return counts;
}

async function main() {
  const outDir = join(repoRoot, "data", "raw", "irs-filings");
  const workDir = join(repoRoot, "data", "work", "irs");
  await mkdir(outDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  if ((await run("unzip", ["-v"]).catch(() => ({ code: 1 }))).code !== 0) { console.error("The unzip program is missing. On the server: sudo apt-get install -y unzip"); process.exit(1); }

  const local = arg("zip", null);
  if (local) { console.log(JSON.stringify(await readZip(local, basename(local, ".zip"), outDir, workDir))); return; }

  let links = await zipLinks(arg("years", "2023,2024,2025,2026").split(","));
  const limit = Number(arg("limit", 0));
  if (limit) links = links.slice(0, limit);
  const have = new Set((await readdir(outDir)).filter((file) => file.endsWith(".summary.json")).map((file) => file.replace(".summary.json", "")));
  const todo = links.filter((link) => !have.has(basename(link, ".zip")));
  console.log(`${links.length} zip files listed, ${links.length - todo.length} already done, ${todo.length} to read`);
  const totals = { zips: 0, files: 0, form990: 0, form990PF: 0, kept: 0, failed: 0 };
  for (const link of todo) {
    const name = basename(link, ".zip");
    const zipPath = join(workDir, `${name}.zip`);
    const started = Date.now();
    try {
      const bytes = await download(link, zipPath);
      const counts = await readZip(zipPath, name, outDir, workDir);
      totals.zips += 1;
      for (const field of ["files", "form990", "form990PF", "kept"]) totals[field] += counts[field];
      console.log(`${totals.zips + totals.failed}/${todo.length} ${name} ${(bytes / 1e6).toFixed(0)} MB in ${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(totals)}`);
    } catch (error) {
      // One bad zip must not stop the rest; it has no summary file, so the next run tries it again.
      totals.failed += 1;
      console.log(`${totals.zips + totals.failed}/${todo.length} ${name} FAILED: ${error.message}`);
    }
    if (!flag("keep-zip")) await rm(zipPath, { force: true });
    await rm(join(workDir, name), { recursive: true, force: true });
  }
  console.log(`Done. ${JSON.stringify(totals)}`);
  if (totals.failed) process.exitCode = 1;
}

main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
