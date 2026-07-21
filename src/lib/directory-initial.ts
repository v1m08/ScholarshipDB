import initialJson from "@/generated/directory-initial.json";
import summaryJson from "@/generated/directory-summary.json";
import metadataJson from "@/generated/metadata.json";
import type { CatalogMetadata, SearchResponse, SearchSummaryResponse } from "@/lib/scholarship";

export const initialDirectory = initialJson as SearchResponse;
export const initialDirectorySummary = summaryJson as SearchSummaryResponse;
export const directoryMetadata = metadataJson as CatalogMetadata;
