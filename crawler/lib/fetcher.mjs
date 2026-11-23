// Fetch a page as cheaply as possible: plain HTTP first, a headless browser only when
// the page is a JavaScript shell or the caller asks for rendering.
export const USER_AGENT = "Mozilla/5.0 (compatible; scholarship-directory-bot/1.0)";
const SHELL_TEXT_LIMIT = 400;

export function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? visibleText(match[1]).slice(0, 200) : "";
}

async function plainFetch(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, finalUrl: response.url, html: await response.text() };
}

let browserPromise = null;
let browserUnavailable = null;

async function getBrowser() {
  if (browserUnavailable) throw browserUnavailable;
  if (!browserPromise) {
    browserPromise = import("playwright")
      .then(({ chromium }) => chromium.launch({ headless: true }))
      .catch((error) => {
        browserUnavailable = new Error(`Headless browser unavailable: ${error.message.split("\n")[0]}`);
        browserPromise = null;
        throw browserUnavailable;
      });
  }
  return browserPromise;
}

async function browserFetch(url, timeoutMs) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  // Images, fonts and media are never needed for text extraction.
  await context.route("**/*", (route) => (
    ["image", "media", "font"].includes(route.request().resourceType()) ? route.abort() : route.continue()
  ));
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
    return { status: response?.status() ?? 0, finalUrl: page.url(), html: await page.content() };
  } finally {
    await context.close();
  }
}

// render: "auto" renders only when the plain response looks like an empty shell;
// "always" skips the plain request; "never" forbids the browser.
export async function fetchPage(url, { render = "auto", timeoutMs = 25000 } = {}) {
  const started = Date.now();
  let result = null;
  let method = "http";
  let renderError = null;
  if (render !== "always") {
    result = await plainFetch(url, timeoutMs);
  }
  const looksLikeShell = result && result.status < 400 && visibleText(result.html).length < SHELL_TEXT_LIMIT;
  if (render === "always" || (render === "auto" && looksLikeShell)) {
    try {
      result = await browserFetch(url, timeoutMs);
      method = "browser";
    } catch (error) {
      renderError = error.message.split("\n")[0];
      if (!result) throw error;
    }
  }
  return { ...result, method, renderError, elapsedMs: Date.now() - started };
}

export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close().catch(() => {});
  browserPromise = null;
}

// Run workers over items with a global concurrency cap and a minimum gap between
// requests to the same key (usually the registrable domain), so no vendor is hammered.
export async function politePool(items, { concurrency, keyOf, gapMs }, worker) {
  const nextAllowed = new Map();
  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const item = items[index++];
      const key = keyOf(item);
      const wait = Math.max(0, (nextAllowed.get(key) || 0) - Date.now());
      nextAllowed.set(key, Date.now() + wait + gapMs);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      await worker(item);
    }
  }));
}
