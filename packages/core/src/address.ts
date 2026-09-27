import type { ComponentDecl, Document, Item, LayoutDecl, PageDecl, ScenarioDecl, UiNode } from "./ast.js";
import { OrchidError } from "./diagnostics.js";

/**
 * Addresses name UI nodes stably so the overlay, the agent and the graft
 * engine all talk about the same thing.
 *
 *   page:/todos/[id] > Card[0] > Button[0]
 *   page:/todos/[id] > #done
 *   component:Card > Box[0] > Heading[0]
 *   layout:/ > if[0] > then > Text[0]
 *
 * Segments after a `#id` are relative to that node, so reordering siblings
 * elsewhere in the tree does not change the address of anything under a
 * pinned node.
 */

export type Root = PageDecl | LayoutDecl | ComponentDecl;

export interface Located {
  root: Root;
  node: UiNode;
  parent: UiNode[]; // the array the node lives in
  index: number;
  address: string;
}

export function rootAddress(root: Root): string {
  switch (root.kind) {
    case "page": return `page:${root.route}`;
    case "layout": return `layout:${root.route}`;
    case "component": return `component:${root.name}`;
  }
}

export function rootUi(root: Root): UiNode[] {
  return root.kind === "component" ? root.body : root.ui;
}

export function isRoot(item: Item): item is Root {
  return item.kind === "page" || item.kind === "layout" || item.kind === "component";
}

function segmentName(n: UiNode): string {
  switch (n.kind) {
    case "element": return n.name;
    default: return n.kind;
  }
}

/** Walk a root's UI tree, yielding every node with its address. */
export function* walk(root: Root): Generator<Located> {
  yield* walkList(root, rootUi(root), rootAddress(root));
}

function* walkList(root: Root, list: UiNode[], prefix: string): Generator<Located> {
  const counts = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const node = list[i]!;
    const name = segmentName(node);
    const n = counts.get(name) ?? 0;
    counts.set(name, n + 1);
    const seg = node.kind === "element" && node.id ? `#${node.id}` : `${name}[${n}]`;
    // A pinned node restarts the path: everything under it is relative to the id.
    const address = node.kind === "element" && node.id ? `${prefix.split(" > ")[0]} > ${seg}` : `${prefix} > ${seg}`;
    yield { root, node, parent: list, index: i, address };
    if (node.kind === "element") yield* walkList(root, node.children, address);
    if (node.kind === "if") {
      yield* walkList(root, node.then, `${address} > then`);
      if (node.else) yield* walkList(root, node.else, `${address} > else`);
    }
    if (node.kind === "for") yield* walkList(root, node.body, address);
  }
}

/** Every addressable node across a document. */
export function* walkDocument(doc: Document): Generator<Located> {
  for (const item of doc.items) if (isRoot(item)) yield* walk(item);
}

export function findByAddress(doc: Document, address: string): Located | undefined {
  const norm = normalize(address);
  for (const loc of walkDocument(doc)) if (loc.address === norm) return loc;
  return undefined;
}

export function requireAddress(doc: Document, address: string): Located {
  const loc = findByAddress(doc, address);
  if (!loc) {
    throw new OrchidError({ code: "O201", severity: "error", message: `No node at address \`${address}\``, file: doc.file });
  }
  return loc;
}

export function findRoot(doc: Document, address: string): Root | undefined {
  const head = normalize(address).split(" > ")[0]!;
  for (const item of doc.items) if (isRoot(item) && rootAddress(item) === head) return item;
  return undefined;
}

const SEGMENT = /^(#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\[\d+\]|then|else)$/;
const HEAD = /^(page|layout|component|scenario):.+$/;

/** `scenario:<name>` for a scenario declaration. */
export function scenarioAddress(s: ScenarioDecl): string {
  return `scenario:${s.name}`;
}

/** Find a scenario by address (`scenario:<name>`) or bare name. */
export function findScenario(doc: Document, addressOrName: string): ScenarioDecl | undefined {
  const name = addressOrName.startsWith("scenario:") ? addressOrName.slice("scenario:".length).trim() : addressOrName;
  return doc.items.find((i): i is ScenarioDecl => i.kind === "scenario" && i.name === name);
}

/** Validate and normalise whitespace in an address. */
export function normalize(address: string): string {
  const parts = address.split(">").map((p) => p.trim());
  if (!HEAD.test(parts[0] ?? "")) {
    throw new OrchidError({ code: "O204", severity: "error", message: `Invalid address \`${address}\`: must start with page:, layout:, component: or scenario:` });
  }
  for (const p of parts.slice(1)) {
    if (!SEGMENT.test(p)) {
      throw new OrchidError({ code: "O204", severity: "error", message: `Invalid address segment \`${p}\` in \`${address}\`` });
    }
  }
  return parts.join(" > ");
}

/** Deepest address that is a prefix of every given address. */
export function commonAncestor(addresses: string[]): string | undefined {
  if (!addresses.length) return undefined;
  const split = addresses.map((a) => normalize(a).split(" > "));
  const first = split[0]!;
  let n = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i++;
    n = i;
  }
  return n === 0 ? undefined : first.slice(0, n).join(" > ");
}

/** Short stable hash of an address, used as the `data-orchid` stamp. */
export function stamp(address: string): string {
  // FNV-1a 32-bit, hex. Collisions within one project are vanishingly unlikely
  // and the map file makes them detectable.
  let h = 0x811c9dc5;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
