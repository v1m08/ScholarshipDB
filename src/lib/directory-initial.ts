import initialJson from "@/generated/directory-initial.json";
import metadataJson from "@/generated/metadata.json";
import type { CatalogMetadata, SearchResponse } from "@/lib/scholarship";

export const initialDirectory = initialJson as SearchResponse;
export const directoryMetadata = metadataJson as CatalogMetadata;
