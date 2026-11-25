// The criteria a scholarship sets, as a list a student's facts can be compared with.
// A model reads the scholarship's text and proposes criteria; nothing it proposes is kept
// unless the line it quotes is really in the text. This file is the prompt, the shape, and
// that check. No model is called here (see scripts/extract-criteria.mjs).

export const KINDS = {
  location: "must live in, be from, or attend school in a place (state, county, city, region, school district)",
  high_school: "must attend or have graduated from a named high school",
  college: "must attend or plan to attend a named college, or a kind of college (community college, HBCU, trade school)",
  level: "year in school",
  field: "major, field of study or program",
  career: "intended career or profession",
  gpa: "minimum grade point average or class rank",
  test_score: "minimum SAT, ACT or other test score",
  citizenship: "citizenship or immigration status",
  heritage: "race, ethnicity, ancestry, tribe or national origin",
  gender: "gender",
  age: "age limit",
  need: "financial need or income limit",
  first_generation: "first in the family to attend college",
  family: "something about the student's family (child of an employee, member, veteran, farmer, single parent, deceased parent)",
  affiliation: "member, employee or customer of a named organization, company, union, church, club or credit union",
  activity: "sport, club, volunteering, hobby, art or other activity",
  military: "the student's own military service",
  disability: "disability or health condition",
  religion: "religion or faith",
  enrollment: "full-time or part-time enrollment",
  other: "any other condition a student must meet",
};
export const LEVELS = ["grade-9", "grade-10", "grade-11", "grade-12", "college-freshman", "college-sophomore", "college-junior", "college-senior", "community-college", "trade-school", "graduate", "adult-returning"];
export const CITIZENSHIP = ["us-citizen", "permanent-resident", "daca-undocumented", "international"];
export const MATERIALS = ["application-form", "essay", "transcript", "recommendation", "fafsa", "resume", "interview", "nomination", "portfolio", "test-scores", "proof-of-enrollment", "photo", "video"];
const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI".split(" ");

export const PROMPT = `You read the text of one scholarship and list who can get it. Reply with JSON only.

Rules:
- Use only what the text says. Never add a rule from general knowledge, and never guess.
- Every criterion must carry "quote": a short passage copied exactly from the text (at most 200 characters) that states it.
- "required" means a student who does not meet it cannot receive the award. "preferred" means preference or priority is given.
- If the text does not mention something (for example citizenship), leave it out. Do not write that it is not required.
- First-round requirements only: ignore what finalists or winners must do later.
- If the text describes several different scholarships, describe only the one named in "Scholarship".
- If the text is not about an award of money to an individual student (a grant to organizations, charities or programs; a loan; a news story; a general page; a list of names with no rules), set "is_scholarship" to false and leave the lists empty. A text that asks for a "proposal", "organization description", "501(c)(3)" or "audit" is about grants to organizations.
- The quote must be the words that state that very criterion. Do not attach a criterion to a quote about something else.
- Do not turn how to apply into a criterion. Essays, forms, transcripts and letters go in "materials" only.
- A date written without a year ("April 20", "June 1st each year") goes in "month_day" with "date" null. Never choose a year yourself. With several deadlines give the earliest.
- "materials": list only what the text says must be sent in.

JSON shape:
{
 "is_scholarship": true,
 "summary": "one plain sentence: who it is for and what it gives",
 "criteria": [
  {"kind": "<one of: ${Object.keys(KINDS).join(", ")}>",
   "strength": "required" | "preferred",
   "values": ["each acceptable value, short; several values mean any one of them is enough"],
   "state": "two-letter US state when kind is location, high_school or college and the place is in one state, else null",
   "quote": "exact words from the text"}
 ],
 "amount": {"min": number or null, "max": number or null, "per_year": true or false, "quote": "exact words or null"},
 "awards": number of awards given each cycle or null,
 "deadline": {"date": "YYYY-MM-DD or null", "month_day": "MM-DD when the text gives a date without a year, else null", "quote": "exact words or null"},
 "renewable": true, false or null,
 "materials": ["any of: ${MATERIALS.join(", ")}"],
 "apply_url": "address given in the text for applying, or null",
 "contact": "email or phone given in the text for questions, or null"
}

Values:
- kind "level": use only ${LEVELS.join(", ")}. A high school senior is grade-12. "Undergraduate" is the four college years.
- kind "citizenship": use only ${CITIZENSHIP.join(", ")}.
- kind "gpa": one value, the minimum on a 4.0 scale, as a number in a string ("3.0").
- kind "location": values are place names ("Polk County", "Greater Cincinnati", "Texas"); put the state in "state".
- kind "gender": "women", "men" or "non-binary".
- kind "need": "financial need", or the income limit as written.
- kind "enrollment": "full-time" or "part-time", only when the text uses those words.
- kind "high_school": the school's name ("Ames High School"), never a description of students.
- "Graduates of X High School" or "graduating seniors" is kind "level" grade-12 (plus high_school when a school is named).
- Other kinds: short plain phrases ("child of a member", "4-H", "nursing", "Baptist").

What kinds mean:
${Object.entries(KINDS).map(([kind, meaning]) => `- ${kind}: ${meaning}`).join("\n")}`;

