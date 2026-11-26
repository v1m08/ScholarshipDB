// Load the clean rows in data/records/ into the database (Supabase).
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY in a .env file at the top of the repo
// (never committed). Loading the same row again updates it and replaces its evidence lines.
// A load never deletes a scholarship and never changes draft / published status
// (--archive-missing archives; --drop-hidden, run on its own, is the only thing that deletes).
// Only rows a model has read are sent, since unread rows would be hidden drafts taking space.
//
// Usage:
//   node scripts/load-database.mjs --check                 can we reach the database, are the tables there
//   node scripts/load-database.mjs --pick 100 --batch batch-100
//        load 100 well-filled open scholarships (one per school) as drafts, labelled batch-100;
//        rows already in the database are never picked again
//   node scripts/load-database.mjs --all                   load every clean row (as drafts if new)
//   add --evidence to also load the keyword reader's evidence lines (off by default)
//   node scripts/load-database.mjs --all --archive-missing
//        also mark as archived any row in the database that the current build no longer contains
//   node scripts/load-database.mjs --drop-hidden
//        delete archived rows and unread drafts from the database (they stay in the build files)
//   add --drafts to also send rows no model has read
//   add --dry-run to see what would be sent without sending anything
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const readRows = async (file) => (await readFile(join(root, "data", "records", file), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

async function settings() {
  const env = { ...process.env };
  try {
    for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch { /* no .env file: rely on the environment */ }
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SECRET_KEY || "";
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key) {
    console.error("Missing settings. Put these two lines in a file named .env at the top of the repo:\n  SUPABASE_URL=https://<your-project>.supabase.co\n  SUPABASE_SECRET_KEY=<the secret key from Project Settings -> API Keys>");
    process.exit(1);
  }
  return { url, key };
}

// Choose the review batch: open, with an amount and several stated facts, one per school,
// spread evenly instead of the first schools in the alphabet.
export function pickBatch(rows, count, today = new Date().toISOString().slice(0, 10)) {
  const good = rows.filter((row) => row.deadline && row.deadline >= today && row.award_max && row.stated_fields.length >= 4 && row.name.split(" ").length >= 2);
  const perSchool = new Map();
  for (const row of good) if (!perSchool.has(row.school_unitid) || row.id < perSchool.get(row.school_unitid).id) perSchool.set(row.school_unitid, row);
  const chosen = [...perSchool.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, count);
  // Fewer schools than asked for: fill up with more rows from the same pool.
  if (chosen.length < count) {
    const have = new Set(chosen.map((row) => row.id));
    for (const row of good.sort((a, b) => a.id.localeCompare(b.id))) { if (chosen.length >= count) break; if (!have.has(row.id)) chosen.push(row); }
  }
  return chosen;
}

async function main() {
  const { url, key } = await settings();
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const call = async (path, options = {}) => {
    const response = await fetch(`${url}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 400)}`);
    return response;
  };
  // Counting right after a large load can time out on the database's side, so it is tried a few times.
  const count = async (table, filter = "") => {
    for (let attempt = 1; ; attempt += 1) {
      try { return Number((await call(`${table}?select=*${filter}`, { method: "HEAD", headers: { prefer: "count=exact" } })).headers.get("content-range").split("/")[1]); }
      catch (error) { if (!/^5/.test(error.message) || attempt === 4) throw error; await new Promise((resolve) => setTimeout(resolve, 15000 * attempt)); }
    }
  };

  // The tables must exist before anything is sent.
  // (One row is asked for, not a count: counting the whole table can time out when the database is busy.)
  try { await call("scholarships?select=id&limit=1"); }
  catch (error) {
    console.error(/401|403/.test(error.message) ? "The database refused the key. Check SUPABASE_SECRET_KEY in .env (it must be the secret key, not the publishable one)." : `The tables are not there yet. Open the Supabase SQL Editor, paste database/schema.sql and press Run.\n(${error.message.slice(0, 160)})`);
    process.exit(1);
  }
  // A count can fail while the database is busy; that must not make a finished load look failed.
  const report = async () => { try { await say(); } catch { console.log("(The database was too busy to count its rows; the load itself finished.)"); } };
  const say = async () => console.log(`In the database now: ${await count("schools")} schools, ${await count("scholarships")} scholarships (${await count("scholarships", "&status=eq.published")} published, ${await count("scholarships", "&status=eq.draft")} drafts, ${await count("scholarships", "&status=eq.archived")} archived), ${await count("scholarship_evidence")} evidence lines`);
  if (flag("check")) { console.log("Connected, and the tables are there."); await report(); return; }
  // Publish the drafts whose criteria a model has read (and that it judged to be scholarships;
  // the others never reach the build). Done in slices so no single request is too large.
  // Publishing makes rows visible to everyone: run it only when the owner has decided to.
  if (flag("publish-read")) {
    for (let slice = 0; slice < 256; slice += 1) {
      const prefix = slice.toString(16).padStart(2, "0");
      // A range on the id (its index), not a pattern, so each slice is found without reading the table.
      const range = `id=gte.${prefix}${slice < 255 ? `&id=lt.${(slice + 1).toString(16).padStart(2, "0")}` : ""}`;
      for (let attempt = 1; ; attempt += 1) {
        try { await call(`scholarships?criteria_read=is.true&status=eq.draft&${range}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "published" }) }); break; }
        catch (error) { if (attempt === 5) throw error; await new Promise((resolve) => setTimeout(resolve, 8000 * attempt)); }
      }
      process.stdout.write(`\rpublishing: ${slice + 1}/256`);
    }
    process.stdout.write("\n");
    await report();
    return;
  }

  // Remove from the database the rows no visitor can see: archived ones and drafts no model has
  // read. They stay in the build files, and a draft is loaded again once it has been read.
  // This is what keeps a free database under its size limit. Done in slices by id.
  if (flag("drop-hidden")) {
    for (let slice = 0; slice < 256; slice += 1) {
      const prefix = slice.toString(16).padStart(2, "0");
      const range = `id=gte.${prefix}${slice < 255 ? `&id=lt.${(slice + 1).toString(16).padStart(2, "0")}` : ""}`;
      for (let attempt = 1; ; attempt += 1) {
        try { await call(`scholarships?or=(status.eq.archived,and(status.eq.draft,criteria_read.is.false))&${range}`, { method: "DELETE", headers: { prefer: "return=minimal" } }); break; }
        catch (error) { if (attempt === 8) throw error; await new Promise((resolve) => setTimeout(resolve, 10000 * attempt)); }
      }
      process.stdout.write(`\rremoving hidden rows: ${slice + 1}/256`);
    }
    process.stdout.write("\n");
    return;
  }

  let scholarships = await readRows("scholarships.jsonl");
  // Rows no model has read are not sent (they would only be hidden drafts); --drafts sends them too.
  if (!flag("drafts")) scholarships = scholarships.filter((row) => row.criteria_read);
  const batch = arg("batch", null);
  if (arg("pick", null)) {
    // A new batch never takes rows that are already in the database, so each batch keeps its own label.
    const loaded = new Set();
    for (let from = 0; ; from += 1000) {
      const page = await (await call(`scholarships?select=id&order=id&offset=${from}&limit=1000`)).json();
      page.forEach((row) => loaded.add(row.id));
      if (page.length < 1000) break;
    }
    scholarships = pickBatch(scholarships.filter((row) => !loaded.has(row.id)), Number(arg("pick")));
  }
  else if (!flag("all")) { console.error("Say what to load: --pick 100 --batch batch-100, or --all"); process.exit(1); }
  if (batch) scholarships = scholarships.map((row) => ({ ...row, review_batch: batch }));
  const ids = new Set(scholarships.map((row) => row.id));
  const unitids = new Set(scholarships.map((row) => row.school_unitid));
  const schools = (await readRows("schools.jsonl")).filter((row) => flag("all") || unitids.has(row.unitid));
  // Evidence lines are loaded only when asked for: each criterion already carries its own quote,
  // and the lines take a quarter of a free database.
  const evidence = flag("evidence") ? (await readRows("evidence.jsonl")).filter((row) => ids.has(row.scholarship_id)) : [];
  console.log(`To load: ${schools.length} schools, ${scholarships.length} scholarships${batch ? ` (labelled ${batch})` : ""}, ${evidence.length} evidence lines`);
  if (flag("dry-run")) { console.log("Dry run: nothing sent. First row:\n", JSON.stringify(scholarships[0], null, 1)); return; }

  // What has already been sent, as a fingerprint per row (data/records/loaded.json): a row that
  // has not changed since is not sent again, so a refresh only writes what is new, and a load
  // that stopped part way carries on where it left off. --resend ignores the record.
  const ledgerPath = join(root, "data", "records", "loaded.json");
  let ledger = {};
  if (!flag("resend")) { try { ledger = JSON.parse(await readFile(ledgerPath, "utf8")); } catch { /* nothing sent yet */ } }
  const fingerprint = (row) => createHash("sha1").update(JSON.stringify(row)).digest("base64").slice(0, 12);
  const saveLedger = () => writeFile(ledgerPath, JSON.stringify(ledger));

  // Schools first (scholarships point at them), evidence last (it points at scholarships).
  const send = async (table, conflict, all, size = 500, from = 0) => {
    const keyOf = (row) => `${table}:${conflict.split(",").map((column) => row[column]).join("|")}`;
    const rows = all.slice(from).filter((row) => ledger[keyOf(row)] !== fingerprint(row));
    if (rows.length < all.length - from) console.log(`${table}: ${all.length - from - rows.length} unchanged since the last load, ${rows.length} to send`);
    from = 0;
    for (let start = from; start < rows.length; start += size) {
      const chunk = rows.slice(start, start + size);
      for (let attempt = 1; ; attempt += 1) {
        try { await call(`${table}?on_conflict=${conflict}`, { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) }); break; }
        catch (error) {
          // A rule in the schema refused a row: stop, so a bad row is fixed rather than skipped.
          if (/^4/.test(error.message) || attempt === 6) throw new Error(`${table} rows ${start}-${start + chunk.length}: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 10000 * attempt));
        }
      }
      for (const row of chunk) ledger[keyOf(row)] = fingerprint(row);
      if ((start / size) % 20 === 19) await saveLedger();
      if (rows.length > size) process.stdout.write(`\r${table}: ${Math.min(start + size, rows.length)}/${rows.length}`);
    }
    await saveLedger();
    if (rows.length > size) process.stdout.write("\n");
  };
  await send("schools", "unitid", schools);
  // Funders before scholarships, which point at them.
  if (flag("all")) {
    let funders = [];
    try { funders = await readRows("funders.rows.jsonl"); } catch { /* not built */ }
    if (funders.length) await send("funders", "ein", funders, 1000);
  }
  // A slow database times out on large chunks; --from resumes a load that stopped part way.
  await send("scholarships", "id", scholarships, Number(arg("chunk", 250)), Number(arg("from", 0)));
  // Evidence is replaced, not added to: a fact that is no longer stated must not keep its old line.
  const idList = flag("evidence") ? [...ids] : [];
  for (let start = 0; start < idList.length; start += 150) {
    await call(`scholarship_evidence?scholarship_id=in.(${idList.slice(start, start + 150).join(",")})`, { method: "DELETE", headers: { prefer: "return=minimal" } });
    if (idList.length > 150) process.stdout.write(`\rclearing old evidence: ${Math.min(start + 150, idList.length)}/${idList.length}`);
  }
  if (idList.length > 150) process.stdout.write("\n");
  await send("scholarship_evidence", "scholarship_id,field", evidence, 1000);
  if (flag("archive-missing") && flag("all")) {
    const missing = [];
    // Paged by id, not by position: skipping to row 100,000 makes a slow database time out.
    for (let after = ""; ;) {
      const page = await (await call(`scholarships?select=id&status=neq.archived&order=id&id=gt.${after}&limit=1000`)).json();
      for (const row of page) if (!ids.has(row.id)) missing.push(row.id);
      if (page.length < 1000) break;
      after = page[page.length - 1].id;
    }
    for (let start = 0; start < missing.length; start += 150) await call(`scholarships?id=in.(${missing.slice(start, start + 150).join(",")})`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: "archived" }) });
    console.log(`Archived ${missing.length} rows the current build no longer contains. (--drop-hidden removes archived rows for good.)`);
  }
  console.log("Loaded.");
  await report();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exit(1); });
