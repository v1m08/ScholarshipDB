// Step 3: condense a scholarship's pages to the few lines that carry facts, then
// Step 4: fill metadata from those lines with keyword rules. Every value keeps the line
// it came from, so a wrong value can be traced to its cause.
const CATEGORIES = {
  dates: /\b(deadline|due\b|opens?\b|closes?\b|application period|notif|announce|submit(ted)? by)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? 20\d\d/i,
  award: /\$\s?\d|\b(award(ed|s)?|stipend|tuition|renewable|per year|full cost|last dollar|funding)\b/i,
  eligibility: /\b(eligib|must\b|citizen|resident|gpa|grade point|high school|senior|junior|sophomore|freshman|undergraduate|graduate student|community college|two-year|transfer|enroll|income|financial need|pell|accredited)\b/i,
  application: /\b(essays?|recommendations?|recommender|transcripts?|interview|nominat|fee\b|common app|test scores?|sat\b|act\b)\b/i,
  obligation: /\b(required to|agreement|maintain|attendance|commit(ment)?|service requirement|repay)\b/i,
};
const MAX_LINES = 60;

export function buildDigest(pages) {
  const seen = new Set();
  const kept = [];
  let order = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      const text = line.replace(/^[#-] /, "");
      if (text.length < 20 || text.length > 420) continue;
      const key = text.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (seen.has(key)) continue;
      const categories = Object.entries(CATEGORIES).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
      if (!categories.length) continue;
      seen.add(key);
      const score = categories.length + (/\d/.test(text) ? 1 : 0) + (/\$\s?\d|20\d\d/.test(text) ? 1 : 0) + (/\b(must|minimum|required|eligible|deadline)\b/i.test(text) ? 1 : 0);
      kept.push({ text, categories, score, url: page.url, order: order++ });
    }
  }
  const lines = kept.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, MAX_LINES).sort((a, b) => a.order - b.order);
  return { lines, text: lines.map((line) => `- ${line.text}`).join("\n") };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
export const AWARD_LIMIT = 70000;

// Dates in reading order. "August 3, through September 30, 2026" has a first date with no
// year; it borrows the year from the next dated one in the same sentence.
export function datesIn(text) {
  const found = [];
  for (const match of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?/gi)) {
    found.push({ month: MONTHS.indexOf(match[1].toLowerCase()) + 1, day: Number(match[2]), year: match[3] ? Number(match[3]) : null, index: match.index });
  }
  for (const match of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/g)) found.push({ month: Number(match[1]), day: Number(match[2]), year: Number(match[3]), index: match.index });
  found.sort((a, b) => a.index - b.index);
  for (let i = found.length - 1; i >= 0; i -= 1) {
    if (found[i].year) continue;
    const next = found.slice(i + 1).find((entry) => entry.year);
    if (!next) continue;
    // A range that crosses New Year ("November 3 through January 5, 2027") starts the year before.
    found[i].year = found[i].month > next.month ? next.year - 1 : next.year;
  }
  return found.filter((entry) => entry.year && entry.day >= 1 && entry.day <= 31).map((entry) => iso(entry.year, entry.month, entry.day));
}

function amountsIn(text) {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(\s?(k|thousand|million|billion)\b)?/gi)].map((match) => {
    const unit = (match[3] || "").toLowerCase();
    const scale = unit === "k" || unit === "thousand" ? 1e3 : unit === "million" ? 1e6 : unit === "billion" ? 1e9 : 1;
    const before = text.slice(Math.max(0, match.index - 45), match.index).toLowerCase();
    const after = text.slice(match.index, match.index + match[0].length + 30).toLowerCase();
    return {
      value: Number(match[1].replace(/,/g, "")) * scale,
      // Wording that marks what one student receives, as opposed to an organization's total.
      perStudent: /up to|as much as|each|scholarships? of|awards? of|receive|worth|valued at/.test(before) || /per year|each year|a year|scholarship|award|per student|annually/.test(after),
      perYear: /per year|each year|a year\b|annually|per academic year/.test(after) && !/total/.test(after),
    };
  });
}

