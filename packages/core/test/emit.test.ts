import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emit, programFromSources, parse, programFromDocument } from "../src/index.js";

const fixture = readFileSync(new URL("./fixtures/todo.orchid", import.meta.url), "utf8");
const program = () => programFromSources([{ file: "todo.orchid", text: fixture }]);

describe("emit", () => {
  it("produces the expected file set", () => {
    const r = emit(program(), { dev: true });
    expect(Object.keys(r.files).sort()).toEqual([
      "_orchidery/components/Card.tsx",
      "_orchidery/tokens.css",
      "_orchidery/tokens.ts",
      "layout.tsx",
      "todos/[id]/_islands/Island_done.tsx",
      "todos/[id]/actions.ts",
      "todos/[id]/page.tsx",
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it("matches snapshots in dev and prod", () => {
    expect(emit(program(), { dev: true }).files).toMatchSnapshot();
    expect(emit(program(), { dev: false }).files).toMatchSnapshot();
  });

  it("stamps only in dev and records the map", () => {
    const dev = emit(program(), { dev: true });
    const prod = emit(program(), { dev: false });
    expect(Object.values(prod.files).join("\n")).not.toContain("data-orchid");
    expect(Object.values(prod.files).join("\n")).not.toContain("OrchideryDevTools");
    expect(prod.map).toEqual({});
    const entries = Object.values(dev.map);
    expect(entries.map((e) => e.address)).toContain("page:/todos/[id] > #done");
    expect(entries.map((e) => e.address)).toContain("component:Card > Box[0] > Heading[0]");
    expect(entries.find((e) => e.address === "page:/todos/[id] > #done")).toMatchObject({ file: "todo.orchid", name: "Button", range: { start: { line: 46 } } });
  });

  it("splits interactive subtrees into client islands with typed data props", () => {
    const r = emit(program());
    const island = r.files["todos/[id]/_islands/Island_done.tsx"]!;
    expect(island).toMatch(/^"use client";/);
    expect(island).toContain('import { toggle } from "../actions";');
    expect(island).toContain('import type { PageData } from "../page";');
    expect(island).toContain('{ todo }: { todo: PageData["todo"] }');
    expect(island).toContain("onClick={() => toggle(todo.id)}");
    expect(r.files["todos/[id]/page.tsx"]).toContain("<Island_done todo={todo} />");
  });

  it("emits server actions with revalidate and redirect", () => {
    const r = emit(programFromDocument(parse(`import { db } from "@/lib/db"
page "/" { action go(id: string) { await db.x(id)
 redirect "/done" } ui { Form(action: go) { Button(type: "submit") { "Go" } } } }`)));
    const a = r.files["actions.ts"]!;
    expect(a).toContain('"use server"');
    expect(a).toContain('import { redirect } from "next/navigation";');
    expect(a).toContain("export async function go(id: string)");
    expect(a).toContain('redirect("/done");');
    // A form action is not an event prop, so no island is needed.
    expect(Object.keys(r.files).some((f) => f.includes("_islands"))).toBe(false);
    expect(r.files["page.tsx"]).toContain("<Form action={go}");
    expect(r.files["page.tsx"]).toContain('import { go } from "./actions";');
  });

  it("passes arrow functions through and wraps calls in event props", () => {
    const r = emit(programFromDocument(parse(`page "/" { action a() { x() } ui { Button(onClick: a()) { "1" } Button(onClick: () => a()) { "2" } } }`)));
    const islands = Object.entries(r.files).filter(([f]) => f.includes("_islands")).map(([, c]) => c).join("\n");
    expect(islands).toContain("onClick={() => a()}");
    expect(islands).not.toContain("() => () => a()");
  });

  it("generates a root layout when none is declared", () => {
    const r = emit(programFromDocument(parse(`page "/" { ui { Text { "hi" } } }`)), { dev: true });
    expect(r.files["layout.tsx"]).toContain("<html lang=\"en\">");
    expect(r.files["layout.tsx"]).toContain("<OrchideryDevTools />");
    expect(r.files["page.tsx"]).toContain("Record<string, never>");
  });

  it("types params from the route", () => {
    const r = emit(programFromDocument(parse(`page "/a/[id]/[...rest]" { ui { Text { params.id } } }`)));
    expect(r.files["a/[id]/[...rest]/page.tsx"]).toContain("type Params = { id: string; rest: string[] };");
  });

  it("returns diagnostics instead of files for an invalid program", () => {
    const r = emit(programFromDocument(parse(`page "/" { ui { Nope } }`)));
    expect(r.files).toEqual({});
    expect(r.diagnostics[0]?.code).toBe("O102");
  });
});
