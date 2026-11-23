// Find which institutions have a public portal on each scholarship platform by testing
// candidate addresses built from the institution's own web domain (ucsd.edu -> "ucsd").
// DNS platforms are checked by name lookup only; AcademicWorks needs one HTTP request
// because unknown names redirect to the vendor's marketing site.
// Usage: npm run portal-scan [-- --limit 200]
import { resolve4 } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = join(root, "data", "registry");
const USER_AGENT = "Mozilla/5.0 (compatible; scholarship-directory-bot/1.0)";

const DNS_PLATFORMS = {
  scholarshipuniverse: (slug) => `${slug}.scholarshipuniverse.com`,
  awardspring: (slug) => `${slug}.awardspring.com`,
  communityforce: (slug) => `${slug}.communityforce.com`,
  stars: (slug) => `${slug}.starsscholarshiponline.com`,
};

// "www.cc.peralta.edu" -> ["peralta", "cc"]; the label before the suffix is the usual portal name.
export function candidateSlugs(domain) {
  if (!domain) return [];
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return [];
  const main = labels.at(-2);
  const slugs = [main];
  if (labels.length > 2 && labels[0] !== main && labels[0].length > 2) slugs.push(labels[0]);
  return [...new Set(slugs)].filter((slug) => /^[a-z0-9-]{2,}$/.test(slug));
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function resolves(host) {
  try { return (await resolve4(host)).length > 0; } catch { return false; }
}

async function academicWorksLive(slug) {
  const host = `${slug}.academicworks.com`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`https://${host}/opportunities`, {
        headers: { "user-agent": USER_AGENT }, redirect: "manual", signal: AbortSignal.timeout(15000),
      });
      const location = response.headers.get("location") || "";
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) return location.includes("academicworks.com");
      return response.status === 200;
    } catch { /* retry once */ }
  }
  return null;
}

async function main() {
  const limitIndex = process.argv.indexOf("--limit");
  const { institutions } = JSON.parse(await readFile(join(registry, "institutions.json"), "utf8"));
  const list = limitIndex >= 0 ? institutions.slice(0, Number(process.argv[limitIndex + 1])) : institutions;

  const bySlug = new Map();
  for (const institution of list) {
    for (const slug of candidateSlugs(institution.domain)) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(institution.unitid);
    }
  }
  const slugs = [...bySlug.keys()];
  console.log(`${list.length} institutions, ${slugs.length} candidate names`);

  const portals = [];
  const add = (platform, slug, host) => portals.push({
    platform, host, url: `https://${host}/`, slug, unitids: bySlug.get(slug), matchedBy: "domain-label", foundAt: new Date().toISOString().slice(0, 10),
  });

  for (const [platform, hostFor] of Object.entries(DNS_PLATFORMS)) {
    let found = 0;
    await pool(slugs, 40, async (slug) => {
      if (await resolves(hostFor(slug))) { add(platform, slug, hostFor(slug)); found += 1; }
    });
    console.log(`${platform}: ${found}`);
  }

  let found = 0; let errors = 0; let done = 0;
  await pool(slugs, 6, async (slug) => {
    const live = await academicWorksLive(slug);
    if (live) { add("academicworks", slug, `${slug}.academicworks.com`); found += 1; }
    if (live === null) errors += 1;
    if (++done % 1000 === 0) console.log(`  academicworks ${done}/${slugs.length} (${found} found)`);
  });
  console.log(`academicworks: ${found} (${errors} unreachable)`);

  portals.sort((a, b) => a.platform.localeCompare(b.platform) || a.slug.localeCompare(b.slug));
  await writeFile(join(registry, "portals.json"), JSON.stringify({ scannedInstitutions: list.length, candidateNames: slugs.length, count: portals.length, portals }, null, 1) + "\n");
  console.log(`Wrote ${portals.length} portals to data/registry/portals.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
