import { describe, expect, it } from "vitest";
import { fragmentJsonSchema, parseActionCall, parseFragment, readPath, validateFragment, fragment } from "../src/index.js";

const codes = (src: string, opts = {}) => validateFragment(parseFragment(src), opts).map((d) => d.code);

describe("fragments", () => {
  it("accepts literals, data paths, loop vars, tokens, templates and act calls", () => {
    const src = `
Stack(gap: space.md) {
  Heading(level: 2) { data.order.title }
  Text(size: "sm", muted) { \`Total: \${data.order.total}\` }
  for line, i in data.order.lines key line.id {
    Text { line.name }
  }
  if data.order.open {
    Button(onClick: act("close", data.order.id, "now"), variant: "danger") { "Close" }
  } else {
    Text { "Closed" }
  }
}`;
    expect(codes(src)).toEqual([]);
    expect(codes(src, { components: [], data: ["order"], actions: ["close"], tokens: ["space"] })).toEqual([]);
  });

  it("rejects arbitrary code", () => {
    expect(codes(`Text { fetch("/x") }`)).toEqual(["O302"]);
    expect(codes(`Text(color: window.location) { "x" }`)).toEqual(["O304"]);
    expect(codes(`Button(onClick: () => alert(1)) { "x" }`)).toEqual(["O302"]);
    expect(codes(`Button(onClick: act("go", fn())) { "x" }`)).toEqual(["O302"]);
    expect(codes(`Text { \`\${eval("1")}\` }`)).toEqual(["O302"]);
    expect(codes(`children`)).toEqual(["O302"]);
    expect(codes(`if data.a > 1 { Text { "x" } }`)).toEqual(["O302"]);
  });

  it("checks elements, props, actions and data against the host's registrations", () => {
    expect(codes(`Chart(data: data.series)`)).toEqual(["O301"]);
    expect(codes(`Chart(data: data.series)`, { components: ["Chart"] })).toEqual([]);
    const d = validateFragment(parseFragment(`Buton { "x" }`), {});
    expect(d[0]).toMatchObject({ code: "O301", fix: { replacement: "Button" } });
    expect(codes(`Text(colour: "x") { "x" }`)).toEqual(["O104"]);
    expect(codes(`Button(onClick: act("closee")) { "x" }`, { actions: ["close"] })).toEqual(["O303"]);
    expect(codes(`Text { data.oder.title }`, { data: ["order"] })).toEqual(["O304"]);
    expect(codes(`Text { order.title }`)).toEqual(["O304"]);
    expect(codes(`Box(padding: spacing.md)`, { tokens: ["space"] })).toEqual(["O304"]);
    expect(codes(`Image(src: data.url)`)).toEqual(["O105"]);
  });

  it("parses action calls", () => {
    expect(parseActionCall(`act("save", data.id, 3, true, 'x')`)).toEqual({ name: "save", args: [{ kind: "ref", path: "data.id" }, { kind: "number", value: 3 }, { kind: "boolean", value: true }, { kind: "string", value: "x" }] });
    expect(parseActionCall(`act(name)`)).toBeUndefined();
    expect(parseActionCall(`save()`)).toBeUndefined();
  });

  it("reads paths and throws on the first error", () => {
    expect(readPath("data.a.b", { data: { a: { b: 7 } } })).toBe(7);
    expect(readPath("data.a.z.q", { data: { a: {} } })).toBeUndefined();
    expect(() => fragment(`Text { fetch() }`)).toThrowError(/O302/);
    expect(fragment(`Text { "ok" }`)).toHaveLength(1);
  });

  it("exports a JSON schema for structured output", () => {
    const s = fragmentJsonSchema() as { type?: string; items?: unknown };
    expect(s.type).toBe("array");
    expect(JSON.stringify(s)).toContain('"element"');
  });
});
