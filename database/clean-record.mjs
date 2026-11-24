// Turn what a crawl job wrote into one database row that passes every rule in schema.sql.
// Our raw results can be messy; nothing reaches the database without going through here.
// A value that fails its rule is left out (null / empty), never guessed. A record that
// cannot make a trustworthy row at all is rejected with a reason.
import { createHash } from "node:crypto";
import { decodeEntities } from "../crawler/lib/clean.mjs";

export const GRADES = ["grade-9", "grade-10", "grade-11", "grade-12", "college-freshman", "college-sophomore", "college-junior", "college-senior", "community-college", "graduate"];
export const CITIZENSHIP = ["us-citizen", "permanent-resident", "daca-undocumented"];
export const TAGS = ["adversity", "athletics", "community-service", "first-generation", "leadership", "military-connected", "research", "stem", "study-abroad", "women", "work-experience"];
const LEVELS = ["no", "considered", "required"];
const ENROLLMENT = ["either", "full-time", "part-time"];
const AWARD_TYPES = ["full-cost", "last-dollar"];
const AWARD_LIMIT = 70000;

export const idFor = (url) => createHash("sha256").update(url.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase()).digest("hex").slice(0, 16);
export const nameKey = (name) => name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

// Portal entries that are forms or placeholders, not a scholarship a student can win.
const NOT_A_SCHOLARSHIP = /\b(general application|common application|conditional application|test (scholarship|opportunity|award)|do not (use|apply)|not (currently )?(available|accepting)|placeholder|template|thank you (letter|note)|post[- ]acceptance|acceptance form|donor (thank|letter)|renewal (form|application)|appeal form|survey|questionnaire|profile update|interest form)\b|^(test|copy of|draft|zz|xx|\(archived\)|archived?)\b/i;

