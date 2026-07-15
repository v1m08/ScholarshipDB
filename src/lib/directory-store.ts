import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scholarship } from "@/lib/scholarship";

let fullCatalogPromise: Promise<Scholarship[]> | null = null;

export function loadFullCatalogIntoMemory(): Promise<Scholarship[]> {
  if (!fullCatalogPromise) {
    fullCatalogPromise = readFile(
      join(process.cwd(), "src", "generated", "catalog.json"),
      "utf8",
    )
      .then((contents) => JSON.parse(contents) as Scholarship[])
      .catch((error) => {
        fullCatalogPromise = null;
        throw error;
      });
  }
  return fullCatalogPromise;
}
