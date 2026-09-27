import { loadProgram, readSources, type ProjectConfig, type ScenarioDecl, type ScenarioStep } from "@orchidery/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import type { BrowserPool } from "./browser.js";
import type { Store } from "./store.js";
import type { AddressMap } from "./types.js";

export interface StepResult {
  index: number;
  step: string;
  ok: boolean;
  error?: string;
  /** Path of a screenshot taken by a `screenshot` step or on failure. */
  screenshot?: string;
  ms: number;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  steps: StepResult[];
  ms: number;
}

export interface ScenarioDeps {
  pool: BrowserPool;
  store: Store;
  root: string;
  config: ProjectConfig;
  appUrl: string;
  /** Per-step timeout in ms. Default 10000. */
  timeout?: number;
}

/** Find scenarios in the project by name, or all of them. */
export function loadScenarios(root: string, config: ProjectConfig, name?: string): ScenarioDecl[] {
  const { program, diagnostics } = loadProgram(readSources(root, config.src));
  if (diagnostics.length) throw new Error(`Project has parse errors: ${diagnostics.map((d) => d.message).join("; ")}`);
  const all = program.documents.flatMap((d) => d.items.filter((i): i is ScenarioDecl => i.kind === "scenario"));
  if (!name) return all;
  const wanted = name.startsWith("scenario:") ? name.slice("scenario:".length).trim() : name;
  const found = all.filter((s) => s.name === wanted);
  if (!found.length) throw new Error(`No scenario named \`${wanted}\`. Available: ${all.map((s) => s.name).join(", ") || "(none)"}`);
  return found;
}

