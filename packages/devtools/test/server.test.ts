import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevtoolsServer, sha, Store } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "orchidery-"));
mkdirSync(join(root, "orchid"), { recursive: true });
writeFileSync(join(root, "orchid", "home.orchid"), 'page "/" { ui { Text { "hi" } } }\n');
const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

let base = "";
let stop: () => void = () => {};

beforeAll(async () => {
  const { server, store, listen } = createDevtoolsServer({ root, port: 0 });
  store.writeMap({ abc12345: { address: "page:/ > Text[0]", name: "Text", file: "orchid/home.orchid" } });
  const port = await listen();
  base = `http://127.0.0.1:${port}`;
  stop = () => server.close();
});
afterAll(() => {
  stop();
  rmSync(root, { recursive: true, force: true });
});

describe("devtools server", () => {
  it("serves the map and health", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    const map = await (await fetch(`${base}/map`)).json();
    expect(map.abc12345.address).toBe("page:/ > Text[0]");
  });

  it("creates, lists, updates, diffs and deletes annotations", async () => {
    const res = await fetch(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/", targets: ["page:/ > Text[0]"], note: "make it bold", screenshot: PNG, region: { x: 1, y: 2, w: 3, h: 4 } }),
    });
    expect(res.status).toBe(201);
    const a = await res.json();
    expect(a).toMatchObject({ status: "pending", note: "make it bold", targets: ["page:/ > Text[0]"], screenshot: `.orchidery/annotations/${a.id}.png` });

    const list = await (await fetch(`${base}/annotations?status=pending`)).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([a.id]);

    const shot = await fetch(`${base}/annotations/${a.id}/screenshot.png`);
    expect(shot.headers.get("content-type")).toBe("image/png");
    expect((await shot.arrayBuffer()).byteLength).toBe(4);

    // Simulate the agent editing the source, then ask for the diff.
    writeFileSync(join(root, "orchid", "home.orchid"), 'page "/" { ui { Text(weight: "bold") { "hi" } } }\n');
    const diff = await (await fetch(`${base}/annotations/${a.id}/diff`)).text();
    expect(diff).toContain("orchid/home.orchid");
    expect(diff).toContain('+page "/" { ui { Text(weight: "bold")');

    const upd = await fetch(`${base}/annotations/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done", summary: "Made it bold" }) });
    expect(await upd.json()).toMatchObject({ status: "done", summary: "Made it bold" });

    expect((await fetch(`${base}/annotations/${a.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/annotations/${a.id}`)).status).toBe(404);
  });

  it("rejects malformed annotations and serves the overlay", async () => {
    const bad = await fetch(`${base}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    const overlay = await fetch(`${base}/overlay.js`);
    expect(overlay.status).toBe(200);
    expect(await overlay.text()).toContain("orchidery-devtools");
  });

  it("store reads sources and validates ids", () => {
    const s = new Store(root);
    expect(Object.keys(s.readSources())).toEqual(["orchid/home.orchid"]);
    expect(() => s.get("../etc")).toThrow();
  });
});

describe("graft log and review gate", () => {
  it("logs grafts and filters history", () => {
    const s = new Store(root);
    s.appendGraft({ agent: "a1", file: "orchid/home.orchid", ops: [{ op: "set_text" }], touched: ["page:/ > Text[0]"], annotation: "ann1", before: "x", after: "y" });
    s.appendGraft({ agent: "a2", file: "orchid/home.orchid", ops: [{ op: "prune" }], touched: ["page:/ > Box[0] > Text[0]"], before: "y", after: "z" });
    expect(s.history().map((e) => e.agent)).toEqual(["a2", "a1"]);
    expect(s.history({ agent: "a1" })).toHaveLength(1);
    expect(s.history({ annotation: "ann1" })).toHaveLength(1);
    expect(s.history({ address: "page:/ > Box[0]" }).map((e) => e.agent)).toEqual(["a2"]);
    expect(s.touchedFor("ann1")).toEqual(["page:/ > Text[0]"]);
  });

  it("holds, lists, diffs, accepts and refuses stale grafts", async () => {
    const s = new Store(root);
    const before = s.readFile("orchid/home.orchid");
    const held = s.hold({ agent: "bot", file: "orchid/home.orchid", ops: [{ op: "set_text" }], touched: ["page:/ > Text[0]"], before: sha(before), text: before.replace("bold", "italic") });
    expect(held.diff).toContain("+");
    expect(s.listPending().map((p) => p.id)).toEqual([held.id]);
    expect((await fetch(`${base}/pending`)).status).toBe(200);
    expect(await (await fetch(`${base}/pending`)).json()).toHaveLength(1);

    // Someone edits the file underneath: accept must refuse.
    writeFileSync(join(root, "orchid", "home.orchid"), before + "\n// changed\n");
    const stale = await fetch(`${base}/pending/${held.id}/accept`, { method: "POST" });
    expect(stale.status).toBe(409);
    writeFileSync(join(root, "orchid", "home.orchid"), before);

    const ok = await fetch(`${base}/pending/${held.id}/accept`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(s.readFile("orchid/home.orchid")).toContain("italic");
    expect(s.listPending()).toHaveLength(0);
    expect(s.history()[0]).toMatchObject({ agent: "bot (accepted by human)", pending: held.id });

    const held2 = s.hold({ agent: "bot", file: "orchid/home.orchid", ops: [], touched: [], before: "nope", text: "" });
    expect((await fetch(`${base}/pending/${held2.id}/reject`, { method: "POST" })).status).toBe(204);
    expect(s.listPending()).toHaveLength(0);
  });
});
