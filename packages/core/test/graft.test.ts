import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { graft, parse, findByAddress, print, type Document } from "../src/index.js";

const fixture = readFileSync(new URL("./fixtures/todo.orchid", import.meta.url), "utf8");
const doc = () => parse(fixture, { file: "todo.orchid" });
const PAGE = "page:/todos/[id]";

function ui(d: Document, address: string) {
  return findByAddress(d, address)?.node;
}

describe("graft", () => {
  it("set_prop adds and replaces, classifying raw values", () => {
    const r = graft(doc(), [
      { op: "set_prop", address: `${PAGE} > #done`, name: "variant", value: '"secondary"' },
      { op: "set_prop", address: `${PAGE} > #done`, name: "size", value: "space.md" },
    ]);
    const btn = ui(r.document, `${PAGE} > #done`);
    if (btn?.kind !== "element") throw new Error();
    expect(btn.props.find((p) => p.name === "variant")?.value).toMatchObject({ kind: "string", value: "secondary" });
    expect(btn.props.find((p) => p.name === "size")?.value).toMatchObject({ kind: "ref", path: "space.md" });
    expect(r.text).toContain('Button#done(onClick: toggle(todo.id), variant: "secondary", size: space.md)');
    expect(r.touched).toEqual([`${PAGE} > #done`]);
  });

  it("remove_prop", () => {
    const r = graft(doc(), [{ op: "remove_prop", address: `${PAGE} > #done`, name: "variant" }]);
    expect(r.text).toContain("Button#done(onClick: toggle(todo.id))");
    expect(() => graft(doc(), [{ op: "remove_prop", address: `${PAGE} > #done`, name: "nope" }])).toThrowError(/O202/);
  });

  it("set_text on element and on text node", () => {
    const r = graft(doc(), [{ op: "set_text", address: `${PAGE} > #done`, value: "Complete" }]);
    expect(ui(r.document, `${PAGE} > #done`)).toMatchObject({ children: [{ kind: "text", value: "Complete" }] });
    expect(r.text).toContain('"Complete"');
    const r2 = graft(r.document, [{ op: "set_text", address: `${PAGE} > #done > text[0]`, value: "Finish" }]);
    expect(r2.text).toContain('"Finish"');
  });

  it("set_id pins and unpins", () => {
    const r = graft(doc(), [{ op: "set_id", address: `${PAGE} > Card[0]`, id: "card" }]);
    expect(ui(r.document, `${PAGE} > #card`)).toMatchObject({ name: "Card" });
    expect(r.touched).toEqual([`${PAGE} > #card`]);
    const r2 = graft(r.document, [{ op: "set_id", address: `${PAGE} > #card`, id: null }]);
    expect(ui(r2.document, `${PAGE} > Card[0]`)).toMatchObject({ name: "Card" });
  });

  it("insert_child from snippet, at index and into a root", () => {
    const r = graft(doc(), [
      { op: "insert_child", address: `${PAGE} > Card[0]`, index: 0, node: 'Text(size: "sm") { "Detail" }' },
      { op: "insert_child", address: PAGE, node: "Divider" },
    ]);
    expect(ui(r.document, `${PAGE} > Card[0] > Text[0]`)).toMatchObject({ props: [{ name: "size" }] });
    expect(ui(r.document, `${PAGE} > Divider[0]`)).toMatchObject({ name: "Divider" });
  });

  it("insert_child into an if branch", () => {
    const r = graft(doc(), [{ op: "insert_child", address: `${PAGE} > Card[0] > if[0] > else`, node: '"also"' }]);
    expect(ui(r.document, `${PAGE} > Card[0] > if[0] > else > text[0]`)).toMatchObject({ value: "also" });
  });

  it("prune", () => {
    const r = graft(doc(), [{ op: "prune", address: `${PAGE} > Card[0] > for[0]` }]);
    expect(ui(r.document, `${PAGE} > Card[0] > for[0]`)).toBeUndefined();
    expect(r.touched).toEqual([]);
  });

  it("replace_node", () => {
    const r = graft(doc(), [{ op: "replace_node", address: `${PAGE} > #done`, node: 'Link#done(href: "/done") { "Done page" }' }]);
    expect(ui(r.document, `${PAGE} > #done`)).toMatchObject({ name: "Link" });
  });

  it("move_node and refuses cycles", () => {
    const r = graft(doc(), [{ op: "move_node", address: `${PAGE} > Card[0] > Text[0]`, to: PAGE, index: 0 }]);
    expect(ui(r.document, `${PAGE} > Text[0]`)).toMatchObject({ children: [{ kind: "expr", code: "todo.description" }] });
    expect(() => graft(doc(), [{ op: "move_node", address: `${PAGE} > Card[0]`, to: `${PAGE} > Card[0] > if[0] > then` }])).toThrowError(/own subtree/);
  });

  it("wrap_node", () => {
    const r = graft(doc(), [{ op: "wrap_node", address: `${PAGE} > #done`, name: "Stack", id: "actions", props: { gap: "space.md" } }]);
    expect(ui(r.document, `${PAGE} > #actions`)).toMatchObject({ name: "Stack", props: [{ name: "gap", value: { kind: "ref", path: "space.md" } }] });
    expect(ui(r.document, `${PAGE} > #done`)).toMatchObject({ name: "Button" });
  });

  it("tokens", () => {
    const r = graft(doc(), [
      { op: "add_token", path: "space.lg", value: 24 },
      { op: "set_token", path: "color.primary", value: "#000" },
      { op: "remove_token", path: "radius.lg" },
      { op: "set_prop", address: "component:Card > Box[0]", name: "radius", value: "space.lg" },
    ]);
    expect(r.text).toContain("space.lg: 24");
    expect(r.text).toContain('color.primary: "#000"');
    expect(r.text).not.toContain("radius.lg");
    expect(() => graft(doc(), [{ op: "add_token", path: "space.md", value: 1 }])).toThrowError(/already exists/);
  });

  it("add_component", () => {
    const r = graft(doc(), [
      { op: "add_component", source: "component Tag(label: string) { Text(size: \"sm\") { label } }" },
      { op: "insert_child", address: `${PAGE} > Card[0]`, node: 'Tag(label: "new")' },
    ]);
    expect(r.document.items.map((i) => i.kind)).toEqual(["import", "tokens", "component", "component", "layout", "page"]);
    expect(r.touched).toContain("component:Tag");
  });

  it("is atomic: invalid results throw O203 and leave the input untouched", () => {
    const d = doc();
    const before = print(d);
    expect(() => graft(d, [{ op: "set_prop", address: `${PAGE} > #done`, name: "colour", value: '"x"' }])).toThrowError(/O203.*O104/);
    expect(print(d)).toBe(before);
    expect(() => graft(d, [{ op: "prune", address: `${PAGE} > Nope[0]` }])).toThrowError(/O201/);
    expect(() => graft(d, [{ op: "bogus" } as never])).toThrowError(/O202/);
  });

  it("can skip validation", () => {
    const r = graft(doc(), [{ op: "set_prop", address: `${PAGE} > #done`, name: "colour", value: '"x"' }], { validate: false });
    expect(r.text).toContain("colour");
  });
});
