import { describe, expect, it } from "vitest";
import { graft, parse, print, validate, programFromDocument, findScenario } from "../src/index.js";

const SRC = `page "/todos/[id]" {
  action toggle(id: string) { x(id) }
  ui {
    Button#toggle(onClick: toggle(params.id)) { "Mark done" }
    Form#add(action: toggle) { Input(name: "title") }
  }
}

scenario "toggle a todo" {
  visit "/todos/b2"
  expect "#toggle" text "Mark done"
  click "#toggle"
  expect "#toggle" contains "open"
  expect "page:/todos/[id] > #add" visible
  fill "page:/todos/[id] > #add > Input[0]" "Buy milk"
  submit "#add"
  expect "page:/todos/[id] > #add" count 1
  expect "#toggle" attr "class" "o-btn"
  press "Escape"
  wait 250
  screenshot "after"
}
`;

describe("scenario", () => {
  it("parses every step kind and round-trips", () => {
    const doc = parse(SRC);
    const s = findScenario(doc, "toggle a todo")!;
    expect(s.steps.map((st) => st.kind)).toEqual(["visit", "expect", "click", "expect", "expect", "fill", "submit", "expect", "expect", "press", "wait", "screenshot"]);
    expect(s.steps[8]).toMatchObject({ kind: "expect", check: "attr", attr: "class", value: "o-btn" });
    expect(s.steps[7]).toMatchObject({ kind: "expect", check: "count", value: 1 });
    const text = print(doc);
    expect(print(parse(text))).toBe(text);
    expect(text).toContain('  expect "#toggle" attr "class" "o-btn"');
  });

  it("validates cleanly and resolves targets", () => {
    expect(validate(programFromDocument(parse(SRC)))).toEqual([]);
  });

  it("reports bad steps and targets", () => {
    expect(() => parse(`scenario "x" { visit "/"\n hover "#a" }`)).toThrowError(/O116/);
    expect(() => parse(`scenario "x" { visit "/"\n expect "#a" bogus "1" }`)).toThrowError(/O116/);
    expect(() => parse(`scenario "x" { visit "/"\n wait "soon" }`)).toThrowError(/O116/);
    const codes = (src: string) => validate(programFromDocument(parse(src))).map((d) => d.code);
    expect(codes(`page "/" { ui { Box#a } }  scenario "x" { visit "/"\n click "#b" }`)).toEqual(["O118"]);
    expect(codes(`page "/" { ui { Box#a } }  scenario "x" { visit "/"\n click "page:/ > Nope[0]" }`)).toEqual(["O118"]);
    expect(codes(`page "/" { ui { Box#a } }  scenario "x" { click "#a" }`)).toEqual(["O119"]);
    expect(codes(`page "/" { ui { Box#a } }  scenario "x" { visit "/" }  scenario "x" { visit "/" }`)).toEqual(["O117"]);
    const d = validate(programFromDocument(parse(`page "/" { ui { Box#toggle } }  scenario "x" { visit "/"\n click "#togle" }`)));
    expect(d[0]).toMatchObject({ code: "O118", fix: { replacement: "#toggle" } });
  });

  it("grafts scenarios and steps", () => {
    const doc = parse(SRC);
    const r = graft(doc, [
      { op: "add_scenario", source: `scenario "delete" { visit "/todos/b2"\n click "#toggle" }` },
      { op: "insert_step", scenario: "delete", step: `expect "#toggle" visible` },
      { op: "insert_step", scenario: "scenario:delete", index: 1, step: `wait 100` },
      { op: "set_step", scenario: "toggle a todo", index: 2, step: `click "page:/todos/[id] > #toggle"` },
      { op: "remove_step", scenario: "toggle a todo", index: 11 },
    ]);
    const del = findScenario(r.document, "delete")!;
    expect(del.steps.map((s) => s.kind)).toEqual(["visit", "wait", "click", "expect"]);
    expect(findScenario(r.document, "toggle a todo")!.steps).toHaveLength(11);
    expect(r.text).toContain('click "page:/todos/[id] > #toggle"');
    expect(r.touched).toEqual(expect.arrayContaining(["scenario:delete", "scenario:toggle a todo"]));
    const r2 = graft(r.document, [{ op: "remove_scenario", scenario: "delete" }]);
    expect(findScenario(r2.document, "delete")).toBeUndefined();
    expect(() => graft(doc, [{ op: "set_step", scenario: "nope", index: 0, step: "wait 1" }])).toThrowError(/O201/);
    expect(() => graft(doc, [{ op: "insert_step", scenario: "toggle a todo", step: "click \"#nope\"" }])).toThrowError(/O203.*O118/);
  });
});
