import { exprToCode, isEventProp, type Expr, type Prop, type UiNode } from "../ast.js";
import { stamp } from "../address.js";
import { isPrimitive } from "../primitives.js";
import { subtreeIdentifiers, Writer } from "./util.js";


/** What a file needs to import, collected while emitting JSX. */
export interface Needs {
  primitives: Set<string>;
  components: Set<string>;
  /** Declared islands (client components with state) referenced. */
  islands: Set<string>;
  imports: Set<string>; // user import names referenced
  actions: Set<string>;
  tokens: boolean;
  fragment: boolean;
}

export function newNeeds(): Needs {
  return { primitives: new Set(), components: new Set(), islands: new Set(), imports: new Set(), actions: new Set(), tokens: false, fragment: false };
}

export interface Island {
  name: string;
  address: string;
  node: UiNode;
  /** Data props passed from the server component. */
  props: string[];
  needs: Needs;
  jsx: string;
}

export interface JsxContext {
  /** Root address prefix, e.g. `page:/todos/[id]`. */
  rootAddress: string;
  /** Stamp elements with data-orchid and record them. */
  dev: boolean;
  /** Called for every stampable node with its address. */
  onStamp?: (address: string, node: UiNode) => void;
  /** Token paths that exist. */
  tokenPaths: Set<string>;
  /** Names of declared components. */
  componentNames: Set<string>;
  /** Names of declared islands. */
  islandNames: Set<string>;
  /** Names imported by the document. */
  importNames: Set<string>;
  /** Actions declared in the page, if any. */
  actionNames: Set<string>;
  /** Names that are data in scope (load bindings, params, component params). */
  dataNames: Set<string>;
  /** Extract client islands. False while emitting inside an island or a client component. */
  extractIslands: boolean;
  islands: Island[];
  needs: Needs;
}

/** Emit a list of nodes as a JSX expression (fragment if several). */
export function emitJsx(nodes: UiNode[], ctx: JsxContext): string {
  const w = new Writer();
  const body = emitChildren(nodes, ctx, ctx.rootAddress, new Set());
  if (body.length === 1 && !body[0]!.startsWith("{")) {
    body[0]!.split("\n").forEach((l) => w.line(l));
    return w.toString().trimEnd();
  }
  w.line("<>");
  w.indent(() => body.forEach((b) => b.split("\n").forEach((l) => w.line(l))));
  w.line("</>");
  return w.toString().trimEnd();
}

function emitChildren(nodes: UiNode[], ctx: JsxContext, prefix: string, loopVars: Set<string>): string[] {
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const n of nodes) {
    const name = n.kind === "element" ? n.name : n.kind;
    const i = counts.get(name) ?? 0;
    counts.set(name, i + 1);
    const address = n.kind === "element" && n.id ? `${prefix.split(" > ")[0]} > #${n.id}` : `${prefix} > ${name}[${i}]`;
    out.push(emitNode(n, ctx, address, loopVars));
  }
  return out;
}

function emitNode(n: UiNode, ctx: JsxContext, address: string, loopVars: Set<string>): string {
  switch (n.kind) {
    case "text":
      return `{${JSON.stringify(n.value)}}`;
    case "expr":
      noteIdentifiers(n.code, ctx, loopVars);
      return `{${n.code}}`;
    case "slot":
      return `{children}`;
    case "if": {
      const test = emitExpr(n.test, ctx, loopVars);
      const then = wrap(emitChildren(n.then, ctx, `${address} > then`, loopVars), ctx);
      const els = n.else ? wrap(emitChildren(n.else, ctx, `${address} > else`, loopVars), ctx) : "null";
      return `{${test} ? (\n${indent(then)}\n) : ${els === "null" ? "null" : `(\n${indent(els)}\n)`}}`;
    }
    case "for": {
      const iterable = emitExpr(n.iterable, ctx, loopVars);
      const inner = new Set(loopVars);
      inner.add(n.item);
      const index = n.index ?? "__i";
      inner.add(index);
      const key = n.key ? emitExpr(n.key, ctx, inner) : index;
      const body = emitChildren(n.body, ctx, address, inner);
      const b = body.length === 1 && !body[0]!.startsWith("{") ? body[0]! : `<>\n${indent(body.join("\n"))}\n</>`;
      // A keyed fragment needs the long form.
      const keyed = b.startsWith("<>")
        ? `<Fragment key={${key}}>\n${indent(b.slice(3, -3).trim())}\n</Fragment>`
        : b.replace(/^<([A-Za-z_$][\w$.]*)/, `<$1 key={${key}}`);
      if (keyed.startsWith("<Fragment")) ctx.needs.fragment = true;
      return `{${iterable}.map((${n.item}, ${index}) => (\n${indent(keyed)}\n))}`;
    }
    case "element":
      return emitElement(n, ctx, address, loopVars);
  }
}

