import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@orchidery/devtools";
import { createServer } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "orchidery-mcp-"));
mkdirSync(join(root, "orchid"), { recursive: true });
writeFileSync(
  join(root, "orchid", "todos.orchid"),
  `tokens {
  space.md: 16
}

page "/todos" {
  action add(name: string) {
    await save(name)
  }

  ui {
    Stack(gap: space.md) {
      Heading#title { "Todos" }
      Button#add(onClick: add("x"), variant: "primary") { "Add" }
    }
  }
}
`,
);

const client = new Client({ name: "test", version: "0.0.0" });
let store: Store;

beforeAll(async () => {
  const server = createServer({ root });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  store = new Store(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  const first = (r.content as { type: string; text?: string }[])[0]!;
  if (first.type !== "text") return r as T;
  try {
    return JSON.parse(first.text!) as T;
  } catch {
    return first.text as T;
  }
}

describe("mcp server", () => {
  it("lists the expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "orchid_annotation", "orchid_annotation_update", "orchid_annotations", "orchid_compile", "orchid_diff", "orchid_explain",
      "orchid_format", "orchid_get_node", "orchid_graft", "orchid_preview", "orchid_project", "orchid_read", "orchid_scenario_run", "orchid_scenarios", "orchid_schema", "orchid_validate",
    ]);
  });

  it("describes the project and nodes", async () => {
    const p = await call<{ roots: { address: string; children: string[] }[]; tokens: string[] }>("orchid_project");
    expect(p.roots[0]).toMatchObject({ address: "page:/todos", children: ["page:/todos > Stack[0]"] });
    expect(p.tokens).toEqual(["space.md: 16"]);
    const n = await call<{ excerpt: string; children: string[]; line: number }>("orchid_get_node", { address: "page:/todos > Stack[0]" });
    expect(n.excerpt).toMatch(/^Stack\(gap: space.md\)/);
    expect(n.children).toEqual(["page:/todos > #title", "page:/todos > #add"]);
    expect(n.line).toBe(11);
  });

  it("validates with fixes and explains codes", async () => {
    const v = await call<{ diagnostics: { code: string; fix?: { replacement: string } }[] }>("orchid_validate", { source: `page "/x" { ui { Text(colour: "a") } }` });
    expect(v.diagnostics[0]).toMatchObject({ code: "O104", fix: { replacement: "color" } });
    const e = await call<{ title: string }>("orchid_explain", { code: "O104" });
    expect(e.title).toBe("Unknown prop");
    const s = await call<{ primitives: Record<string, unknown>; graftOps: unknown }>("orchid_schema");
    expect(Object.keys(s.primitives)).toContain("Button");
  });

  it("grafts a file on disk, inferring the file from the address", async () => {
    const r = await call<{ file: string; touched: string[] }>("orchid_graft", {
      ops: [{ op: "set_prop", address: "page:/todos > #add", name: "variant", value: '"secondary"' }],
    });
    expect(r).toMatchObject({ file: "orchid/todos.orchid", touched: ["page:/todos > #add"] });
    expect(readFileSync(join(root, "orchid", "todos.orchid"), "utf8")).toContain('variant: "secondary"');
    const bad = await client.callTool({ name: "orchid_graft", arguments: { ops: [{ op: "set_prop", address: "page:/todos > #add", name: "colour", value: '"x"' }] } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toContain("O203");
  });

  it("compiles without writing by default", async () => {
    const r = await call<{ files: Record<string, string> }>("orchid_compile", { dev: true });
    expect(Object.keys(r.files)).toContain("todos/page.tsx");
    expect(r.files["todos/page.tsx"]).toContain("data-orchid");
  });

  it("works an annotation end to end", async () => {
    const a = store.create({ url: "/todos", targets: ["page:/todos > #add"], commonAncestor: "page:/todos > #add", note: "make this a danger button", screenshot: "data:image/png;base64,iVBORw0KGgo=" });
    const list = await call<{ id: string }[]>("orchid_annotations");
    expect(list.map((x) => x.id)).toEqual([a.id]);

    const detail = await client.callTool({ name: "orchid_annotation", arguments: { id: a.id } });
    const [textPart, imagePart] = detail.content as { type: string; text?: string; mimeType?: string }[];
    expect(JSON.parse(textPart!.text!).targetsDetail[0].excerpt).toContain("Button#add");
    expect(imagePart).toMatchObject({ type: "image", mimeType: "image/png" });

    await call("orchid_annotation_update", { id: a.id, status: "in_progress" });
    await call("orchid_graft", { ops: [{ op: "set_prop", address: "page:/todos > #add", name: "variant", value: '"danger"' }] });
    const diff = await call<string>("orchid_diff", { id: a.id });
    expect(diff).toContain('+      Button#add(onClick: add("x"), variant: "danger")');
    const done = await call<{ status: string; summary: string }>("orchid_annotation_update", { id: a.id, status: "done", summary: "Switched to the danger variant" });
    expect(done).toMatchObject({ status: "done", summary: "Switched to the danger variant" });
    expect((await call<unknown[]>("orchid_annotations")).length).toBe(0);
  });
});
