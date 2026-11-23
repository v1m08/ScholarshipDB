// Read a site's robots.txt and answer "may we fetch this path?". Our crawler obeys the
// group written for its own name if there is one, otherwise the group for everyone ("*").
const BOT_NAME = "scholarship-directory-bot";

const toPattern = (rule) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      // Several user-agent lines in a row share the rules that follow.
      if (!lastWasAgent) { current = { agents: [], rules: [], crawlDelay: 0 }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "disallow" && value) current.rules.push({ allow: false, path: value });
    else if (field === "allow" && value) current.rules.push({ allow: true, path: value });
    else if (field === "crawl-delay") current.crawlDelay = Number(value) || 0;
  }
  const mine = groups.filter((group) => group.agents.some((agent) => agent !== "*" && BOT_NAME.includes(agent)));
  const chosen = mine.length ? mine : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  return {
    crawlDelay: Math.max(0, ...chosen.map((group) => group.crawlDelay)),
    // The longest matching rule wins; a tie goes to "allow".
    allowed(path) {
      let best = null;
      for (const rule of rules) {
        if (!toPattern(rule.path).test(path)) continue;
        if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
      }
      return !best || best.allow;
    },
  };
}
