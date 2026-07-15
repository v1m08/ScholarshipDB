const US_STATES = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

export const ALL_US_STATE_CODES = Object.values(US_STATES);

const US_CODES = new Set(ALL_US_STATE_CODES);
const STATE_NAMES = Object.entries(US_STATES).sort(
  ([left], [right]) => right.length - left.length,
);

const TAG_ALIASES = {
  "adult-learner": "adult-learners",
  black: "black-students",
  "black-student": "black-students",
  "cancer-survivor": "cancer-affected",
  "cancer-survivors": "cancer-affected",
  "community-involvement": "community-service",
  disabled: "disability",
  "future-teacher": "future-teachers",
  "income-limited": "financial-need",
  "low-income": "financial-need",
  "low-income-preference": "financial-need",
  "latino-health": "healthcare",
  "need-based": "financial-need",
  nurse: "nursing",
  "stem-fields": "stem",
  "underrepresented-minority": "underrepresented",
  drawing: "arts",
  bipoc: "underrepresented",
  entrepreneur: "business",
  "future-teachers": "education",
  hbcu: "underrepresented",
  woman: "women",
};

const GRADE_ALIASES = {
  "k-8": ["Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Grade 8"],
  k: ["Kindergarten"],
  kindergarten: ["Kindergarten"],
  "high-school": ["High School Student"],
  "high-school-student": ["High School Student"],
  "high-school-senior": "High School Senior",
  "high-school-junior": "High School Junior",
  "high-school-sophomore": "High School Sophomore",
  "high-school-freshman": "High School Freshman",
  freshman: ["College Freshman"],
  "incoming-freshman": ["College Freshman"],
  "college-freshman": ["College Freshman"],
  "college-freshman-attended-college-previously": ["College Freshman"],
  sophomore: ["College Sophomore"],
  "college-sophomore": ["College Sophomore"],
  junior: ["College Junior"],
  "college-junior": ["College Junior"],
  senior: ["College Senior"],
  "college-senior": ["College Senior"],
  college: ["Undergraduate"],
  "college-student": ["Undergraduate"],
  undergraduate: ["Undergraduate"],
  "undergraduate-student": ["Undergraduate"],
  "5th-year-college-undergraduate": ["Undergraduate"],
  "nth-year-college-undergraduate": ["Undergraduate"],
  "post-secondary-student": ["Undergraduate"],
  "postsecondary-student": ["Undergraduate"],
  graduate: ["Graduate Student"],
  "graduate-student": ["Graduate Student"],
  doctoral: ["Doctoral Student"],
  "doctoral-student": ["Doctoral Student"],
  "doctoral-candidate": ["Doctoral Student"],
  phd: ["Doctoral Student"],
  "ph-d": ["Doctoral Student"],
  "community-college-freshman": ["Community College Student"],
  "community-college-freshman-attended-college-previously": ["Community College Student"],
  "community-college-sophomore": ["Community College Student"],
  "community-college-student": ["Community College Student"],
  "vocational-student": ["Vocational or Trade Student"],
  "vocational-or-trade-student": ["Vocational or Trade Student"],
  "law-student": ["Law Student"],
  "postgraduate-law-school": ["Law Student"],
  "medical-student": ["Medical Student"],
  "postgraduate-medical-school": ["Medical Student"],
  "high-school-graduate": ["High School Graduate"],
  "not-enrolled": ["Not Currently Enrolled"],
  "not-currently-enrolled": ["Not Currently Enrolled"],
  "on-academic-break": ["Not Currently Enrolled"],
};

export const CANONICAL_GRADES = [
  "Kindergarten",
  "Grade 1",
  "Grade 2",
  "Grade 3",
  "Grade 4",
  "Grade 5",
  "Grade 6",
  "Grade 7",
  "Grade 8",
  "High School Freshman",
  "High School Sophomore",
  "High School Junior",
  "High School Senior",
  "High School Graduate",
  "High School Student",
  "College Freshman",
  "College Sophomore",
  "College Junior",
  "College Senior",
  "Undergraduate",
  "Community College Student",
  "Vocational or Trade Student",
  "Graduate Student",
  "Doctoral Student",
  "Law Student",
  "Medical Student",
  "Not Currently Enrolled",
];