export async function runScenario(scenario: ScenarioDecl, deps: ScenarioDeps): Promise<ScenarioResult> {
  const started = Date.now();
  const { page, context } = await deps.pool.page();
  const timeout = deps.timeout ?? 10_000;
  const map = deps.store.readMap();
  const shotsDir = join(deps.root, ".orchidery", "scenarios", slug(scenario.name));
  mkdirSync(shotsDir, { recursive: true });
  const steps: StepResult[] = [];
  let currentRoot: string | undefined;
  let ok = true;
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      const t0 = Date.now();
      const label = describe(step);
      try {
        const r = await runStep(step, { page, map, timeout, shotsDir, appUrl: deps.appUrl, currentRoot: () => currentRoot, setRoot: (r) => (currentRoot = r) });
        steps.push({ index: i, step: label, ok: true, screenshot: r?.screenshot, ms: Date.now() - t0 });
      } catch (e) {
        const file = join(shotsDir, `failed-step-${i}.png`);
        await page.screenshot({ path: file, fullPage: true }).catch(() => {});
        steps.push({ index: i, step: label, ok: false, error: (e as Error).message, screenshot: rel(deps.root, file), ms: Date.now() - t0 });
        ok = false;
        break;
      }
    }
  } finally {
    await context.close();
  }
  const result = { name: scenario.name, ok, steps, ms: Date.now() - started };
  writeFileSync(join(shotsDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

interface StepCtx {
  page: Page;
  map: AddressMap;
  timeout: number;
  shotsDir: string;
  appUrl: string;
  currentRoot: () => string | undefined;
  setRoot: (r: string | undefined) => void;
}

async function runStep(step: ScenarioStep, ctx: StepCtx): Promise<{ screenshot?: string } | void> {
  const { page, timeout } = ctx;
  switch (step.kind) {
    case "visit": {
      await page.goto(new URL(step.path, ctx.appUrl).toString(), { waitUntil: "networkidle", timeout: Math.max(timeout, 60_000) });
      ctx.setRoot(await detectRoot(page, ctx.map));
      return;
    }
    case "click":
      // Addresses inside a `for` match every iteration; act on the first, like `expect` does.
      await locate(step.target, ctx).first().click({ timeout });
      await settle(page);
      return;
    case "fill":
      await locate(step.target, ctx).first().fill(step.value, { timeout });
      return;
    case "submit": {
      const loc = locate(step.target, ctx).first();
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase(), undefined, { timeout });
      if (tag === "form") await loc.evaluate((el) => (el as HTMLFormElement).requestSubmit());
      else await loc.locator("form").first().evaluate((el) => (el as HTMLFormElement).requestSubmit());
      await settle(page);
      return;
    }
    case "press":
      await page.keyboard.press(step.key);
      await settle(page);
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
    case "screenshot": {
      const file = join(ctx.shotsDir, `${slug(step.name)}.png`);
      await page.screenshot({ path: file, fullPage: true });
      return { screenshot: file };
    }
    case "expect": {
      const loc = locate(step.target, ctx);
      const expected = step.value;
      switch (step.check) {
        case "visible":
          await loc.first().waitFor({ state: "visible", timeout });
          return;
        case "hidden":
          await loc.first().waitFor({ state: "hidden", timeout });
          return;
        case "count":
          await poll(timeout, async () => {
            const n = await loc.count();
            if (n !== expected) throw new Error(`expected ${expected} element(s) at ${step.target}, found ${n}`);
          });
          return;
        case "text":
          await poll(timeout, async () => {
            const t = (await loc.first().innerText({ timeout })).trim();
            if (t !== String(expected)) throw new Error(`expected text ${JSON.stringify(expected)} at ${step.target}, got ${JSON.stringify(t)}`);
          });
          return;
        case "contains":
          await poll(timeout, async () => {
            const t = await loc.first().innerText({ timeout });
            if (!t.includes(String(expected))) throw new Error(`expected ${step.target} to contain ${JSON.stringify(expected)}, got ${JSON.stringify(t.trim())}`);
          });
          return;
        case "attr":
          await poll(timeout, async () => {
            const v = await loc.first().getAttribute(step.attr ?? "", { timeout });
            const want = String(expected);
            if (v === null || !(v === want || v.split(/\s+/).includes(want))) {
              throw new Error(`expected ${step.target} attribute ${step.attr} to be or include ${JSON.stringify(want)}, got ${JSON.stringify(v)}`);
            }
          });
          return;
      }
    }
  }
}

/** Resolve a target to a Playwright locator via the address map. */
function locate(target: string, ctx: StepCtx): Locator {
  const t = target.trim();
  let address: string;
  if (t.startsWith("#")) {
    const root = ctx.currentRoot();
    const id = t.slice(1);
    // Prefer the current page's root, then any root that has this id.
    const candidates = Object.values(ctx.map).filter((e) => e.address.endsWith(` > #${id}`) || e.address.includes(` > #${id} > `));
    const exact = candidates.find((e) => e.address === `${root} > #${id}`) ?? candidates.find((e) => e.address.endsWith(` > #${id}`));
    if (!exact) throw new Error(`No rendered node with id ${t}${root ? ` on ${root}` : ""}`);
    address = exact.address;
  } else {
    address = t.split(">").map((p) => p.trim()).join(" > ");
  }
  const stamp = Object.entries(ctx.map).find(([, e]) => e.address === address)?.[0];
  if (!stamp) throw new Error(`Address ${address} is not in the map; is the dev server running and the page compiled?`);
  return ctx.page.locator(`[data-orchid="${stamp}"]`);
}

/** Work out which page root is rendered by looking at stamps present. */
async function detectRoot(page: Page, map: AddressMap): Promise<string | undefined> {
  const stamps = await page.evaluate(() => [...document.querySelectorAll("[data-orchid]")].map((e) => e.getAttribute("data-orchid")));
  const counts = new Map<string, number>();
  for (const s of stamps) {
    const addr = s ? map[s]?.address : undefined;
    if (!addr || !addr.startsWith("page:")) continue;
    const root = addr.split(" > ")[0]!;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function poll(timeout: number, check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: Error | undefined;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      last = e as Error;
      if (Date.now() > deadline) throw last;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export function describe(step: ScenarioStep): string {
  switch (step.kind) {
    case "visit": return `visit ${step.path}`;
    case "click": return `click ${step.target}`;
    case "fill": return `fill ${step.target} ${JSON.stringify(step.value)}`;
    case "submit": return `submit ${step.target}`;
    case "press": return `press ${step.key}`;
    case "wait": return `wait ${step.ms}`;
    case "screenshot": return `screenshot ${step.name}`;
    case "expect": return `expect ${step.target} ${step.check}${step.attr ? ` ${step.attr}` : ""}${step.value !== undefined ? ` ${JSON.stringify(step.value)}` : ""}`;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario";
}

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, "") : p;
}
