// Turn a parsed portal award page into the same metadata the site scraper produces.
// The page's own labelled fields (Award, Deadline, Supplemental Questions) are trusted
// over anything read out of the free-text description.
import { parseAward } from "./academicworks.mjs";
import { AWARD_LIMIT, extractMetadata } from "./digest.mjs";

const found = (value, evidence) => ({ value, evidence });
const assumed = (value) => ({ value, evidence: null, assumed: true });
// Long paragraphs are split so each rule reads one sentence, not a whole block.
const sentences = (line) => (line.length > 220 ? line.split(/(?<=[.!?])\s+(?=[A-Z])/) : [line]);

// On a college's own portal, bare class words ("junior or senior") mean college years.
const CLASS_YEARS = [
  [/\b(new|incoming|entering|first[- ]time)( college)? (freshm[ae]n|first[- ]year)/i, ["grade-12", "college-freshman"]],
  [/(?<!high school )\bfreshm[ae]n\b|\bfirst[- ]year students?\b/i, ["college-freshman"]],
  [/(?<!high school )\bsophomores?\b/i, ["college-sophomore"]],
  [/(?<!high school )\bjuniors?\b(?! college)/i, ["college-junior"]],
  [/(?<!high school |graduating )\bseniors?\b(?! (citizen|adult|center))/i, ["college-senior"]],
  [/(second|2nd)[- ]year students?/i, ["college-sophomore"]],
  [/\bundergraduates?\b(?! degree)|\bupperclass/i, []],
  [/(?<![a-z])graduate (students?|program|degree|level|school|and undergraduate)|undergraduate (and|or) graduate|\b(master'?s|doctoral|ph\.?d)\b|level\s*[-–:]\s*graduate/i, ["graduate"]],
];
const ALL_YEARS = ["college-freshman", "college-sophomore", "college-junior", "college-senior"];

function classYears(lines) {
  const levels = new Set();
  let evidence = null;
  let undergraduate = null;
  for (const line of lines) {
    if (/not eligible|ineligible/i.test(line.text)) continue;
    for (const [pattern, values] of CLASS_YEARS) {
      if (!pattern.test(line.text)) continue;
      if (!values.length) { undergraduate ||= line.text; continue; }
      values.forEach((value) => levels.add(value));
      evidence ||= line.text;
    }
  }
  // "undergraduate" alone means every year; with named years, the named years are the answer.
  if (undergraduate && !ALL_YEARS.some((year) => levels.has(year))) { ALL_YEARS.forEach((year) => levels.add(year)); evidence ||= undergraduate; }
  return levels.size ? { value: [...levels], evidence } : null;
}

// "majoring in nursing", "education major", "Major - Any Major": kept as the page words it.
function fieldsOfStudy(lines) {
  const out = new Set();
  let evidence = null;
  // Words that lead into a major's name without being part of it.
  const LEAD = /^(an?|the|any|all|declared|intended|approved|be|is|are|must|who|with|for|to|in|of|as|applicants?|students?|recipients?|preference|given|awarded|full-time|undergraduate|graduate|their|your|or|and)$/i;
  const add = (phrase, line) => {
    const words = phrase.trim().split(/\s+/);
    while (words.length && LEAD.test(words[0])) words.shift();
    const clean = words.join(" ");
    if (clean.length < 3 || clean.length > 60 || /\b(their|his|her|your|regardless|gpa|other|same|whose|that|which|have|has)\b/i.test(clean)) return;
    out.add(clean.toLowerCase());
    evidence ||= line.text;
  };
  for (const line of lines) {
    for (const match of line.text.matchAll(/(?:major(?:ing|s)?|degree) in ([A-Za-z&/' -]{3,60}?)(?=,| and | or |\.|;| who| with| at |$)/gi)) add(match[1], line);
    for (const match of line.text.matchAll(/((?:[A-Za-z&/'-]+ ){0,3}[A-Za-z&/'-]+) majors?\b(?! in\b)/gi)) add(match[1], line);
  }
  return out.size ? { value: [...out].slice(0, 8), evidence } : null;
}

export function awardRecord(page, { url, portalName, external = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = page.description.flatMap(sentences).map((line) => ({ text: line.replace(/^- /, ""), heading: false, url }));
  const metadata = extractMetadata(lines);

  if (page.deadline) metadata.deadline = found(page.deadline, `Deadline: ${page.deadlineText}`);
  const award = parseAward(page.awardText);
  const awardEvidence = `Award: ${page.awardText}`;
  if (award.max && award.max >= 100) {
    if (award.max > AWARD_LIMIT) {
      metadata.doubts.push({ field: "awardMaximum", reason: `$${award.max.toLocaleString()} is over the $${AWARD_LIMIT.toLocaleString()} limit; enter manually if real`, evidence: awardEvidence });
      delete metadata.awardMaximum;
      delete metadata.awardPerYear;
    } else {
      metadata.awardMaximum = found(award.max, awardEvidence);
      if (award.min !== award.max) metadata.awardMinimum = found(award.min, awardEvidence);
      metadata.awardPerYear = /per (academic )?year|annual|each year|\/ ?year/i.test(page.awardText) ? found(true, awardEvidence) : assumed(false);
    }
  } else if (page.awardText && /full (tuition|ride|cost)/i.test(page.awardText)) {
    metadata.awardType = found("full-cost", awardEvidence);
  }

  if (!external) {
    const years = classYears(lines);
    if (years) metadata.gradeLevels = years;
  }
  const majors = fieldsOfStudy(lines);
  if (majors) metadata.fieldsOfStudy = majors;

  // What the applicant is asked for on this portal is the first-round requirement list.
  const ask = (pattern) => page.questions.find((question) => pattern.test(question));
  const asked = (question) => `Question: ${question.slice(0, 200)}`;
  const essay = ask(/\bessays?\b|personal statement|\b\d{2,4}[- ]words?\b|(in|write) (a|one|two) (paragraph|page)|statement of (purpose|need|goals)/i);
  const recommendation = ask(/letters? of (recommendation|reference|support)|recommendation|reference letter|\breferences?\b/i);
  const transcript = ask(/transcript/i);
  if (essay) metadata.essay = found(true, asked(essay));
  if (recommendation) metadata.recommendations = found(true, asked(recommendation));
  const transcriptLine = lines.find((line) => /transcript/i.test(line.text));
  metadata.transcript = transcript ? found(true, asked(transcript)) : transcriptLine ? found(true, transcriptLine.text) : assumed(false);

  return {
    url,
    name: page.name,
    provider: page.donor || (external ? null : portalName || null),
    listedBy: portalName || null,
    // Awards in a school's own list are for that school's students only.
    restrictedTo: external ? null : portalName || null,
    external,
    // A deadline that has passed, or a missing one, is reported rather than guessed around.
    status: !page.deadline ? "no-deadline" : page.deadline < today ? "past-deadline" : "open",
    providerLinks: page.links,
    fields: page.fields,
    questionCount: page.questions.length,
    metadata,
  };
}
