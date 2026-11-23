// Step 2: turn a page into clean lines of text. Menus, footers, scripts and forms are
// dropped; headings and list items are kept as "# " and "- " so structure survives.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "...", copy: "(c)", reg: "", trade: "" };

export function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/ /g, " ");
}

const dropBlocks = (html, tags) => tags.reduce((out, tag) => out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), " "), html);

export function cleanLines(html) {
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = dropBlocks(body, ["script", "style", "noscript", "svg", "template", "iframe", "select", "button"]);
  const main = body.match(/<main\b[\s\S]*<\/main>/i) || body.match(/<article\b[\s\S]*<\/article>/i);
  body = main ? main[0] : (body.match(/<body\b[\s\S]*<\/body>/i) || [body])[0];
  body = dropBlocks(body, ["nav", "header", "footer", "aside", "form"]);
  const text = body
    .replace(/<h([1-6])\b[^>]*>/gi, "\n# ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<\/?(p|div|section|article|tr|table|ul|ol|br|h[1-6]|dt|dd|blockquote|summary|details)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const seen = new Set();
  const lines = [];
  for (const raw of decodeEntities(text).split("\n")) {
    const line = raw.replace(/\s+/g, " ").replace(/^\| /, "").trim();
    if (line.replace(/^[#-] /, "").length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}
