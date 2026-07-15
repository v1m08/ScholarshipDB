export type BooleanUnknown = boolean | null;

export interface Scholarship {
  id: string;
  title: string;
  provider: string;
  sourceName: string;
  sourceUrl: string;
  sourceUrls?: string[];
  sourceCheckedAt: string;
  sourceMissingFields?: string[];
  tags?: string[];
  applicationUrl: string;
  opens: string | null;
  deadline: string | null;
  deadlineType?: "fixed" | "rolling" | "varies" | "unknown";
  programStatus?: "active" | "inactive" | "uncertain";
  statusReason?: string;
  description: string;
  award: {
    minimum?: number | null;
    maximum: number | null;
    varies: boolean;
    renewable?: boolean | null;
    renewableYears?: number | null;
    totalMaximum?: number | null;
    awardCount?: number | null;
    fullTuition?: boolean | null;
    fullRide?: boolean | null;
    uses?: string[];
  };
  application?: Record<string, unknown>;
  requirements: {
    essay: BooleanUnknown;
    needBased: BooleanUnknown;
    meritBased: BooleanUnknown;
    fee: BooleanUnknown;
  };
  eligibility: {
    countries: string[];
    states: string[];
    counties?: string[];
    cities?: string[];
    regions?: string[];
    grades: string[];
    degreeLevels: string[];
    fields: string[];
    minimumGpa: number | null;
    maximumGpa?: number | null;
    minimumAge: number | null;
    maximumAge?: number | null;
    citizenship: string[];
    tags: string[];
    other: string[];
    enrollmentIntensity?: "full-time" | "part-time" | "either" | "unknown";
    institutions?: string[];
    institutionDesignations?: string[];
    employers?: string[];
    unions?: string[];
    tribes?: string[];
    organizations?: string[];
    medicalConditions?: string[];
    exactCriteria?: string[];
  };
  classification?: {
    backendTags: string[];
    frontendTags: string[];
    assignments: Array<{
      tag: string;
      relationship: "eligible" | "required" | "preferred" | "descriptive";
      evidence: string;
      sourceUrl: string | null;
    }>;
  };
  institutionSpecific?: boolean;
  institutionName?: string | null;
  institutionTypes?: string[];
  searchText: string;
  variantCount?: number;
  variantIds?: string[];
  variantTitles?: string[];
  vetting?: VettingMetadata;
}

export type VettingStatus = "human" | "ai" | "unvetted";

export interface VettingMetadata {
  status: VettingStatus;
  vettedAt: string | null;
  vettedBy?: string | null;
  confidence?: number | null;
  method?: string | null;
  notes?: string | null;
  checkedUrl?: string | null;
  credibilitySignals?: string[];
  missingFields?: string[];
}

export interface CatalogMetadata {
  count: number;
  directoryCount?: number;
  activeDirectoryCount?: number;
  directoryPageSize?: number;
  directoryPageCount?: number;
  searchShardSize?: number;
  searchShardCount?: number;
  discoveredCount: number;
  bigFutureDiscoveredCount: number;
  generatedOn: string;
  sourceCount: number;
  facets: {
    grades: string[];
    tags: string[];
    tagOptions?: string[];
    states: string[];
  };
}

export interface SearchResponse {
  records: Scholarship[];
  total: number;
  rawTotal?: number;
  page: number;
  limit: number;
  hasMore?: boolean;
  nextCursor?: string;
}

export function formatMoney(amount: number | null, varies = false): string {
  if (varies) return "Varies";
  if (amount === null) return "Amount not published";
  return `Up to $${amount.toLocaleString("en-US")}`;
}

export function formatDate(value: string | null): string {
  if (!value) return "No deadline published";
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function isClosed(scholarship: Scholarship, asOfDate: string): boolean {
  if (!scholarship.deadline) return false;
  return dateOnly(scholarship.deadline) < dateOnly(asOfDate);
}

export function yesNoUnknown(value: BooleanUnknown): string {
  if (value === null) return "Not published";
  return value ? "Yes" : "No";
}

export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function effectiveVetting(scholarship: Scholarship): VettingMetadata {
  return scholarship.vetting || { status: "unvetted", vettedAt: null };
}

export function sourceMissingFields(scholarship: Scholarship): string[] {
  const fields: string[] = [];
  if (scholarship.award.maximum === null && !scholarship.award.varies) fields.push("award amount");
  if (!scholarship.deadline) fields.push("deadline");
  if (!scholarship.eligibility.grades.length) fields.push("eligible grade levels");
  if (!scholarship.eligibility.fields.length) fields.push("eligible fields of study");
  if (scholarship.eligibility.minimumGpa === null) fields.push("minimum GPA");
  if (scholarship.requirements.essay === null) fields.push("essay requirement");
  if (scholarship.requirements.needBased === null) fields.push("need-based status");
  if (scholarship.requirements.meritBased === null) fields.push("merit-based status");
  return [...new Set([...(scholarship.sourceMissingFields || []), ...fields])];
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}
