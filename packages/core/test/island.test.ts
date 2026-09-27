import { describe, expect, it } from "vitest";
import { emit, graft, parse, print, validate, programFromDocument, walkDocument } from "../src/index.js";

const SRC = `import { Chart } from "@/components/chart"

tokens {
  space.md: 16
}

island Counter(initial: number, label: string) {
  state {
    count: initial
    open: false
  }

  ui {
    Button#inc(onClick: setCount(count + 1), variant: "primary") { label }
    Text { count }
    if open {
      Text { "Expanded" }
    }
    Button(onClick: setOpen(!open), variant: "ghost") { open ? "Less" : "More" }
  }
}

page "/counter" {
  ui {
    Counter(initial: 0, label: "Add one")
  }
}
`;

describe("islands", () => {
  it("parses, round-trips and addresses", () => {
    const doc = parse(SRC);
    const isl = doc.items[2];
    if (isl.kind !== "island") throw new Error("expected island");
    expect(isl.params.map((p) => p.name)).toEqual(["initial", "label"]);
    expect(isl.state.map((s) => [s.name, s.initial.kind])).toEqual([["count", "ref"], ["open", "boolean"]]);
    const text = print(doc);
    expect(print(parse(text))).toBe(text);
    expect([...walkDocument(doc)].map((l) => l.address)).toContain("island:Counter > #inc");
    expect(validate(programFromDocument(doc))).toEqual([]);
  });

  it("rejects load/action blocks, duplicate state and unknown props", () => {
    expect(() => parse(`island X { load { a: 1 } ui { Box } }`)).toThrowError(/O115/);
    const codes = (src: string) => validate(programFromDocument(parse(src))).map((d) => d.code);
    expect(codes(`island X { state { a: 1 \n a: 2 } ui { Box } }`)).toEqual(["O111"]);
    expect(codes(`island X(n: number) { ui { Box } }  page "/" { ui { X(m: 1) } }`)).toEqual(["O112"]);
    expect(codes(`component X() { Box }  island X { ui { Box } }`)).toEqual(["O111"]);
  });

  it("emits a client component with useState per entry and imports it from pages", () => {
    const r = emit(programFromDocument(parse(SRC)), { dev: true });
    expect(r.diagnostics).toEqual([]);
    const isl = r.files["_orchidery/islands/Counter.tsx"]!;
    expect(isl).toMatch(/^"use client";/);
    expect(isl).toContain("const [count, setCount] = useState(initial);");
    expect(isl).toContain("const [open, setOpen] = useState(false);");
    expect(isl).toContain("onClick={() => setCount(count + 1)}");
    expect(isl).toContain("export function Counter({ initial, label }: { initial: number; label: string })");
    expect(isl).toContain('data-orchid=');
    const page = r.files["counter/page.tsx"]!;
    expect(page).toContain('import { Counter } from "../_orchidery/islands/Counter";');
    expect(page).toContain('<Counter initial={0} label="Add one" />');
    // Using an island in a page does not create an extracted island: the boundary is the declaration.
    expect(Object.keys(r.files).some((f) => f.includes("_islands"))).toBe(false);
    expect(Object.values(r.map).map((e) => e.address)).toContain("island:Counter > #inc");
  });

  it("grafts islands and state", () => {
    const doc = parse(SRC);
    const r = graft(doc, [
      { op: "add_island", source: `island Toggle { state { on: false } ui { Button(onClick: setOn(!on)) { "t" } } }` },
      { op: "set_state", island: "Counter", name: "count", initial: "initial * 2" },
      { op: "set_state", island: "island:Counter", name: "note", initial: '"hi"' },
      { op: "remove_state", island: "Counter", name: "open" },
      { op: "prune", address: "island:Counter > if[0]" },
      { op: "prune", address: "island:Counter > Button[1]" },
      { op: "insert_child", address: "page:/counter", node: "Toggle" },
    ]);
    expect(r.text).toContain("count: initial * 2");
    expect(r.text).toContain('note: "hi"');
    expect(r.text).not.toContain("open: false");
    expect(r.touched).toEqual(expect.arrayContaining(["island:Toggle", "island:Counter"]));
    expect(() => graft(doc, [{ op: "set_state", island: "Nope", name: "a", initial: "1" }])).toThrowError(/O201/);
  });
});
