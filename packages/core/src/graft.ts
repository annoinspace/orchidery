import { z } from "zod";
import { Expr, type ComponentDecl, type Document, type Element, type Item, type ScenarioStep, type TokensDecl, type UiNode } from "./ast.js";
import { findByAddress, findScenario, isRoot, normalize, requireAddress, rootAddress, scenarioAddress, walkDocument, type Located } from "./address.js";
import { OrchidError, type Diagnostic } from "./diagnostics.js";
import { parseExpr, parseItem, parseUiSnippet } from "./parser.js";
import { print } from "./print.js";
import type { Program } from "./program.js";
import { validate } from "./validate.js";

// ---------------------------------------------------------------------------
// Graft operations: the structural edits an agent may make. Each targets a
// node by address. `node` fields accept either an AST node or a snippet of
// .orchid source, so an agent can write what it knows best.
// ---------------------------------------------------------------------------

const Address = z.string().describe("A node address such as `page:/todos/[id] > Card[0] > #done`");
const NodeInput = z.union([z.string().describe(".orchid ui snippet"), z.any()]);
const ValueInput = z.union([z.string().describe("Raw value as it would appear in source, e.g. `\"primary\"`, `space.md`, `todo.title`"), Expr]);

export const GraftOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_prop"), address: Address, name: z.string(), value: ValueInput }),
  z.object({ op: z.literal("remove_prop"), address: Address, name: z.string() }),
  z.object({ op: z.literal("set_text"), address: Address, value: z.string() }).describe("Replace a text node's value, or an element's children with a single text node"),
  z.object({ op: z.literal("set_id"), address: Address, id: z.string().nullable() }).describe("Pin (or unpin with null) a node with a #id"),
  z.object({ op: z.literal("insert_child"), address: Address, index: z.number().int().optional(), node: NodeInput }).describe("Insert into an element's children (or a root's ui when address is just the root). Appends when index is omitted"),
  z.object({ op: z.literal("prune"), address: Address }).describe("Remove a node"),
  z.object({ op: z.literal("replace_node"), address: Address, node: NodeInput }),
  z.object({ op: z.literal("move_node"), address: Address, to: Address, index: z.number().int().optional() }).describe("Move a node under another element (or a root)"),
  z.object({ op: z.literal("wrap_node"), address: Address, name: z.string(), id: z.string().optional(), props: z.record(z.string(), ValueInput).optional() }).describe("Wrap a node in a new element"),
  z.object({ op: z.literal("add_token"), path: z.string(), value: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal("set_token"), path: z.string(), value: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal("remove_token"), path: z.string() }),
  z.object({ op: z.literal("add_component"), source: z.string().describe("A full `component Name(...) { ... }` declaration") }),
  z.object({ op: z.literal("add_scenario"), source: z.string().describe("A full `scenario \"name\" { steps }` declaration") }),
  z.object({ op: z.literal("set_step"), scenario: z.string().describe("Scenario name or `scenario:<name>`"), index: z.number().int(), step: z.string().describe("One step line, e.g. `click \"#toggle\"`") }).describe("Replace a step"),
  z.object({ op: z.literal("insert_step"), scenario: z.string(), index: z.number().int().optional(), step: z.string() }).describe("Insert a step; appends when index is omitted"),
  z.object({ op: z.literal("remove_step"), scenario: z.string(), index: z.number().int() }),
  z.object({ op: z.literal("remove_scenario"), scenario: z.string() }),
]);
export type GraftOp = z.infer<typeof GraftOp>;

