import { describe, expect, it } from "vitest";
import { parse, validate, programFromDocument, programFromSources } from "../src/index.js";

function codes(src: string): string[] {
  return validate(programFromDocument(parse(src, { file: "t.orchid" }))).map((d) => d.code);
}
function diags(src: string) {
  return validate(programFromDocument(parse(src, { file: "t.orchid" })));
}

const OK = `
tokens { color.primary: "#000"  space.md: 16 }
component Card(title: string, children) { Box(padding: space.md) { Heading { title } children } }
layout "/" { ui { Box { children } } }
page "/" {
  load { items: await fetchItems() }
  action add(name: string) { await save(name) }
  ui {
    Card(title: "Hi") { Text(color: color.primary) { "x" } }
    Button#go(onClick: add("a")) { "Add" }
    for it in items { Text { it } }
  }
}`;

describe("validate", () => {
  it("accepts a valid program", () => {
    expect(codes(OK)).toEqual([]);
  });

  it("O101 duplicate route", () => {
    expect(codes(`page "/" { ui {} }  page "/" { ui {} }`)).toContain("O101");
  });
  it("O102 unknown component with fix", () => {
    const d = diags(`page "/" { ui { Buton { "x" } } }`);
    expect(d[0]).toMatchObject({ code: "O102", fix: { replacement: "Button" } });
  });
  it("O103 unknown token with fix", () => {
    const d = diags(`tokens { space.md: 16 } page "/" { ui { Box(padding: space.mdd) } }`);
    expect(d[0]).toMatchObject({ code: "O103", fix: { replacement: "space.md" }, range: { start: { line: 1 } } });
  });
  it("does not treat non-token refs as tokens", () => {
    expect(codes(`page "/" { load { todo: get() } ui { Text { todo.title } Box(bg: todo.color) } }`)).toEqual([]);
  });
  it("O104 unknown prop with fix", () => {
    const d = diags(`page "/" { ui { Text(colour: "x") { "x" } } }`);
    expect(d[0]).toMatchObject({ code: "O104", fix: { replacement: "color" } });
  });
  it("O105 missing required prop", () => {
    expect(codes(`page "/" { ui { Image(src: "/a.png") } }`)).toEqual(["O105"]);
  });
  it("O106 duplicate id", () => {
    expect(codes(`page "/" { ui { Box#a  Box#a } }`)).toEqual(["O106"]);
  });
  it("O107 event prop in layout", () => {
    expect(codes(`layout "/" { ui { Button(onClick: x()) { "x" } children } }`)).toEqual(["O107"]);
  });
  it("O108 unknown action with fix", () => {
    const d = diags(`page "/" { action toggle(id: string) { x() } ui { Button(onClick: togle(1)) { "x" } } }`);
    expect(d[0]).toMatchObject({ code: "O108", fix: { replacement: "toggle" } });
  });
  it("O109 arity mismatch", () => {
    expect(codes(`page "/" { action toggle(id: string) { x() } ui { Button(onClick: toggle()) { "x" } } }`)).toEqual(["O109"]);
    expect(codes(`page "/" { action toggle(id: string) { x() } ui { Button(onClick: toggle(f(1, 2))) { "x" } } }`)).toEqual([]);
  });
  it("O110 layout without children", () => {
    expect(codes(`layout "/" { ui { Box { "x" } } }`)).toEqual(["O110"]);
  });
  it("O111 duplicate declarations", () => {
    expect(codes(`component A() { Box }  component A() { Box }`)).toEqual(["O111"]);
    expect(codes(`page "/" { load {\n a: 1\n a: 2\n } ui {} }`)).toEqual(["O111"]);
  });
  it("O112 unknown prop on component", () => {
    const d = diags(`component Card(title: string) { Box }  page "/" { ui { Card(titel: "x") } }`);
    expect(d[0]).toMatchObject({ code: "O112", fix: { replacement: "title" } });
  });
  it("O113 duplicate prop", () => {
    expect(codes(`page "/" { ui { Box(padding: 1, padding: 2) } }`)).toEqual(["O113"]);
  });
  it("O114 slot in a page", () => {
    expect(codes(`page "/" { ui { children } }`)).toEqual(["O114"]);
  });
  it("allows imported components and handlers passed as component params", () => {
    expect(codes(`import { Chart } from "@/components/chart"  page "/" { ui { Chart(data: 1) } }`)).toEqual([]);
    expect(codes(`component Row(onPick) { Button(onClick: onPick) { "x" } }`)).toEqual([]);
  });
  it("validates across documents", () => {
    const p = programFromSources([
      { file: "a.orchid", text: `component Card(title: string) { Box { title } }` },
      { file: "b.orchid", text: `page "/" { ui { Card(title: "x") } }` },
    ]);
    expect(validate(p)).toEqual([]);
  });
});
