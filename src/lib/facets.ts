import type { Scholarship } from "@/lib/scholarship";

export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

const TAG_ALIASES: Record<string, string> = {
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

const GRADE_ALIASES: Record<string, string[]> = {
  "k-8": ["Kindergarten", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Grade 8"],
  k: ["Kindergarten"],
  kindergarten: ["Kindergarten"],
  "high-school": ["High School Student"],
  "high-school-student": ["High School Student"],
  "high-school-freshman": ["High School Freshman"],
  "high-school-sophomore": ["High School Sophomore"],
  "high-school-junior": ["High School Junior"],
  "high-school-senior": ["High School Senior"],
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
] as const;

function facetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function canonicalGrades(value: string): string[] {
  const normalized = facetKey(value);
  if (!normalized) return [];
  if (GRADE_ALIASES[normalized]) return GRADE_ALIASES[normalized];

  const range = normalized.match(/^(?:grades?-?)?(\d{1,2})-(\d{1,2})$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end <= 12 && start <= end) {
      return [...new Set(Array.from({ length: end - start + 1 }, (_, index) => canonicalSchoolGrade(start + index)))];
    }
  }

  const numeric = normalized.match(/^(?:grade-)?(\d{1,2})(?:st|nd|rd|th)?(?:-grade)?$/);
  if (numeric) {
    const grade = Number(numeric[1]);
    if (grade >= 1 && grade <= 12) return [canonicalSchoolGrade(grade)];
  }

  const grouped = normalized.match(/^grades?-(\d{1,2}(?:-\d{1,2})+)$/);
  if (grouped) {
    return [...new Set(grouped[1].split("-").map(Number)
      .filter((grade) => grade >= 1 && grade <= 12)
      .map(canonicalSchoolGrade))];
  }
  return [];
}

export function gradeFilterMatches(recordGrades: string[], filter: string): boolean {
  const accepted = canonicalGrades(filter);
  return accepted.length > 0 && recordGrades.some((grade) => accepted.includes(grade));
}

function canonicalSchoolGrade(grade: number): string {
  if (grade === 9) return "High School Freshman";
  if (grade === 10) return "High School Sophomore";
  if (grade === 11) return "High School Junior";
  if (grade === 12) return "High School Senior";
  return `Grade ${grade}`;
}

export function canonicalTag(value: string): string {
  const normalized = facetKey(value);
  return TAG_ALIASES[normalized] || normalized;
}

export function normalizeScholarshipFacets(record: Scholarship): Scholarship {
  const tags = [...new Set((record.tags ?? record.eligibility.tags).map(canonicalTag).filter(Boolean))];
  const grades = [...new Set(record.eligibility.grades.flatMap(canonicalGrades))];
  const states = [...new Set(
    record.eligibility.states
      .map((state) => state.trim().toUpperCase())
      .filter((state) => state in US_STATE_NAMES),
  )];
  const eligibility = { ...record.eligibility, grades, states, tags };
  return {
    ...record,
    tags,
    eligibility,
    searchText: [
      record.title,
      record.provider,
      record.description,
      ...eligibility.countries,
      ...states,
      ...eligibility.grades,
      ...eligibility.degreeLevels,
      ...eligibility.fields,
      ...tags,
      ...eligibility.other,
      record.institutionName || "",
      ...(record.institutionTypes || []),
    ].join(" ").toLowerCase().replace(/\s+/g, " ").trim(),
  };
}