const TOTALS = /\b(million|billion)\b|since (inception|\d{4})|to date|in total|in scholarships|have been awarded|has awarded|awarding \$/i;
const LATER_STAGE = /semi-?finalists?|\bfinalists?\b|phase (2|3|4|two|three|four)|(second|third|final) (round|phase|stage)|applicants? who advance|those who advance|if (you are )?selected|once selected|selected (scholars|recipients|students) (will|must|are)|conducts? interviews|interviews? (are|will be) conducted|(invited|selected) (to|for) (an? )?interview/i;
const UI_WORDS = /\s+(expand|collapse|read more|show more|show less|toggle|open|close)\s*$/i;
const isQuestion = (text) => /\?\s*$/.test(text.replace(UI_WORDS, ""));
// A list entry describing some other organization: "Name of Fund - The largest provider of ..."
const OTHER_ORG = /^[A-Z][A-Za-z&.' ]{3,70}(, Inc\.?)? [-–:] (the|a|an|provides?|offers?|awards?|founded|largest)\b/i;

const first = (lines, pattern) => lines.find((line) => pattern.test(line.text));
const found = (value, line) => ({ value, evidence: line ? line.text : null });
const assumed = (value) => ({ value, evidence: null, assumed: true });

const TAGS = {
  leadership: /\bleadership\b/i,
  "community-service": /community service|service to others|volunteer/i,
  research: /\bresearch (project|experience|career)|undergraduate research\b/i,
  adversity: /adversity|persistence|perseverance|overcom/i,
  "first-generation": /first[- ]generation|first in (their|your) family/i,
  "study-abroad": /study abroad/i,
  athletics: /\bathlet/i,
  "work-experience": /work experience/i,
  women: /\bwomen\b|\bfemale\b/i,
  "military-connected": /\bveterans?\b|military (service|famil|dependent|member|spouse)/i,
  stem: /\bstem\b|science, technology/i,
};

export function extractMetadata(allLines) {
  const meta = {};
  const doubts = [];
  const doubt = (field, reason, line) => doubts.push({ field, reason, evidence: line ? line.text : null });

  // FAQ pages are question/answer pairs. A question states nothing by itself, so each one
  // is joined to the line that follows it and only the answer is read.
  const pairs = [];
  const statements = [];
  for (let i = 0; i < allLines.length; i += 1) {
    const text = allLines[i].text.replace(UI_WORDS, "").trim();
    if (isQuestion(text)) {
      const answer = allLines[i + 1] && !isQuestion(allLines[i + 1].text) ? allLines[i + 1].text : "";
      pairs.push({ question: text, answer, text: `${text} ${answer}`.trim() });
    } else {
      statements.push({ ...allLines[i], text });
    }
  }
  // What the answer to a yes/no question says: true, false, or null when unclear.
  const answerTo = (questionPattern) => {
    const pair = pairs.find((entry) => questionPattern.test(entry.question) && entry.answer);
    if (!pair) return null;
    const yes = /^\s*yes\b/i.test(pair.answer);
    const no = /^\s*no\b/i.test(pair.answer);
    return { pair, verdict: yes ? true : no ? false : null };
  };

  const lines = statements.filter((line) => !OTHER_ORG.test(line.text));
  // Only the first application round is described; later rounds are the provider's to explain.
  const firstRound = lines.filter((line) => !LATER_STAGE.test(line.text));
  meta.hasLaterRounds = lines.some((line) => LATER_STAGE.test(line.text))
    ? found(true, first(lines, LATER_STAGE)) : assumed(false);

  // Dates. A sentence with "from/open ... A through B" gives both ends.
  for (const line of firstRound) {
    const dates = datesIn(line.text);
    if (!dates.length || /recommend|notif|announce|webinar|transcripts? (for|must)/i.test(line.text)) continue;
    const isRange = dates.length >= 2 && /\b(open|available|accepted|from)\b/i.test(line.text) && /through|until|\bto\b|[-–]/i.test(line.text);
    if (isRange && !meta.deadline) {
      meta.opens = found(dates[0], line);
      meta.deadline = found(dates.at(-1), line);
    } else if (/deadline|closes?\b|will close|\bdue\b|submitted by|no later than/i.test(line.text) && !meta.deadline) {
      meta.deadline = found(dates.at(-1), line);
    } else if (/\bopens?\b|becomes? available|will be available/i.test(line.text) && !/clos|deadline|\bdue\b/i.test(line.text) && !meta.opens && dates.length === 1) {
      meta.opens = found(dates[0], line);
    }
  }
  if (meta.opens && meta.deadline && meta.opens.value > meta.deadline.value) {
    doubt("opens", "open date is after the deadline", { text: meta.opens.evidence });
    delete meta.opens;
  }

  // Money. Income lines give the ceiling. Award amounts must read as what one student gets,
  // must not be an organization's total, and must not exceed the limit.
  let award = null;
  for (const line of lines) {
    const amounts = amountsIn(line.text);
    if (!amounts.length) continue;
    if (/income|\bagi\b|household|earning/i.test(line.text)) {
      meta.incomeCeiling ||= found(Math.max(...amounts.map((amount) => amount.value)), line);
      continue;
    }
    if (TOTALS.test(line.text)) continue;
    for (const amount of amounts.filter((entry) => entry.perStudent)) {
      if (amount.value > AWARD_LIMIT) {
        doubt("awardMaximum", `$${amount.value.toLocaleString()} is over the $${AWARD_LIMIT.toLocaleString()} limit; enter manually if real`, line);
      } else if (amount.value >= 100) {
        const perYear = amount.perYear;
        const better = !award || (perYear && !award.perYear) || (perYear === Boolean(award.perYear) && amount.value > award.value);
        if (better) award = { ...found(amount.value, line), perYear };
      }
    }
  }
  if (award) {
    meta.awardMaximum = found(award.value, { text: award.evidence });
    meta.awardPerYear = found(Boolean(award.perYear), { text: award.evidence });
  }
  const lastDollar = first(lines, /last[- ]dollar|full cost of attendance|full tuition|full[- ]ride/i);
  if (lastDollar) meta.awardType = found(/last[- ]dollar/i.test(lastDollar.text) ? "last-dollar" : "full-cost", lastDollar);

  const gpaLine = lines.find((line) => /gpa|grade point/i.test(line.text) && /minimum|at least|or better|or above|or higher|gpa of|average of|maintain/i.test(line.text) && /\b[2-4]\.\d{1,2}\b/.test(line.text));
  if (gpaLine) {
    // "3.0 for high school students; 2.5 for college students": the lowest is the true floor.
    // Scale markers such as "on a 4.0 scale" are not minimums.
    const values = [...gpaLine.text.matchAll(/\b([2-4]\.\d{1,2})\b(?! scale)/g)].map((match) => Number(match[1])).filter((value) => !/4\.0+ scale/.test(gpaLine.text) || value !== 4);
    if (values.length) meta.minimumGpa = found(Math.min(...values), gpaLine);
  }

  // Citizenship: a direct FAQ answer wins; otherwise read statements.
  const citizenAnswer = answerTo(/u\.?s\.? citizen/i);
  const anyCitizen = first(lines, /citizenship is not required|regardless of citizenship|need not be (a )?u\.?s\.? citizen/i);
  if (citizenAnswer && citizenAnswer.verdict === false) {
    meta.citizenship = found(["any"], citizenAnswer.pair);
  } else if (anyCitizen) {
    meta.citizenship = found(["any"], anyCitizen);
  } else {
    const statuses = [];
    let evidence = null;
    const check = (pattern, status) => {
      const line = lines.find((entry) => pattern.test(entry.text) && !/not eligible|do(es)? not qualify|are not/i.test(entry.text));
      if (line) { statuses.push(status); evidence ||= line; }
    };
    check(/u\.?s\.? citizens?|united states citizens?|citizens? of the (united states|u\.?s\.?)/i, "us-citizen");
    // "a citizen of the United States, Australia, Canada, ...": more than the fixed statuses can say.
    const others = evidence && evidence.text.match(/citizens? of the (?:united states|u\.?s\.?), ([^.;]{3,80})/i);
    if (others) doubt("citizenship", `other citizenships are also accepted: ${others[1].trim()}`, evidence);
    check(/permanent (legal )?resident/i, "permanent-resident");
    check(/\bdaca\b/i, "daca-undocumented");
    if (statuses.length) meta.citizenship = found(statuses, evidence);
  }

  const grades = new Set();
  const gradeEvidence = [];
  // Grade levels come only from sentences that state who may apply; a passing mention of
  // "graduate school" or "undergraduate degree" elsewhere says nothing about eligibility.
  const WHO = /\b(must|eligib\w*|scholarships? to|open to|available to|be an?\b|are an?\b|who are|applicants?|candidates?|students? (who|in their|graduating|enrolled))\b/i;
  const whoLines = lines.filter((line) => WHO.test(line.text) && line.text.length >= 25);
  const grade = (pattern, values) => { const line = first(whoLines, pattern); if (line) { values.forEach((value) => grades.add(value)); gradeEvidence.push(line.text); } };
  const COLLEGE_YEARS = ["college-freshman", "college-sophomore", "college-junior", "college-senior"];
  grade(/high school seniors?|senior year of high school|graduating (high school )?seniors?|incoming (college )?(freshmen|freshman|first-year)|final year of (high|secondary) school|last year of (high|secondary) school|graduate (from )?high school (during|in)/i, ["grade-12"]);
  grade(/high school juniors?/i, ["grade-11"]);
  grade(/(student|enrolled|attend\w*) at an? [^.]{0,40}(community college|two-year)|community college students?|two-year (and|or) four-year|2-year (and|or) 4-year/i, ["community-college"]);
  grade(/\bundergraduate students?\b|bachelor['’]?s,? (master|and|or)|\bcollege undergraduates?\b|enrolled as (an )?undergraduate/i, COLLEGE_YEARS);
  grade(/college (sophomore|junior)|sophomore or junior|sophomores? (and|or) juniors?/i, ["college-sophomore", "college-junior"]);
  grade(/junior-level|full-time junior\b|college juniors?\b/i, ["college-junior"]);
  // "undergraduate" must not count as "graduate"; exclusions ("graduate students are not eligible") do not count either.
  grade(/(?<![a-z])graduate(-level)? students?\b(?![^.]{0,40}(not eligible|excluded|ineligible))|college and graduate students|master['’]?s,? (or|and) doctoral|doctoral students/i, ["graduate"]);
  if (grades.size) meta.gradeLevels = { value: [...grades], evidence: gradeEvidence[0] };

  // Need: an FAQ answer such as "achievement-based" settles it; a bare mention does not.
  const needAnswer = answerTo(/needs?[- ](or|based)|income[- ]based|financial need|based on need/i);
  const needRequired = first(lines, /(demonstrate|unmet|evidence of|substantial|significant|high|present)[^.]{0,30}financial need|in need of financial (assistance|aid|support)|pell[- ](grant )?eligible|(be|receiv\w+)[^.]{0,25}pell grant|low[- ]income (households?|backgrounds?|students)/i);
  const needConsidered = first(lines, /financial need (is|will be) (considered|a factor|taken)|based on (relative |financial )?need|need[- ]based|judged on[^.]{0,60}financial need|based on[^.]{0,140}financial need|financial need \(\d+%\)|consider(s|ed|ation)?[^.]{0,40}financial need/i);
  if (needAnswer && (needAnswer.verdict === false || /achievement[- ]based|merit[- ]based|not (a )?need/i.test(needAnswer.pair.answer))) {
    meta.need = found("no", needAnswer.pair);
  } else if (needRequired) {
    meta.need = found("required", needRequired);
  } else if (needConsidered) {
    meta.need = found("considered", needConsidered);
  } else {
    meta.need = assumed("no");
    const mention = first(lines, /financial need|low[- ]income/i);
    if (mention) doubt("need", "financial need is mentioned but not clearly required or considered", mention);
  }
  const meritLine = first(lines, /academic (ability|achievement|excellence|record)|achievement[- ]based|merit/i);
  meta.merit = meta.minimumGpa ? found("required", { text: meta.minimumGpa.evidence }) : meritLine ? found("considered", meritLine) : assumed("no");

  const fullTime = first(lines, /enroll(ed|ment)? full[- ]time|full[- ]time (undergraduate |graduate |degree-seeking )?(student|enrollment|basis)/i);
  meta.enrollment = fullTime ? found("full-time", fullTime) : assumed("either");

  // Yes/no fields: an explicit "no ..." statement wins, then an FAQ answer, then a mention.
  const yesNo = (source, yes, no, question) => {
    // An explicit "not required" counts even when the same sentence goes on to describe a later round.
    const negative = no && first(lines, no);
    if (negative) return found(false, negative);
    const answered = question && answerTo(question);
    if (answered && answered.verdict !== null && !LATER_STAGE.test(answered.pair.answer)) return found(answered.verdict, answered.pair);
    // A section heading ("Interviews") is not a statement; a list item ("Three brief essays") is.
    const positive = source.find((line) => yes.test(line.text) && !line.heading);
    return positive ? found(true, positive) : assumed(false);
  };
  meta.essay = yesNo(firstRound, /\bessays?\b|short answer|personal statement/i, /no essays?\b|essays? (are|is) not required|does not require (an )?essay/i, /essays? required/i);
  meta.recommendations = yesNo(firstRound, /recommendation|recommender/i, /no recommendations?\b|no (essays?|transcripts?)[^.]{0,40}(and|or) no recommendations?/i, /recommendations? required/i);
  meta.interview = yesNo(firstRound, /\binterview/i, /no interview/i, /interview (required|part)/i);
  meta.nomination = yesNo(firstRound, /must be nominated|nominated by (your|their|the)|nomination (is )?required/i, /do(es)? not require nomination|no nomination/i, /nominat/i);
  meta.fee = yesNo(lines, /application fee of|\$\d+ (application |processing )?fee/i, /no (cost or )?fee|no application fee|free to apply|apply for free/i, /\bfee\b|cost to apply/i);
  meta.renewable = yesNo(lines, /renewable|renewed each|may be renewed|each year (for|of)|for (up to )?(two|three|four|\d) (to (three|four|five) )?years|(two|three|four|2|3|4)[- ]year (scholarships?|awards?)|over (two|three|four) years|years of (support|funding)/i, /not renewable|non-renewable|one-time (award|scholarship|payment)/i, /renewable/i);

  const obligation = first(lines, /(scholars?|recipients?|awardees?) (are|is|must be) (required|expected) to|is expected of all|as a condition of (receiving|the award)|service (requirement|commitment|obligation)|required to (work|complete a)/i);
  if (obligation) meta.obligation = found(obligation.text, obligation);

  meta.tags = {};
  for (const [tag, pattern] of Object.entries(TAGS)) {
    // A question ("Are military members eligible?") is not a statement about who the award is for.
    const line = lines.find((entry) => pattern.test(entry.text) && !/\?\s*$/.test(entry.text));
    if (line) meta.tags[tag] = line.text;
  }
  meta.doubts = doubts;
  return meta;
}
