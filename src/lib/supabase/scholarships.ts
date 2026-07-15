import type { Scholarship } from "@/lib/scholarship";
import { normalizeScholarshipFacets } from "@/lib/facets";

interface ScholarshipRow {
  id: string;
  title: string;
  provider: string;
  source_name: string;
  source_url: string;
  source_urls?: string[];
  source_checked_at: string;
  source_missing_fields?: string[];
  application_url: string;
  opens: string | null;
  deadline: string | null;
  description: string;
  award: Scholarship["award"];
  requirements: Scholarship["requirements"];
  eligibility: Scholarship["eligibility"];
  institution_specific?: boolean;
  institution_name?: string | null;
  institution_types?: string[];
  search_text: string;
  vetting?: Scholarship["vetting"];
}

export function fromRow(row: ScholarshipRow): Scholarship {
  return normalizeScholarshipFacets({
    id: row.id,
    title: row.title,
    provider: row.provider,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceUrls: row.source_urls || [row.source_url],
    sourceCheckedAt: row.source_checked_at,
    sourceMissingFields: row.source_missing_fields || [],
    applicationUrl: row.application_url,
    opens: row.opens,
    deadline: row.deadline,
    description: row.description,
    award: row.award,
    requirements: row.requirements,
    eligibility: row.eligibility,
    institutionSpecific: row.institution_specific || false,
    institutionName: row.institution_name || null,
    institutionTypes: row.institution_types || [],
    searchText: row.search_text,
    vetting: row.vetting,
  });
}