// The words a student sees for one scholarship before the model reads it.
export function question({ name, provider, text, tier }) {
  return `Scholarship: ${name}\nProvider: ${provider || "unknown"}\nSource: ${tier === "filing" ? "the provider's tax filing (short notes, often in fragments)" : "the provider's web page"}\n\nText:\n${text.join("\n")}`;
}

// Quotes are compared without regard to case, punctuation or spacing.
const flat = (text) => String(text || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9$%.]+/g, " ").replace(/\s+/g, " ").trim();
export function quoted(quote, flatText) {
  const needle = flat(quote);
  if (needle.length < 6) return false;
  if (flatText.includes(needle)) return true;
  // A quote that skips a few words in the middle ("...") still counts when both halves are there.
  const parts = String(quote).split(/\.{3}|…/).map(flat).filter((part) => part.length >= 6);
  return parts.length > 1 && parts.every((part) => flatText.includes(part));
}

// Words in the quote that show a fixed value was really stated there.
const SIGNS = {
  "grade-9": /freshm[ae]n|9th|ninth|high school/i, "grade-10": /sophomore|10th|tenth|high school/i, "grade-11": /junior|11th|eleventh|high school/i,
  "grade-12": /senior|12th|twelfth|high school|graduat/i,
  "college-freshman": /freshm[ae]n|first[- ]year|undergrad|college|universit|incoming|entering|post-?secondary|higher education/i,
  "college-sophomore": /sophomore|second[- ]year|undergrad|college|universit|post-?secondary|higher education/i,
  "college-junior": /junior|third[- ]year|undergrad|upper|college|universit|post-?secondary|higher education/i,
  "college-senior": /senior|fourth[- ]year|final year|undergrad|upper|college|universit|post-?secondary|higher education/i,
  "community-college": /community college|junior college|two[- ]year|2[- ]year|associate/i, "trade-school": /trade|vocation|technical|apprentice|certificat/i,
  graduate: /graduate (student|school|program|degree|study|studies|level)|master|doctor|ph\.?d|law school|medical school|post-?graduate|mba|\bj\.?d\b|\bm\.?d\b/i,
  "adult-returning": /adult|non-?traditional|returning|re-?entry|older/i,
  "us-citizen": /citizen/i, "permanent-resident": /permanent resident|green card|legal resident|lawful/i, "daca-undocumented": /daca|undocumented|dreamer/i, international: /international|foreign|non-?citizen|visa/i,
  "full-time": /full[- ]?time/i, "part-time": /part[- ]?time|half[- ]?time/i,
  women: /wom[ae]n|female|girl|daughter|mother/i, men: /\bm[ae]n\b|\bmale|boy|\bsons?\b|father/i, "non-binary": /non-?binary|gender/i,
};
const MATERIAL_SIGNS = {
  "application-form": /application|apply|form/i, essay: /essay|personal statement|written statement|letter of introduction|autobiograph|narrative/i, transcript: /transcript|grades|report card/i,
  recommendation: /recommend|reference/i, fafsa: /fafsa|student aid report|\bsar\b|financial aid form/i, resume: /resume|résumé|curriculum vitae|\bcv\b/i, interview: /interview/i,
  nomination: /nominat/i, portfolio: /portfolio|audition|sample of work|work samples?/i, "test-scores": /\bsat\b|\bact\b|test scores?/i, "proof-of-enrollment": /proof of (enrollment|acceptance)|acceptance letter|letter of acceptance|enrollment verification/i,
  photo: /photo|picture/i, video: /video/i,
};
const STOP = new Set(["with", "from", "that", "this", "must", "have", "will", "been", "their", "they", "student", "students", "scholarship", "scholarships", "applicant", "applicants", "member", "members", "child", "children"]);
// A free-text value is supported when one of its telling words is in the quote.
function supported(kind, value, quote) {
  if (SIGNS[value]) return SIGNS[value].test(quote);
  if (kind === "gpa") return /\d/.test(quote) && /gpa|grade|average|rank|academic|\d\.\d/i.test(quote);
  const words = flat(value).split(" ").filter((word) => word.length >= 4 && !STOP.has(word));
  if (!words.length) return flat(quote).includes(flat(value));
  const text = flat(quote);
  return words.some((word) => text.includes(word.slice(0, Math.max(4, word.length - 2))));
}

