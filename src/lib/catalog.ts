import "server-only";

import { loadFullCatalogIntoMemory } from "@/lib/directory-store";
import type { Scholarship } from "@/lib/scholarship";

export async function getScholarship(id: string): Promise<Scholarship | undefined> {
  const scholarships = await loadFullCatalogIntoMemory();
  return scholarships.find((scholarship) => scholarship.id === id);
}