export function graftOpsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(z.array(GraftOp), { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

export interface GraftResult {
  /** The updated document. */
  document: Document;
  /** Canonical source text of the updated document. */
  text: string;
  /** Addresses touched by the ops, in the updated document where they still exist. */
  touched: string[];
  /** Validation diagnostics of the resulting program (empty on success). */
  diagnostics: Diagnostic[];
}

export interface GraftOptions {
  /** Validate the resulting program; on errors, throw O203 and change nothing. Default true. */
  validate?: boolean;
  /** Other documents in the project, for cross-file validation. */
  program?: Program;
}

/**
 * Apply graft ops to a document atomically. Ops are applied in order, each
 * resolving addresses against the document as left by the previous op.
 */
export function graft(doc: Document, ops: GraftOp[], opts: GraftOptions = {}): GraftResult {
  const parsed = z.array(GraftOp).safeParse(ops);
  if (!parsed.success) {
    throw new OrchidError({ code: "O202", severity: "error", message: `Invalid graft ops: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
  }
  const next: Document = structuredClone(doc);
  const touched = new Set<string>();

  for (const op of parsed.data) applyOp(next, op, touched);

  const program: Program = opts.program
    ? { documents: opts.program.documents.map((d) => (d === doc || (d.file && d.file === doc.file) ? next : d)) }
    : { documents: [next] };
  if (!opts.program?.documents.includes(doc) && opts.program) program.documents.push(next);

  const diagnostics = opts.validate === false ? [] : validate(program).filter((d) => d.severity === "error");
  if (diagnostics.length) {
    throw new OrchidError({
      code: "O203",
      severity: "error",
      message: `Graft would leave the document invalid: ${diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`,
      file: doc.file,
    });
  }

  const alive = new Set([...walkDocument(next)].map((l) => l.address));
  for (const item of next.items) {
    if (isRoot(item)) alive.add(rootAddress(item));
    if (item.kind === "scenario") alive.add(scenarioAddress(item));
  }
  return { document: next, text: print(next), touched: [...touched].filter((a) => alive.has(a)), diagnostics };
}

// ---------------------------------------------------------------------------

function applyOp(doc: Document, op: GraftOp, touched: Set<string>): void {
  switch (op.op) {
    case "set_prop": {
      const el = requireElement(doc, op.address);
      const value = toExpr(op.value);
      const existing = el.props.find((p) => p.name === op.name);
      if (existing) existing.value = value;
      else el.props.push({ kind: "prop", name: op.name, value });
      touched.add(normalize(op.address));
      return;
    }
    case "remove_prop": {
      const el = requireElement(doc, op.address);
      const i = el.props.findIndex((p) => p.name === op.name);
      if (i < 0) fail("O202", `No prop \`${op.name}\` on ${op.address}`);
      el.props.splice(i, 1);
      touched.add(normalize(op.address));
      return;
    }
    case "set_text": {
      const loc = requireAddress(doc, op.address);
      if (loc.node.kind === "text") loc.node.value = op.value;
      else if (loc.node.kind === "element") loc.node.children = [{ kind: "text", value: op.value }];
      else fail("O202", `set_text needs a text node or element at ${op.address}, found ${loc.node.kind}`);
      touched.add(normalize(op.address));
      return;
    }
    case "set_id": {
      const el = requireElement(doc, op.address);
      if (op.id === null) delete el.id;
      else el.id = op.id;
      touched.add(op.id ? `${normalize(op.address).split(" > ")[0]} > #${op.id}` : normalize(op.address));
      return;
    }
    case "insert_child": {
      const list = childList(doc, op.address);
      const nodes = toNodes(op.node);
      const at = op.index ?? list.length;
      list.splice(Math.min(at, list.length), 0, ...nodes);
      touched.add(normalize(op.address));
      return;
    }
    case "prune": {
      const loc = requireAddress(doc, op.address);
      loc.parent.splice(loc.index, 1);
      touched.add(normalize(op.address));
      return;
    }
    case "replace_node": {
      const loc = requireAddress(doc, op.address);
      const nodes = toNodes(op.node);
      loc.parent.splice(loc.index, 1, ...nodes);
      touched.add(normalize(op.address));
      return;
    }
    case "move_node": {
      const loc = requireAddress(doc, op.address);
      const targetList = childList(doc, op.to);
      if (containsList(loc.node, targetList)) fail("O202", `Cannot move ${op.address} into its own subtree`);
      loc.parent.splice(loc.index, 1);
      const at = op.index ?? targetList.length;
      targetList.splice(Math.min(at, targetList.length), 0, loc.node);
      touched.add(normalize(op.to));
      return;
    }
    case "wrap_node": {
      const loc = requireAddress(doc, op.address);
      const wrapper: Element = {
        kind: "element",
        name: op.name,
        id: op.id,
        props: Object.entries(op.props ?? {}).map(([name, v]) => ({ kind: "prop" as const, name, value: toExpr(v) })),
        children: [loc.node],
      };
      loc.parent.splice(loc.index, 1, wrapper);
      touched.add(normalize(op.address));
      return;
    }
    case "add_token":
    case "set_token": {
      let tokens = doc.items.find((i): i is TokensDecl => i.kind === "tokens");
      if (!tokens) {
        tokens = { kind: "tokens", entries: [] };
        doc.items.unshift(tokens);
      }
      const existing = tokens.entries.find((e) => e.path === op.path);
      if (existing) {
        if (op.op === "add_token") fail("O202", `Token \`${op.path}\` already exists; use set_token`);
        existing.value = op.value;
      } else {
        tokens.entries.push({ kind: "token", path: op.path, value: op.value });
      }
      return;
    }
    case "remove_token": {
      const tokens = doc.items.find((i): i is TokensDecl => i.kind === "tokens");
      const i = tokens?.entries.findIndex((e) => e.path === op.path) ?? -1;
      if (!tokens || i < 0) fail("O202", `No token \`${op.path}\``);
      tokens.entries.splice(i, 1);
      return;
    }
    case "add_component": {
      const item: Item = parseItem(op.source);
      if (item.kind !== "component") fail("O202", "add_component needs a `component` declaration");
      if (doc.items.some((i) => i.kind === "component" && i.name === (item as ComponentDecl).name)) {
        fail("O202", `Component \`${item.name}\` already exists`);
      }
      // Components go after tokens/imports and before pages.
      const firstPage = doc.items.findIndex((i) => i.kind === "page" || i.kind === "layout");
      doc.items.splice(firstPage < 0 ? doc.items.length : firstPage, 0, item);
      touched.add(`component:${item.name}`);
      return;
    }
    case "add_scenario": {
      const item: Item = parseItem(op.source);
      if (item.kind !== "scenario") fail("O202", "add_scenario needs a `scenario` declaration");
      if (findScenario(doc, item.name)) fail("O202", `Scenario \`${item.name}\` already exists`);
      doc.items.push(item);
      touched.add(scenarioAddress(item));
      return;
    }
    case "remove_scenario": {
      const s = findScenario(doc, op.scenario);
      if (!s) fail("O201", `No scenario \`${op.scenario}\``);
      doc.items.splice(doc.items.indexOf(s), 1);
      return;
    }
    case "set_step":
    case "insert_step":
    case "remove_step": {
      const s = findScenario(doc, op.scenario);
      if (!s) fail("O201", `No scenario \`${op.scenario}\``);
      if (op.op === "insert_step") {
        const at = op.index ?? s.steps.length;
        s.steps.splice(Math.min(at, s.steps.length), 0, parseStep(op.step));
      } else {
        if (op.index < 0 || op.index >= s.steps.length) fail("O201", `Scenario \`${s.name}\` has no step ${op.index}`);
        if (op.op === "remove_step") s.steps.splice(op.index, 1);
        else s.steps[op.index] = parseStep(op.step);
      }
      touched.add(scenarioAddress(s));
      return;
    }
  }
}

function parseStep(line: string): ScenarioStep {
  const item = parseItem(`scenario "_" {\n${line}\n}`);
  if (item.kind !== "scenario" || item.steps.length !== 1) fail("O202", `Expected exactly one scenario step, got \`${line}\``);
  const step = item.steps[0]!;
  delete step.span;
  return step;
}

function requireElement(doc: Document, address: string): Element {
  const loc = requireAddress(doc, address);
  if (loc.node.kind !== "element") fail("O202", `${address} is a ${loc.node.kind}, not an element`);
  return loc.node;
}

/** The child list an address denotes: a root's ui, an element's children, or an if/for branch. */
function childList(doc: Document, address: string): UiNode[] {
  const norm = normalize(address);
  const parts = norm.split(" > ");
  if (parts.length === 1) {
    for (const item of doc.items) {
      if (item.kind === "page" && `page:${item.route}` === norm) return item.ui;
      if (item.kind === "layout" && `layout:${item.route}` === norm) return item.ui;
      if (item.kind === "component" && `component:${item.name}` === norm) return item.body;
    }
    fail("O201", `No root at address \`${address}\``);
  }
  const last = parts[parts.length - 1]!;
  if (last === "then" || last === "else") {
    const parent = findByAddress(doc, parts.slice(0, -1).join(" > "));
    if (!parent || parent.node.kind !== "if") fail("O201", `No if node at \`${address}\``);
    if (last === "then") return parent.node.then;
    parent.node.else ??= [];
    return parent.node.else;
  }
  const loc: Located = requireAddress(doc, norm);
  if (loc.node.kind === "element") return loc.node.children;
  if (loc.node.kind === "for") return loc.node.body;
  if (loc.node.kind === "if") return loc.node.then;
  fail("O202", `${address} is a ${loc.node.kind} and cannot have children`);
}

function containsList(node: UiNode, list: UiNode[]): boolean {
  if (node.kind === "element") return node.children === list || node.children.some((c) => containsList(c, list));
  if (node.kind === "if") return node.then === list || node.else === list || [...node.then, ...(node.else ?? [])].some((c) => containsList(c, list));
  if (node.kind === "for") return node.body === list || node.body.some((c) => containsList(c, list));
  return false;
}

function toExpr(v: unknown): Expr {
  if (typeof v === "string") return parseExpr(v);
  const r = Expr.safeParse(v);
  if (!r.success) fail("O202", `Invalid expression value: ${JSON.stringify(v)}`);
  return r.data;
}

function toNodes(v: unknown): UiNode[] {
  if (typeof v === "string") return parseUiSnippet(v);
  if (Array.isArray(v)) return v.flatMap(toNodes);
  if (v && typeof v === "object" && "kind" in v) return [structuredClone(v as UiNode)];
  fail("O202", "node must be a .orchid snippet or an AST node");
}

function fail(code: string, message: string): never {
  throw new OrchidError({ code, severity: "error", message });
}