function emitElement(n: Extract<UiNode, { kind: "element" }>, ctx: JsxContext, address: string, loopVars: Set<string>): string {
  const interactive = n.props.some((p) => isEventProp(p.name));
  if (interactive && ctx.extractIslands) return extractIsland(n, ctx, address, loopVars);

  const primitive = isPrimitive(n.name);
  if (primitive) ctx.needs.primitives.add(n.name);
  else if (ctx.componentNames.has(n.name)) ctx.needs.components.add(n.name);
  else if (ctx.islandNames.has(n.name)) ctx.needs.islands.add(n.name);
  else if (ctx.importNames.has(n.name)) ctx.needs.imports.add(n.name);

  const attrs = n.props.map((p) => emitProp(p, ctx, loopVars));
  if (ctx.dev && primitive) {
    attrs.push(`data-orchid="${stamp(address)}"`);
    ctx.onStamp?.(address, n);
  }
  const open = `<${n.name}${attrs.length ? " " + attrs.join(" ") : ""}`;
  let jsx: string;
  if (!n.children.length) {
    jsx = `${open} />`;
  } else {
    const kids = emitChildren(n.children, ctx, address, loopVars);
    jsx = `${open}>\n${indent(kids.join("\n"))}\n</${n.name}>`;
  }
  if (ctx.dev && !primitive) {
    ctx.onStamp?.(address, n);
    jsx = `<div data-orchid="${stamp(address)}" style={{ display: "contents" }}>\n${indent(jsx)}\n</div>`;
  }
  return jsx;
}

function extractIsland(n: Extract<UiNode, { kind: "element" }>, ctx: JsxContext, address: string, loopVars: Set<string>): string {
  const name = `Island_${n.id ?? stamp(address)}`;
  const sub: JsxContext = { ...ctx, extractIslands: false, needs: newNeeds(), islands: ctx.islands };
  // Emit the subtree with the same address so stamps match the server tree.
  const jsx = emitNode(n, sub, address, loopVars);
  const referenced = subtreeIdentifiers([n]);
  const props = [...referenced].filter((id) => ctx.dataNames.has(id) || loopVars.has(id)).sort();
  ctx.islands.push({ name, address, node: n, props, needs: sub.needs, jsx });
  const attrs = props.map((p) => `${p}={${p}}`);
  return `<${name}${attrs.length ? " " + attrs.join(" ") : ""} />`;
}

function emitProp(p: Prop, ctx: JsxContext, loopVars: Set<string>): string {
  const v = p.value;
  if (v.kind === "boolean") return v.value ? p.name : `${p.name}={false}`;
  if (v.kind === "string") return `${p.name}=${JSON.stringify(v.value)}`;
  if (v.kind === "number") return `${p.name}={${v.value}}`;
  if (isEventProp(p.name)) {
    const code = exprToCode(v);
    noteIdentifiers(code, ctx, loopVars);
    return `${p.name}={${isFunctionLike(code) ? code : `() => ${code}`}}`;
  }
  return `${p.name}={${emitExpr(v, ctx, loopVars)}}`;
}

function emitExpr(e: Expr, ctx: JsxContext, loopVars: Set<string>): string {
  if (e.kind === "ref") {
    if (ctx.tokenPaths.has(e.path)) {
      ctx.needs.tokens = true;
      return `tokens.${e.path}`;
    }
    noteIdentifiers(e.path, ctx, loopVars);
    return e.path;
  }
  if (e.kind === "code") {
    noteIdentifiers(e.code, ctx, loopVars);
    return e.code;
  }
  return exprToCode(e);
}

function noteIdentifiers(code: string, ctx: JsxContext, _loopVars: Set<string>): void {
  const ids = subtreeIdentifiers([{ kind: "expr", code }]);
  for (const id of ids) {
    if (ctx.actionNames.has(id)) ctx.needs.actions.add(id);
    else if (ctx.importNames.has(id)) ctx.needs.imports.add(id);
  }
}

function isFunctionLike(code: string): boolean {
  return /^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) || /^(async\s+)?function\b/.test(code);
}

function wrap(parts: string[], _ctx: JsxContext): string {
  if (parts.length === 1 && !parts[0]!.startsWith("{")) return parts[0]!;
  return `<>\n${indent(parts.join("\n"))}\n</>`;
}

function indent(s: string): string {
  return s.split("\n").map((l) => (l ? "  " + l : l)).join("\n");
}