export function cleanName(raw) {
  let name = decodeEntities(String(raw || "")).replace(/\s+/g, " ").trim();
  // "SMITH FAMILY SCHOLARSHIP" reads as shouting; names typed in capitals are put in title case.
  if (name.length > 8 && name === name.toUpperCase() && /[A-Z]{4}/.test(name)) name = name.toLowerCase().replace(/(^|[\s\-/(.])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase()).replace(/\b(Of|And|The|For|In|At|To)\b/g, (word, offset) => (offset ? word.toLowerCase() : word));
  return name.replace(/^["'*\s]+|["'*\s]+$/g, "");
}

const dateOrNull = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "2020-01-01" && value <= "2035-12-31" && !Number.isNaN(Date.parse(value)) ? value : null);
const moneyOrNull = (value) => (typeof value === "number" && value > 0 && value <= AWARD_LIMIT ? Math.round(value * 100) / 100 : null);
const stated = (entry) => Boolean(entry) && !entry.assumed && entry.value !== null && entry.value !== undefined;
const pick = (list, allowed) => allowed.filter((item) => (list || []).includes(item));

// The metadata name of each fact and the database column it fills.
const COLUMNS = { awardMinimum: "award_min", awardMaximum: "award_max", awardPerYear: "award_per_year", awardType: "award_type", opens: "opens", deadline: "deadline", minimumGpa: "minimum_gpa", gradeLevels: "grade_levels", fieldsOfStudy: "fields_of_study", citizenship: "citizenship", need: "need", merit: "merit", enrollment: "enrollment", essay: "essay", recommendations: "recommendations", transcript: "transcript", interview: "interview", nomination: "nomination", fee: "fee", renewable: "renewable", hasLaterRounds: "has_later_rounds" };

// `raw` is { url, name, metadata, checkedAt }; `context` is { scope, source, providerName,
// schoolUnitid, knownFields } where knownFields is the set of accepted fields of study.
export function cleanRecord(raw, context) {
  const reject = (reason) => ({ rejected: reason });
  const name = cleanName(raw.name);
  if (name.length < 4 || name.length > 200) return reject("name too short or too long");
  if (NOT_A_SCHOLARSHIP.test(name)) return reject("not a scholarship (form or placeholder)");
  if (!/[a-z]/i.test(name)) return reject("name has no letters");
  if (/^(name|title|scholarship|award|untitled)$/i.test(name)) return reject("not a scholarship (form or placeholder)");
  let url;
  try { url = new URL(raw.url); } catch { return reject("bad address"); }
  if (url.protocol !== "https:") return reject("address is not https");
  if (!context.providerName || context.providerName.length < 2) return reject("no provider");
  if (context.scope === "school" && !context.schoolUnitid) return reject("school not identified");
  const m = raw.metadata || {};
  const value = (field) => (stated(m[field]) ? m[field].value : null);

  let awardMin = moneyOrNull(value("awardMinimum"));
  let awardMax = moneyOrNull(value("awardMaximum"));
  if (awardMin && awardMax && awardMin > awardMax) [awardMin, awardMax] = [awardMax, awardMin];
  const gpa = value("minimumGpa");
  const citizenship = pick(value("citizenship"), CITIZENSHIP);
  const fields = [...new Set((value("fieldsOfStudy") || []).map((field) => String(field).toLowerCase().trim()).filter((field) => context.knownFields.has(field)))].sort();
  const row = {
    id: idFor(url.toString()),
    name,
    provider_name: context.providerName,
    scope: context.scope,
    school_unitid: context.schoolUnitid || null,
    url: url.toString(),
    source: context.source,
    award_min: awardMin,
    award_max: awardMax,
    award_per_year: value("awardPerYear") === true,
    award_type: AWARD_TYPES.includes(value("awardType")) ? value("awardType") : null,
    opens: dateOrNull(value("opens")),
    deadline: dateOrNull(value("deadline")),
    minimum_gpa: typeof gpa === "number" && gpa >= 1 && gpa <= 4 ? Math.round(gpa * 100) / 100 : null,
    grade_levels: pick(value("gradeLevels"), GRADES),
    fields_of_study: fields,
    citizenship,
    tags: pick(Object.keys(m.tags || {}), TAGS),
    need: LEVELS.includes(value("need")) ? value("need") : "no",
    merit: LEVELS.includes(value("merit")) ? value("merit") : "no",
    enrollment: ENROLLMENT.includes(value("enrollment")) ? value("enrollment") : "either",
    essay: value("essay") === true,
    recommendations: value("recommendations") === true,
    transcript: value("transcript") === true,
    interview: value("interview") === true,
    nomination: value("nomination") === true,
    fee: value("fee") === true,
    renewable: value("renewable") === true,
    has_later_rounds: value("hasLaterRounds") === true,
    checked_at: raw.checkedAt,
  };
  // An opening date after the deadline is a misread; neither side is trusted more, so drop it.
  if (row.opens && row.deadline && row.opens > row.deadline) row.opens = null;
  // Only facts that survived the checks above count as stated.
  const kept = (field, column) => {
    if (!stated(m[field])) return false;
    const now = row[column];
    return Array.isArray(now) ? now.length > 0 : now !== null && now !== undefined;
  };
  row.stated_fields = Object.entries(COLUMNS).filter(([field, column]) => kept(field, column)).map(([, column]) => column).sort();
  if (row.tags.length) row.stated_fields.push("tags");
  const evidence = [];
  for (const [field, column] of Object.entries(COLUMNS)) {
    const text = m[field]?.evidence;
    if (row.stated_fields.includes(column) && typeof text === "string" && text.trim()) evidence.push({ scholarship_id: row.id, field: column, evidence: decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, 600) });
  }
  for (const tag of row.tags) {
    const text = m.tags[tag];
    if (typeof text === "string" && text.trim()) evidence.push({ scholarship_id: row.id, field: `tag:${tag}`, evidence: decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, 600) });
  }
  return { row, evidence };
}

// A field of study is accepted when many separate scholarships name it the same way and it
// reads like a subject ("nursing", "mechanical engineering"), not a scrap of a sentence.
const FIELD_JUNK = /\b(current|no|specific|record|for|academic|eligible|chosen|good|standing|field|admissions|related|other|area|sciences|following|not|hours?|any|certificate|degree|program|major|majors|students?|preference|given|limited|with|their|an?|the|or|in|at|to|of)\b|[^a-z &'-]/;
export function acceptedFields(counts, minimum = 25) {
  const known = new Set();
  for (const [field, count] of counts) if (count >= minimum && field.length >= 3 && field.length <= 40 && field.split(" ").length <= 4 && !FIELD_JUNK.test(field)) known.add(field);
  return known;
}
