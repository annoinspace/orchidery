/**
 * The whole loop against the real example app:
 * human draws a box in edit mode -> annotation on disk -> agent grafts via MCP -> page reflects it.
 *
 * Run with `pnpm e2e`. Needs the packages built (`pnpm build`) and Chromium.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "@orchidery/mcp";

const root = join(process.cwd(), "examples/todo");
const NEXT_PORT = 3123;
const APP = `http://localhost:${NEXT_PORT}`;
const DEVTOOLS = "http://localhost:4747";
const sourcePath = join(root, "orchid/todos.orchid");
const originalSource = readFileSync(sourcePath, "utf8");
const scenarioPath = join(root, "orchid/scenarios.orchid");
const originalScenarios = readFileSync(scenarioPath, "utf8");

let dev: ChildProcess;
let browser: Browser;
let page: Page;

async function waitFor(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  rmSync(join(root, ".orchidery/annotations"), { recursive: true, force: true });
  dev = spawn("node", [join(process.cwd(), "packages/cli/dist/bin.js"), "dev", "-p", String(NEXT_PORT)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  dev.stdout?.on("data", (d: Buffer) => process.stdout.write(`[dev] ${d}`));
  dev.stderr?.on("data", (d: Buffer) => process.stderr.write(`[dev] ${d}`));
  await waitFor(`${DEVTOOLS}/health`, 30_000);
  await waitFor(`${APP}/todos/b2`, 150_000);
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
});

afterAll(async () => {
  writeFileSync(sourcePath, originalSource);
  writeFileSync(scenarioPath, originalScenarios);
  await browser?.close();
  dev?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

describe("edit mode -> annotation -> graft -> reload", () => {
  let annotationId = "";

  it("renders the page with source stamps and loads the overlay", async () => {
    await page.goto(`${APP}/todos/b2`, { waitUntil: "networkidle" });
    await page.locator("[data-orchid]").first().waitFor();
    const toggle = page.locator("button", { hasText: "Mark done" });
    await expect(toggle.getAttribute("data-orchid")).resolves.toMatch(/^[0-9a-f]{8}$/);
    await page.locator("orchidery-devtools").waitFor({ state: "attached" });
    await page.locator("orchidery-devtools #toggle").waitFor({ timeout: 20_000 });
  });

  it("lets the human draw a box around the button and leave a note", async () => {
    await page.click("orchidery-devtools #toggle");
    await page.click("orchidery-devtools #t-box");
    const box = (await page.locator("button", { hasText: "Mark done" }).boundingBox())!;
    await page.mouse.move(box.x - 8, box.y - 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width + 8, box.y + box.height + 8, { steps: 4 });
    await page.mouse.up();
    const panel = page.locator("orchidery-devtools .panel");
    await panel.waitFor();
    await expect(panel.locator(".targets").innerText()).resolves.toContain("page:/todos/[id] > #toggle");
    await panel.locator("textarea").fill("make this less loud");
    await panel.locator("#send").click();
    await page.locator("orchidery-devtools .toast").waitFor();

    const dir = join(root, ".orchidery/annotations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".before.json"));
    expect(files).toHaveLength(1);
    const a = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    annotationId = a.id;
    expect(a).toMatchObject({ status: "pending", url: "/todos/b2", note: "make this less loud", targets: ["page:/todos/[id] > #toggle"] });
    expect(a.region.w).toBeGreaterThan(0);
    expect(existsSync(join(root, a.screenshot))).toBe(true);
    expect(statSync(join(root, a.screenshot)).size).toBeGreaterThan(1000);
    await page.locator("orchidery-devtools .pin.pending").waitFor();
  });

  it("lets an agent tend it through MCP and the page reflects the graft", async () => {
    const client = new Client({ name: "e2e", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer({ root }).connect(a), client.connect(b)]);

    const detail = await client.callTool({ name: "orchid_annotation", arguments: { id: annotationId } });
    const parts = detail.content as { type: string; text?: string }[];
    expect(parts.some((p) => p.type === "image")).toBe(true);
    expect(JSON.parse(parts[0]!.text!).targetsDetail[0].excerpt).toContain("Button#toggle");

    await client.callTool({ name: "orchid_annotation_update", arguments: { id: annotationId, status: "in_progress" } });
    const graft = await client.callTool({
      name: "orchid_graft",
      arguments: { ops: [{ op: "set_prop", address: "page:/todos/[id] > #toggle", name: "variant", value: '"secondary"' }] },
    });
    expect(graft.isError).toBeFalsy();
    expect(readFileSync(sourcePath, "utf8")).toContain('Button#toggle(onClick: toggle(todo.id), variant: "secondary")');
    await client.callTool({ name: "orchid_annotation_update", arguments: { id: annotationId, status: "done", summary: "Secondary variant" } });

    // The dev watcher recompiles; Next picks up the new page.tsx.
    const deadline = Date.now() + 60_000;
    for (;;) {
      await page.reload({ waitUntil: "networkidle" });
      const cls = await page.locator("button", { hasText: "Mark done" }).getAttribute("class");
      if (cls?.includes("o-btn-secondary")) break;
      if (Date.now() > deadline) throw new Error(`page never reflected the graft, class was ${cls}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const diff = await client.callTool({ name: "orchid_diff", arguments: { id: annotationId } });
    expect((diff.content as { text: string }[])[0]!.text).toContain('variant: "secondary"');
    await page.locator("orchidery-devtools .pin.done").waitFor({ timeout: 10_000 });
  });

  it("lets the agent look at its work with orchid_preview", async () => {
    const client = await mcp();
    const res = await client.callTool({ name: "orchid_preview", arguments: { route: "/todos/b2" } });
    expect(res.isError).toBeFalsy();
    const parts = res.content as { type: string; text?: string; mimeType?: string; data?: string }[];
    const info = JSON.parse(parts[0]!.text!);
    expect(info.title).toBe("Orchidery todos");
    expect(info.boxes["page:/todos/[id] > #toggle"].w).toBeGreaterThan(50);
    expect(info.errors).toEqual([]);
    expect(info.a11y).toBeDefined();
    expect(parts[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(parts[1]!.data!, "base64").length).toBeGreaterThan(5000);
  });

  it("previews an unsaved source under a temporary route and cleans up", async () => {
    const client = await mcp();
    const source = `page "/scratch" {\n  ui {\n    Card(title: "Scratch") {\n      Text#hello { "Hello from a preview" }\n    }\n  }\n}\n`;
    const res = await client.callTool({ name: "orchid_preview", arguments: { source, a11y: false } });
    expect(res.isError).toBeFalsy();
    const info = JSON.parse((res.content as { text: string }[])[0]!.text);
    const helloBox = Object.entries(info.boxes).find(([k]) => k.endsWith(" > #hello"));
    expect(helloBox).toBeDefined();
    expect(info.url).toContain("/orchidery-preview/");
    expect(existsSync(join(root, "app/orchidery-preview"))).toBe(false);
  });

  it("runs the project's scenarios through orchid_scenario_run", async () => {
    const client = await mcp();
    const res = await client.callTool({ name: "orchid_scenario_run", arguments: { name: "toggle a todo" } });
    const out = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(out.results[0].steps.map((s: { ok: boolean }) => s.ok)).toEqual([true, true, true, true, true, true]);
    expect(out.ok).toBe(true);

    const all = await client.callTool({ name: "orchid_scenario_run", arguments: {} });
    const outAll = JSON.parse((all.content as { text: string }[])[0]!.text);
    expect(outAll.results.map((r: { name: string; ok: boolean }) => [r.name, r.ok])).toEqual([["toggle a todo", true], ["add a todo", true], ["assistant renders a fragment", true]]);
    expect(existsSync(join(root, ".orchidery/scenarios/add-a-todo/after-add.png"))).toBe(true);
  });

  it("renders a runtime fragment on the assistant page without evaluating code", async () => {
    await page.goto(`${APP}/assistant`, { waitUntil: "networkidle" });
    const card = page.locator("h3", { hasText: "Where you're at" });
    await card.waitFor();
    await expect(page.locator("text=still open").count()).resolves.toBeGreaterThan(0);
    // The fragment's Link primitives rendered as real Next links.
    await expect(page.locator('a[href="/todos/b2"]').count()).resolves.toBeGreaterThan(0);
    const client = await mcp();
    const bad = await client.callTool({ name: "orchid_fragment_validate", arguments: { source: 'Text { fetch("/x") }' } });
    expect(JSON.parse((bad.content as { text: string }[])[0]!.text).diagnostics[0].code).toBe("O302");
  });

  it("reports a failing step with an error and a screenshot", async () => {
    const client = await mcp();
    await client.callTool({
      name: "orchid_graft",
      arguments: { ops: [{ op: "add_scenario", source: `scenario "doomed" {\n visit "/todos/b2"\n expect "#toggle" text "Nope" }` }] },
    });
    try {
      const res = await client.callTool({ name: "orchid_scenario_run", arguments: { name: "doomed", timeout: 1500 } });
      const out = JSON.parse((res.content as { text: string }[])[0]!.text);
      expect(out.ok).toBe(false);
      const failed = out.results[0].steps[1];
      expect(failed.ok).toBe(false);
      expect(failed.error).toContain('expected text "Nope"');
      expect(existsSync(join(root, failed.screenshot))).toBe(true);
    } finally {
      await client.callTool({ name: "orchid_graft", arguments: { file: "orchid/scenarios.orchid", ops: [{ op: "remove_scenario", scenario: "doomed" }] } });
    }
  });
});

async function mcp(): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer({ root }).connect(a), client.connect(b)]);
  return client;
}
