import type { Metadata } from "next";
import { SearchDirectory } from "@/components/SearchDirectory";
import { directoryMetadata, initialDirectorySummary } from "@/lib/directory-initial";

export default async function ScholarshipsPage() {
  return (
    <main className="directory-page">
      <SearchDirectory initial={initialDirectorySummary} facets={directoryMetadata.facets} />
    </main>
  );
}
export const metadata: Metadata = {
  title: "Search Scholarships",
  description: "Search source-linked scholarships by eligibility, deadline, location, and award amount.",
  alternates: { canonical: "/scholarships" },
};
