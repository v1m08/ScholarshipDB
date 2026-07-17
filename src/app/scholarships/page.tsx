import { SearchDirectory } from "@/components/SearchDirectory";
import { directoryMetadata, initialDirectory } from "@/lib/directory-initial";
import { isClosed, localDateString } from "@/lib/scholarship";
import { canUseSnapshotFallback, hasSupabaseConfig } from "@/lib/supabase/server";
import { searchPublishedScholarships } from "@/lib/supabase/search";

export const dynamic = "force-dynamic";

export default async function ScholarshipsPage() {
  const asOfDate = localDateString();
  if (!hasSupabaseConfig() && !canUseSnapshotFallback()) {
    throw new Error("Supabase is required in production.");
  }
  const initial = hasSupabaseConfig()
    ? await searchPublishedScholarships({ includeClosed: false, asOfDate, limit: 100 })
    : {
        ...initialDirectory,
        records: initialDirectory.records.filter((record) => !isClosed(record, asOfDate)),
        total: directoryMetadata.activeDirectoryCount || initialDirectory.total,
      };

  return (
    <main className="directory-page">
      <SearchDirectory initial={initial} facets={directoryMetadata.facets} asOfDate={asOfDate} />
    </main>
  );
}