// A value everyone meets says nothing: "an accredited college", "United States".
const EVERYONE = /^(an? |any |the )?((accredited|approved|qualified|recognized|eligible|partnering|participating|post-?secondary|higher education|educational|2 or 4 year|two or four year|two-year|four-year|degree-granting) )*(college|university|institution|school|program|trade school|vocational school|technical school)s?(( or|,| and) (an? )?(accredited )?(college|university|institution|school|trade school|vocational school|technical school|community college)s?)*$|^(the )?(united states|u\.?s\.?a?\.?|america|nationwide|national|any state|all states)( of america)?( (and|&) (its )?(possessions|territories))?$/i;
// Criteria as stored, tidied once more when records are built: values that say nothing are
// dropped, and a criterion left with no value goes with them.
export function refine(criteria) {
  const out = [];
  for (const item of criteria || []) {
    const values = ["college", "location", "other"].includes(item.kind) ? item.values.filter((value) => !EVERYONE.test(value.trim())) : item.values;
    if (values.length) out.push({ ...item, values });
  }
  return out;
}

// Kinds whose values come from a fixed list and are compared exactly.
const FIXED = new Set(["level", "citizenship", "gender", "enrollment", "gpa", "need", "first_generation", "military", "disability"]);
// For the matcher: the same criteria in the same order, without quotes and with free-text
// values in plain words (lower case, letters and digits, single spaces):
//   [{ k: kind, r: 1 if required else 0, v: [values] }]
// It is kept small (the database holds it inside an index), so a scholarship with very long
// lists has them shortened here; the full criteria stay in `criteria` for display.
export function matchForm(criteria, limit = 1500) {
  const build = (maxValues, maxLength) => (criteria || []).map((item) => ({
    k: item.kind, r: item.strength === "required" ? 1 : 0,
    v: (FIXED.has(item.kind) ? item.values : item.values.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter(Boolean)).slice(0, maxValues).map((value) => value.slice(0, maxLength)),
  }));
  for (const [maxValues, maxLength] of [[40, 120], [12, 80], [6, 60], [3, 40], [1, 40], [0, 0]]) {
    const out = build(maxValues, maxLength);
    if (JSON.stringify(out).length <= limit) return out;
  }
  return [];
}

const number = (value, low, high) => (typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : null);
const short = (value, limit) => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, limit) : null);

