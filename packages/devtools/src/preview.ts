import { emit, loadProgram, parse, readSources, type Document, type ProjectConfig } from "@orchidery/core";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";
import type { BrowserPool } from "./browser.js";
import type { Store } from "./store.js";

export interface PreviewRequest {
  /** Route path to open, e.g. `/todos/b2`. */
  route?: string;
  /** A .orchid document to preview without saving. Its first page is rendered. */
  source?: string;
  viewport?: { width: number; height: number };
  dark?: boolean;
  /** Take the whole page rather than the viewport. Default false. */
  fullPage?: boolean;
  /** Run axe-core. Default true. */
  a11y?: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface A11yViolation {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodes: { target: string[]; address?: string; summary: string }[];
}

export interface PreviewResult {
  url: string;
  /** PNG, base64. */
  screenshot: string;
  html: string;
  title: string;
  /** Address -> viewport box for every stamped element that rendered. */
  boxes: Record<string, Box>;
  /** Console errors and page errors captured while loading. */
  errors: string[];
  a11y?: { violations: A11yViolation[]; passes: number };
}

export interface PreviewDeps {
  pool: BrowserPool;
  store: Store;
  root: string;
  config: ProjectConfig;
  /** Base URL of the running Next.js dev server. */
  appUrl: string;
}

/** Render a route (or an unsaved source) in headless Chromium and describe what came back. */
export async function preview(req: PreviewRequest, deps: PreviewDeps): Promise<PreviewResult> {
  let route = req.route ?? "/";
  let cleanup: (() => void) | undefined;
  if (req.source) {
    const tmp = writeTempRoute(req.source, deps);
    route = tmp.route;
    cleanup = tmp.cleanup;
  }
  try {
    const url = new URL(route, deps.appUrl).toString();
    const { page, context } = await deps.pool.page({ viewport: req.viewport, dark: req.dark });
    try {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        // Resource failures are reported with their URL from the response hook instead.
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
      });
      page.on("response", (r) => {
        if (r.status() >= 400 && !/\/favicon\.ico$/.test(r.url()) && r.url() !== url) errors.push(`${r.status()} ${r.url()}`);
      });
      await gotoWhenReady(page, url);
      await hideOverlay(page);
      const map = deps.store.readMap();
      const boxes = await collectBoxes(page, map);
      const screenshot = (await page.screenshot({ type: "png", fullPage: req.fullPage ?? false })).toString("base64");
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const title = await page.title();
      const result: PreviewResult = { url, screenshot, html, title, boxes, errors };
      if (req.a11y !== false) result.a11y = await runAxe(page, map);
      return result;
    } finally {
      await context.close();
    }
  } finally {
    cleanup?.();
  }
}

/**
 * Navigate, retrying while the dev server answers 404: a route written moments
 * ago (a source preview, or a page just grafted in) takes Next a beat to pick up.
 */
async function gotoWhenReady(page: Page, url: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    const status = res?.status() ?? 0;
    if (status !== 404 || Date.now() > deadline) {
      if (status === 404) throw new Error(`${url} still returns 404 after ${Math.round(timeoutMs / 1000)}s`);
      return;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function hideOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector("orchidery-devtools");
    if (el instanceof HTMLElement) el.style.display = "none";
  });
}

export async function collectBoxes(page: Page, map: Record<string, { address: string }>): Promise<Record<string, Box>> {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll("[data-orchid]")].map((el) => {
      let r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0 && el.children.length) {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const c of el.children) {
          const b = c.getBoundingClientRect();
          if (!b.width && !b.height) continue;
          x1 = Math.min(x1, b.left); y1 = Math.min(y1, b.top); x2 = Math.max(x2, b.right); y2 = Math.max(y2, b.bottom);
        }
        if (x1 !== Infinity) r = new DOMRect(x1, y1, x2 - x1, y2 - y1);
      }
      return { stamp: el.getAttribute("data-orchid") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
  const boxes: Record<string, Box> = {};
  for (const b of raw) {
    const address = map[b.stamp]?.address;
    if (address && !(address in boxes)) boxes[address] = { x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) };
  }
  return boxes;
}

const round = (n: number) => Math.round(n * 10) / 10;

async function runAxe(page: Page, map: Record<string, { address: string }>): Promise<{ violations: A11yViolation[]; passes: number }> {
  const require = createRequire(import.meta.url);
  const axePath = require.resolve("axe-core/axe.min.js");
  await page.addScriptTag({ content: readFileSync(axePath, "utf8") });
  const results = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
    return axe.run(document, { resultTypes: ["violations", "passes"], exclude: [["orchidery-devtools"]] });
  })) as {
    violations: { id: string; impact: string; help: string; helpUrl: string; nodes: { target: string[]; failureSummary?: string }[] }[];
    passes: unknown[];
  };
  const violations: A11yViolation[] = [];
  for (const v of results.violations) {
    const nodes = [];
    for (const n of v.nodes) {
      const sel = n.target.join(" ");
      const address = await page
        .evaluate((s) => {
          try {
            const el = document.querySelector(s);
            const st = el?.closest("[data-orchid]")?.getAttribute("data-orchid");
            return st ?? undefined;
          } catch {
            return undefined;
          }
        }, sel)
        .then((stamp) => (stamp ? map[stamp]?.address : undefined))
        .catch(() => undefined);
      nodes.push({ target: n.target, address, summary: n.failureSummary ?? "" });
    }
    violations.push({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes });
  }
  return { violations, passes: results.passes.length };
}

/**
 * Compile an unsaved document's first page under a throwaway route so Next
 * can serve it, and return how to remove it again.
 */
function writeTempRoute(source: string, deps: PreviewDeps): { route: string; cleanup: () => void } {
  const id = Math.random().toString(36).slice(2, 8);
  const route = `/orchidery-preview/${id}`;
  const doc: Document = parse(source, { file: `<preview ${id}>` });
  const page = doc.items.find((i) => i.kind === "page");
  if (!page) throw new Error("Preview source needs a `page` declaration");
  page.route = route;
  doc.items = doc.items.filter((i) => i.kind !== "page" || i === page);
  const { program, diagnostics } = loadProgram(readSources(deps.root, deps.config.src));
  if (diagnostics.length) throw new Error(`Project has parse errors: ${diagnostics.map((d) => d.message).join("; ")}`);
  program.documents.push(doc);
  const r = emit(program, { dev: true, devtoolsUrl: deps.config.devtoolsUrl });
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(`Preview source is invalid: ${errors.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  const prefix = `orchidery-preview/${id}/`;
  const dir = join(deps.root, deps.config.out, "orchidery-preview", id);
  for (const [rel, content] of Object.entries(r.files)) {
    if (!rel.startsWith(prefix)) continue;
    const abs = join(deps.root, deps.config.out, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  // Merge the preview's stamps into the map so boxes resolve.
  const map = deps.store.readMap();
  for (const [stamp, entry] of Object.entries(r.map)) if (entry.address.startsWith(`page:${route}`)) map[stamp] = entry;
  deps.store.writeMap(map);
  return {
    route,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      const parent = dirname(dir);
      try {
        if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const m = deps.store.readMap();
      for (const [stamp, entry] of Object.entries(m)) if (entry.address.startsWith(`page:${route}`)) delete m[stamp];
      deps.store.writeMap(m);
    },
  };
}
