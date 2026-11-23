// AcademicWorks (Blackbaud Award Management) portals list awards in one table layout:
// amount cell, title link (/opportunities/{id}), then a deadline or "Ended" cell.
const decode = (text) => text
  .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export function parseListingPage(html, host) {
  const rows = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const link = row.match(/<a href="(\/opportunities\/\d+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => decode(match[1].replace(/<[^>]+>/g, " ")));
    rows.push({
      host,
      url: `https://${host}${link[1]}`,
      title: decode(link[2].replace(/<[^>]+>/g, " ")),
      amountText: cells[0] || null,
      statusText: cells.at(-1) || null,
    });
  }
  return rows;
}
