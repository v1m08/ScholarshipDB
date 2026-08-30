// Ingest Bold.org scholarships from their listing pages' embedded flight data.
// Bold hosts applications on its own platform, so records are structured:
// endDate, award amounts, hasEssay, education levels, and category are all
// platform-enforced fields. Writes canonical candidates to the given path;
// feed that file to `npm run add -- <file> --source bold --yes`.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const BASE = "https://bold.org/scholarships";
const USER_AGENT = "ScholarshipDB/1.0 (open-source scholarship directory; +https://github.com/v1m08/ScholarshipDB)";
const MAX_PAGES = 400;
const DELAY_MS = 250;

const CATEGORY_TAGS = {
  "Need-Based": ["financial-need"],
  "Merit-Based": ["merit-based"],
  "Community Service": ["community-service"],
  Leadership: ["leadership"],
  Athletics: ["athlete"],
  Art: ["arts"],
  Arts: ["arts"],
  Music: ["arts"],
  STEM: ["stem"],
  Engineering: ["stem", "engineering"],
  "Computer Science": ["stem", "computer-science"],
  Nursing: ["healthcare", "nursing"],
  Medicine: ["healthcare", "medicine"],
  Healthcare: ["healthcare"],
  Education: ["education"],
  Business: ["business"],
  Law: ["law-legal-studies"],
  Trades: ["trades"],
  Agriculture: ["agriculture"],
  Environment: ["environment"],
  Women: ["women"],
  "First-Generation": ["first-generation"],
  "Black/African American": ["black-students"],
  Hispanic: ["hispanic-latino"],
  "LGBTQ+": ["lgbtq"],
  Military: ["veteran-military"],
  Veterans: ["veteran-military"],
  "Diversity and Inclusion": ["underrepresented"],
  Sports: ["athlete"],
};

function flightText(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((match) => {
      try { return JSON.parse(`"${match[1]}"`); } catch { return ""; }
    })
    .join("");
}

// Forward, string-aware balanced-object scan so braces inside strings are safe.
function balancedObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

// Every scholarship object carries "endDate"; walk back to enclosing "{" candidates
// and keep the first that parses to an object spanning the anchor.
export function extractScholarships(html) {
  const text = flightText(html);
  const seen = new Set();
  const scholarships = [];
  for (let anchor = text.indexOf('"endDate"'); anchor >= 0; anchor = text.indexOf('"endDate"', anchor + 1)) {
    for (let start = text.lastIndexOf("{", anchor); start >= 0; start = text.lastIndexOf("{", start - 1)) {
      const candidate = balancedObject(text, start);
      if (!candidate || start + candidate.length < anchor) continue;
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === "object" && value.endDate !== undefined) {
          if (value.slug && !seen.has(value.slug)) {
            seen.add(value.slug);
            scholarships.push(value);
          }
        }
        break;
      } catch {
        continue;
      }
    }
  }
  return scholarships;
}

export function toCandidate(scholarship, today) {
  const slug = scholarship.slug;
  const url = `https://bold.org/scholarships/${slug}/`;
  const donor = scholarship.donor;
  const donorName = donor && !scholarship.hideDonor
    ? [donor.firstName, donor.lastName].filter(Boolean).join(" ").trim()
    : "";
  const educationLevels = (scholarship.educationLevel || []).map((level) => String(level).replace(/^_/, ""));
  const other = [];
  if (educationLevels.length) other.push(`Education level: ${educationLevels.join(", ")}`);
  for (const item of Array.isArray(scholarship.eligibility) ? scholarship.eligibility : []) {
    if (item?.label && item?.value) other.push(`${item.label}: ${item.value}`);
  }
  const tags = CATEGORY_TAGS[scholarship.category] || [];
  const grades = educationLevels.includes("highSchool") ? ["High School Senior", "High School Junior"] : [];
  const degreeLevels = [
    ...(educationLevels.includes("undergraduate") ? ["Bachelor's Degree"] : []),
    ...(educationLevels.includes("graduate") ? ["Graduate Degree"] : []),
  ];
  return {
    id: `bold-${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`,
    title: scholarship.name || scholarship.title,
    provider: donorName || "Bold.org",
    sourceName: "Bold.org",
    sourceUrl: url,
    applicationUrl: url,
    sourceCheckedAt: today,
    deadline: typeof scholarship.endDate === "string" ? scholarship.endDate.slice(0, 10) : null,
    description: scholarship.description || "",
    award: {
      maximum: scholarship.totalAwardAmount || scholarship.fundingRequestAmount || null,
      varies: !(scholarship.totalAwardAmount || scholarship.fundingRequestAmount),
    },
    requirements: {
      essay: typeof scholarship.hasEssay === "boolean" ? scholarship.hasEssay : null,
      needBased: scholarship.category === "Need-Based" ? true : null,
      meritBased: scholarship.category === "Merit-Based" ? true : null,
      fee: false,
    },
    eligibility: {
      countries: ["US"],
      states: [],
      grades,
      degreeLevels,
      fields: [],
      minimumGpa: null,
      minimumAge: null,
      citizenship: [],
      tags,
      other,
    },
  };
}

async function fetchPage(pageNumber) {
  const url = pageNumber === 1 ? `${BASE}/` : `${BASE}/${pageNumber}/`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

export async function fetchBoldCandidates({ maxPages = MAX_PAGES, log = console.log } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const bySlug = new Map();
  const unknownCategories = new Map();
  let emptyStreak = 0;
  for (let page = 1; page <= maxPages && emptyStreak < 3; page += 1) {
    let scholarships = [];
    try {
      scholarships = extractScholarships(await fetchPage(page));
    } catch (error) {
      console.error(`page ${page}: ${error.message}`);
      emptyStreak += 1;
      continue;
    }
    let added = 0;
    for (const scholarship of scholarships) {
      if (scholarship.status && scholarship.status !== "_published") continue;
      if (!bySlug.has(scholarship.slug)) {
        bySlug.set(scholarship.slug, scholarship);
        added += 1;
        const category = scholarship.category || "(none)";
        if (!CATEGORY_TAGS[category] && category !== "(none)") {
          unknownCategories.set(category, (unknownCategories.get(category) || 0) + 1);
        }
      }
    }
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (page % 10 === 0 || added === 0) log(`page ${page}: ${added} new, ${bySlug.size} total`);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  return {
    candidates: [...bySlug.values()].map((scholarship) => toCandidate(scholarship, today)),
    unknownCategories,
  };
}

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("Usage: node scripts/ingest-bold.mjs <candidates-output.jsonl> [maxPages]");
  const { candidates, unknownCategories } = await fetchBoldCandidates({ maxPages: Number(process.argv[3]) || MAX_PAGES });
  await writeFile(outputPath, candidates.map((candidate) => `${JSON.stringify(candidate)}\n`).join(""));
  console.log(`Wrote ${candidates.length} candidates to ${outputPath}`);
  if (unknownCategories.size) {
    console.log("Unmapped categories:", JSON.stringify([...unknownCategories.entries()].sort((a, b) => b[1] - a[1])));
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/ingest-bold.mjs")) {
  await main();
}
