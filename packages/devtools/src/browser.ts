import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * One lazily launched headless Chromium shared by preview and scenarios.
 * Each caller gets its own context so cookies and storage never leak
 * between runs.
 */
export class BrowserPool {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;

  async page(opts: { viewport?: { width: number; height: number }; dark?: boolean } = {}): Promise<{ page: Page; context: BrowserContext }> {
    const browser = await this.get();
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      colorScheme: opts.dark ? "dark" : "light",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    return { page, context };
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.launching = undefined;
    await b?.close().catch(() => {});
  }

  private get(): Promise<Browser> {
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);
    this.launching ??= launch().then((b) => {
      this.browser = b;
      b.on("disconnected", () => {
        if (this.browser === b) this.browser = undefined;
        this.launching = undefined;
      });
      return b;
    }).catch((e) => {
      this.launching = undefined;
      throw e;
    });
    return this.launching;
  }
}

export function chromiumPath(): string | undefined {
  const candidates = [process.env.ORCHIDERY_CHROMIUM, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, "/opt/pw-browsers/chromium"].filter(
    (p): p is string => !!p,
  );
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const p = chromium.executablePath();
    if (existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return undefined;
}

async function launch(): Promise<Browser> {
  const executablePath = chromiumPath();
  try {
    return await chromium.launch({ executablePath, headless: true });
  } catch (e) {
    throw new Error(
      `Could not launch Chromium for preview: ${(e as Error).message}\n` +
        `Install it with \`npx playwright-core install chromium\` or set ORCHIDERY_CHROMIUM to a Chrome/Chromium binary.`,
    );
  }
}