function key(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeStates(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  const lowered = raw.toLowerCase().replace(/[._-]+/g, " ");
  if (
    /\bdistrict of columbia\b/.test(lowered) ||
    /\bwashington\s+d\.?\s*c\.?\b/.test(lowered)
  ) {
    return [];
  }

  const uppercase = raw.toUpperCase();
  if (US_CODES.has(uppercase)) return [uppercase];

  const matches = [];
  for (const [name, code] of STATE_NAMES) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    if (pattern.test(lowered)) matches.push(code);
  }
  return unique(matches);
}

export function normalizeTag(value) {
  const normalized = key(value);
  return TAG_ALIASES[normalized] || normalized || null;
}

export function normalizeGrades(value) {
  const normalized = key(value);
  if (!normalized) return [];
  if (GRADE_ALIASES[normalized]) {
    return Array.isArray(GRADE_ALIASES[normalized])
      ? GRADE_ALIASES[normalized]
      : [GRADE_ALIASES[normalized]];
  }

  const range = normalized.match(/^(?:grades?-?)?(\d{1,2})-(\d{1,2})$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end <= 12 && start <= end) {
      return unique(Array.from({ length: end - start + 1 }, (_, index) => canonicalSchoolGrade(start + index)));
    }
  }

  const numeric = normalized.match(/^(?:grade-)?(\d{1,2})(?:st|nd|rd|th)?(?:-grade)?$/);
  if (numeric) {
    const grade = Number(numeric[1]);
    if (grade >= 1 && grade <= 12) return [canonicalSchoolGrade(grade)];
  }

  const grouped = normalized.match(/^grades?-(\d{1,2}(?:-\d{1,2})+)$/);
  if (grouped) {
    return unique(grouped[1].split("-").map(Number).filter((grade) => grade >= 1 && grade <= 12).map(canonicalSchoolGrade));
  }

  return [];
}

function canonicalSchoolGrade(grade) {
  if (grade === 9) return "High School Freshman";
  if (grade === 10) return "High School Sophomore";
  if (grade === 11) return "High School Junior";
  if (grade === 12) return "High School Senior";
  return `Grade ${grade}`;
}

function normalizeInstitutionTypes(values) {
  return unique(
    (values || []).map((value) => {
      const normalized = key(value);
      if (normalized === "two-year") return "Two-year";
      if (normalized === "four-year") return "Four-year";
      if (normalized === "vocational") return "Vocational";
      return String(value || "").trim();
    }),
  );
}

export function normalizeRecord(record) {
  const eligibility = record.eligibility || {};
  const normalizedTags = unique((eligibility.tags || record.tags || []).map(normalizeTag));
  const normalized = {
    ...record,
    tags: record.tags ? unique(record.tags.map(normalizeTag)) : undefined,
    eligibility: {
      ...eligibility,
      grades: unique((eligibility.grades || []).flatMap(normalizeGrades)),
      states: unique((eligibility.states || []).flatMap(normalizeStates)),
      countries: unique(
        (eligibility.countries || []).map((value) =>
          String(value || "").trim().toUpperCase(),
        ),
      ),
      tags: normalizedTags,
    },
    institutionTypes: normalizeInstitutionTypes(record.institutionTypes),
  };

  normalized.searchText = [
    normalized.title,
    normalized.provider,
    normalized.summary,
    normalized.description,
    normalized.eligibility.grades.join(" "),
    normalized.eligibility.states.join(" "),
    normalized.eligibility.tags.join(" "),
    normalized.institutionTypes.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return normalized;
}

export function assertV4TagShape(record, allowedTags = null) {
  if (!record.classification) return;
  const backendTags = record.classification.backendTags || [];
  const frontendTags = record.classification.frontendTags || [];
  const tags = record.tags || [];
  const eligibilityTags = record.eligibility?.tags || [];
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(tags, frontendTags) || !same(eligibilityTags, frontendTags)) {
    throw new Error(`${record.id}: v4 tag aliases diverged`);
  }
  for (const tag of frontendTags) {
    if (!backendTags.includes(tag)) {
      throw new Error(`${record.id}: frontend tag ${tag} missing from backendTags`);
    }
  }
  if (allowedTags) {
    for (const tag of [...backendTags, ...frontendTags, ...tags, ...eligibilityTags]) {
      if (!allowedTags.has(tag)) throw new Error(`${record.id}: unknown tag ${tag}`);
    }
  }
}