// Keep only what passes: known kinds, real quotes, values in range. Returns the clean record
// and how many proposed criteria were dropped and why.
export function checkCriteria(answer, textLines) {
  const flatText = flat(textLines.join(" "));
  const dropped = {};
  const drop = (reason) => { dropped[reason] = (dropped[reason] || 0) + 1; };
  const out = { is_scholarship: answer?.is_scholarship !== false, summary: short(answer?.summary, 300), criteria: [], amount: null, awards: null, deadline: null, renewable: typeof answer?.renewable === "boolean" ? answer.renewable : null, materials: [], apply_url: null, contact: short(answer?.contact, 120) };
  if (!out.is_scholarship) return { record: out, dropped };
  const seen = new Set();
  for (const item of Array.isArray(answer?.criteria) ? answer.criteria : []) {
    if (!item || !Object.hasOwn(KINDS, item.kind)) { drop("unknown kind"); continue; }
    if (!quoted(item.quote, flatText)) { drop("quote not in the text"); continue; }
    let values = (Array.isArray(item.values) ? item.values : [item.values]).map((value) => short(String(value ?? ""), 120)).filter(Boolean);
    if (item.kind === "level") values = values.filter((value) => LEVELS.includes(value));
    if (item.kind === "citizenship") values = values.filter((value) => CITIZENSHIP.includes(value));
    if (item.kind === "gpa") values = values.map((value) => number(Number.parseFloat(value), 1, 5)).filter((value) => value !== null).map(String).slice(0, 1);
    if (item.kind === "enrollment") values = values.filter((value) => ["full-time", "part-time"].includes(value));
    if (item.kind === "gender") values = values.filter((value) => ["women", "men", "non-binary"].includes(value));
    if (!values.length) { drop("no usable value"); continue; }
    const before = values.length;
    values = values.filter((value) => supported(item.kind, value, item.quote));
    if (!values.length) { drop("value not stated in its quote"); continue; }
    if (values.length < before) drop("extra value not in its quote");
    const key = `${item.kind}|${values.join("|").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.criteria.push({ kind: item.kind, strength: item.strength === "preferred" ? "preferred" : "required", values: values.slice(0, 40), state: STATES.includes(item.state) ? item.state : null, quote: short(item.quote, 300) });
  }
  out.criteria = refine(out.criteria);
  const amount = answer?.amount;
  if (amount && (amount.min != null || amount.max != null)) {
    if (quoted(amount.quote, flatText)) {
      let min = number(amount.min, 1, 70000), max = number(amount.max, 1, 70000);
      if (min && max && min > max) [min, max] = [max, min];
      if (min || max) out.amount = { min, max, per_year: amount.per_year === true, quote: short(amount.quote, 300) };
    } else drop("amount quote not in the text");
  }
  out.awards = number(answer?.awards, 1, 100000);
  const deadline = answer?.deadline;
  if (deadline && (deadline.date || deadline.month_day)) {
    if (quoted(deadline.quote, flatText)) {
      // A year the text does not print is a guess: keep the day, drop the year.
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(deadline.date || "") && !Number.isNaN(Date.parse(deadline.date)) && deadline.date >= "2020-01-01" && deadline.date <= "2035-12-31";
      const yearPrinted = valid && (String(deadline.quote).includes(deadline.date.slice(0, 4)) || new RegExp(`[/.-]${deadline.date.slice(2, 4)}\\b`).test(String(deadline.quote)));
      const date = valid && yearPrinted ? deadline.date : null;
      const monthDay = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(deadline.month_day || "") ? deadline.month_day : valid ? deadline.date.slice(5) : null;
      if (date || monthDay) out.deadline = { date, month_day: monthDay, quote: short(deadline.quote, 300) };
    } else drop("deadline quote not in the text");
  }
  const whole = textLines.join(" ");
  out.materials = [...new Set((Array.isArray(answer?.materials) ? answer.materials : []).filter((item) => MATERIALS.includes(item) && MATERIAL_SIGNS[item].test(whole)))];
  // A contact must be an email or phone printed in the text.
  if (out.contact && !(/@|\d{3}.*\d{4}/.test(out.contact) && flatText.includes(flat(out.contact)))) out.contact = null;
  const link = short(answer?.apply_url, 300);
  if (link) { try { const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`); if (flatText.includes(flat(url.host.replace(/^www\./, "")))) out.apply_url = url.toString(); else drop("address not in the text"); } catch { drop("address not in the text"); } }
  return { record: out, dropped };
}
