import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, print, walkDocument, findByAddress, commonAncestor, stamp, normalize } from "../src/index.js";

const fixture = readFileSync(new URL("./fixtures/todo.orchid", import.meta.url), "utf8");

function stripSpans(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSpans);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "span" || val === undefined) continue;
      out[k] = stripSpans(val);
    }
    return out;
  }
  return v;
}

describe("parser", () => {
  it("parses the todo fixture", () => {
    const doc = parse(fixture, { file: "todo.orchid" });
    expect(doc.items.map((i) => i.kind)).toEqual(["import", "tokens", "component", "layout", "page"]);
    const page = doc.items[4];
    if (page.kind !== "page") throw new Error();
    expect(page.route).toBe("/todos/[id]");
    expect(page.load?.bindings[0]).toMatchObject({ name: "todo", expr: { kind: "code", code: "await db.todo.find(params.id)" } });
    expect(page.actions[0]).toMatchObject({
      name: "toggle",
      params: [{ name: "id", type: "string" }],
      body: [{ kind: "raw", code: "await db.todo.toggle(id)" }, { kind: "revalidate", path: "/todos" }],
    });
    const card = page.ui[0];
    if (card.kind !== "element") throw new Error();
    expect(card.name).toBe("Card");
    expect(card.props[0]).toMatchObject({ name: "title", value: { kind: "ref", path: "todo.title" } });
    const ifNode = card.children[1];
    if (ifNode.kind !== "if") throw new Error();
    expect(ifNode.else?.[0]).toMatchObject({ kind: "element", name: "Button", id: "done" });
    const forNode = card.children[2];
    if (forNode.kind !== "for") throw new Error();
    expect(forNode).toMatchObject({ item: "tag", index: "i", iterable: { kind: "ref", path: "todo.tags" }, key: { kind: "ref", path: "tag" } });
  });

  it("classifies prop values", () => {
    const doc = parse(`page "/" { ui { Box(a: "s", b: 3, c: true, d, e: space.md, f: fn(x), g: 'single') } }`);
    const page = doc.items[0];
    if (page.kind !== "page") throw new Error();
    const el = page.ui[0];
    if (el.kind !== "element") throw new Error();
    expect(el.props.map((p) => p.value.kind)).toEqual(["string", "number", "boolean", "boolean", "ref", "code", "string"]);
  });

  it("round-trips through print", () => {
    const doc = parse(fixture);
    const text = print(doc);
    const again = parse(text);
    expect(stripSpans(again)).toEqual(stripSpans(doc));
    expect(print(again)).toBe(text);
  });

  it("records spans", () => {
    const doc = parse(`page "/" {\n  ui {\n    Button#go(variant: "primary") { "Go" }\n  }\n}`);
    const page = doc.items[0];
    if (page.kind !== "page") throw new Error();
    const btn = page.ui[0];
    expect(btn.span?.start).toMatchObject({ line: 3, col: 5 });
  });

  it("reports syntax errors with codes", () => {
    expect(() => parse(`page "/" { ui { Box( } }`)).toThrowError(/O00\d/);
    expect(() => parse(`widget "/" {}`)).toThrowError(/O005/);
    expect(() => parse(`page "/" { stuff {} }`)).toThrowError(/O006/);
    expect(() => parse(`page "todos" { ui {} }`)).toThrowError(/O007/);
  });
});

describe("addresses", () => {
  const doc = parse(fixture);

  it("assigns stable addresses and restarts at ids", () => {
    const addrs = [...walkDocument(doc)].map((l) => l.address);
    expect(addrs).toContain("component:Card > Box[0] > Heading[0]");
    expect(addrs).not.toContain("page:/todos/[id] > Card[0] > if[0] > else > Button[0]");
    expect(addrs).toContain("page:/todos/[id] > Card[0] > if[0] > then > Text[0]");
    expect(addrs).toContain("page:/todos/[id] > #done");
    expect(addrs).toContain("page:/todos/[id] > #done > text[0]");
    expect(addrs).toContain("page:/todos/[id] > Card[0] > for[0] > Text[0]");
  });

  it("finds nodes by address", () => {
    const loc = findByAddress(doc, "page:/todos/[id] > #done");
    expect(loc?.node).toMatchObject({ kind: "element", name: "Button" });
    expect(findByAddress(doc, "page:/todos/[id] > Nope[0]")).toBeUndefined();
    expect(() => normalize("bogus > X[0]")).toThrowError(/O204/);
  });

  it("computes common ancestors", () => {
    expect(commonAncestor(["page:/ > A[0] > B[0]", "page:/ > A[0] > C[1]"])).toBe("page:/ > A[0]");
    expect(commonAncestor(["page:/ > A[0]", "page:/x > A[0]"])).toBeUndefined();
  });

  it("stamps deterministically", () => {
    expect(stamp("page:/ > A[0]")).toBe(stamp("page:/ > A[0]"));
    expect(stamp("page:/ > A[0]")).not.toBe(stamp("page:/ > A[1]"));
    expect(stamp("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});
