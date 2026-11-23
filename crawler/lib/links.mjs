// The links list: one entry per scholarship, pointing at the page it is officially
// published on. Sources only say that a scholarship exists and where; every detail is
// later read from that page. The same scholarship found through several sources is one
// entry whose foundVia lists them all. `id` is the normalized address used for matching;
// `url` is the address exactly as the source gave it, which is the one to fetch.
const slug = (text) => (text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function normalizeUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.protocol = "https:";
  parsed.host = parsed.host.toLowerCase().replace(/^www\./, "");
  for (const name of [...parsed.searchParams.keys()]) if (/^(utm_.*|fbclid|gclid|ref|source)$/i.test(name)) parsed.searchParams.delete(name);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\?$/, "");
}

// An entry with no address yet (a name taken from an aggregator) is keyed by provider and name.
// Listing sites often give one provider page for several scholarships (a foundation's
// "scholarships" page), so those entries are keyed by address and name together.
export const keyOf = (entry) => {
  if (!entry.url) return `lead:${slug(entry.provider)}:${slug(entry.name)}`;
  return entry.sharedPage ? `${normalizeUrl(entry.url)}#${slug(entry.name)}` : normalizeUrl(entry.url);
};

export function mergeLinks(existing, incoming) {
  const byKey = new Map();
  // A lead that later gains an address is matched by provider and name as well.
  const byName = new Map();
  const nameKey = (entry) => (entry.provider && entry.name ? `${slug(entry.provider)}:${slug(entry.name)}` : null);
  const put = (entry) => {
    const key = keyOf(entry);
    const named = nameKey(entry);
    let current = byKey.get(key) || (named && byName.get(named));
    if (!current) {
      current = { id: key, url: entry.url || null, name: entry.name || null, provider: entry.provider || null, foundVia: [], status: entry.url ? "not-scraped" : "needs-url" };
      byKey.set(key, current);
    } else if (!current.url && entry.url) {
      // The lead now has an address: re-key it and make it scrapable.
      byKey.delete(current.id);
      current.url = entry.url;
      if (entry.sharedPage) current.sharedPage = true;
      current.id = keyOf(current);
      current.status = "not-scraped";
      byKey.set(current.id, current);
    }
    if (named) byName.set(named, current);
    current.name ||= entry.name || null;
    current.provider ||= entry.provider || null;
    for (const source of entry.foundVia || []) if (!current.foundVia.includes(source)) current.foundVia.push(source);
    // Progress made by earlier runs is kept.
    if (entry.status && !["not-scraped", "needs-url"].includes(entry.status)) current.status = entry.status;
    for (const field of ["platform", "unitids", "external", "hints", "sharedPage"]) if (entry[field] !== undefined && current[field] === undefined) current[field] = entry[field];
  };
  for (const entry of existing) put(entry);
  for (const entry of incoming) put(entry);
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
}
