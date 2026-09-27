import { z } from "zod";
import { UiNode, isEventProp, type Expr } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";
import { OrchidError } from "./diagnostics.js";
import { parseUiSnippet } from "./parser.js";
import { allowedProps, isPrimitive, PRIMITIVES } from "./primitives.js";
import { closest, splitArgs } from "./validate.js";

/**
 * Fragments are the contents of a `ui { }` block rendered at runtime from
 * model output. They must be safe to evaluate without a compiler, so their
 * expressions are restricted to:
 *
 *   - literals: "text", 42, true
 *   - data paths: data.order.total, or a loop variable: item.name
 *   - tokens: space.md, color.primary
 *   - actions on event props: act("name", data.order.id, "literal")
 *
 * Anything else is rejected with an O3xx diagnostic before rendering.
 */

export interface FragmentOptions {
  /** Names of host components allowed in addition to the primitives. */
  components?: string[];
  /** Top-level keys of the data object the fragment may read. Omit to allow any `data.*` path. */
  data?: string[];
  /** Action names the fragment may call. Omit to allow any name. */
  actions?: string[];
  /** Token namespaces (`space`, `color`, ...) or full paths. Omit to allow any dotted ref whose head is not `data`. */
  tokens?: string[];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const ACT_CALL = /^act\s*\((.*)\)$/s;
const STRING = /^"(?:\\.|[^"\\])*"$|^'(?:\\.|[^'\\])*'$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TEMPLATE = /^`(?:\\.|[^`\\])*`$/;

export function parseFragment(source: string): UiNode[] {
  return parseUiSnippet(source);
}

/** JSON Schema for a fragment (an array of ui nodes), for structured output. */
export function fragmentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(z.array(UiNode), { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

/** A parsed action call from an event prop. */
export interface ActionCall {
  name: string;
  args: Expr[];
}

/** Parse `act("name", arg, ...)`; undefined if the code is not an action call. */
export function parseActionCall(code: string): ActionCall | undefined {
  const m = ACT_CALL.exec(code.trim());
  if (!m) return undefined;
  const parts = splitArgs(m[1]!);
  if (!parts.length) return undefined;
  const name = parts[0]!;
  if (!STRING.test(name)) return undefined;
  const args = parts.slice(1).map(classify);
  if (args.some((a) => a.kind === "code")) return undefined;
  return { name: JSON.parse(name.replace(/^'|'$/g, '"')) as string, args };
}

/** Classify raw text as a fragment-safe expression. `code` means unsafe. */
export function classify(raw: string): Expr {
  const s = raw.trim();
  if (STRING.test(s)) return { kind: "string", value: JSON.parse(s.startsWith("'") ? `"${s.slice(1, -1).replace(/"/g, '\\"')}"` : s) as string };
  if (NUMBER.test(s)) return { kind: "number", value: Number(s) };
  if (s === "true" || s === "false") return { kind: "boolean", value: s === "true" };
  if (DOTTED.test(s)) return { kind: "ref", path: s };
  return { kind: "code", code: s };
}

export function validateFragment(nodes: UiNode[], opts: FragmentOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const components = new Set(opts.components ?? []);
  visit(nodes, new Set(), { opts, components, out });
  return out;
}

interface Ctx {
  opts: FragmentOptions;
  components: Set<string>;
  out: Diagnostic[];
}

function visit(nodes: UiNode[], scope: Set<string>, ctx: Ctx): void {
  for (const n of nodes) {
    switch (n.kind) {
      case "text":
        break;
      case "slot":
        ctx.out.push(diag("O302", "`children` is not available in a fragment", n));
        break;
      case "expr":
        checkExpr(classify(n.code), scope, ctx, n, "expression");
        break;
      case "if":
        checkExpr(n.test.kind === "code" ? classify(n.test.code) : n.test, scope, ctx, n, "if condition");
        visit(n.then, scope, ctx);
        if (n.else) visit(n.else, scope, ctx);
        break;
      case "for": {
        checkExpr(n.iterable.kind === "code" ? classify(n.iterable.code) : n.iterable, scope, ctx, n, "for iterable");
        const inner = new Set(scope);
        inner.add(n.item);
        if (n.index) inner.add(n.index);
        if (n.key) checkExpr(n.key.kind === "code" ? classify(n.key.code) : n.key, inner, ctx, n, "for key");
        visit(n.body, inner, ctx);
        break;
      }
      case "element": {
        if (!isPrimitive(n.name) && !ctx.components.has(n.name)) {
          const near = closest(n.name, [...Object.keys(PRIMITIVES), ...ctx.components]);
          ctx.out.push({ ...diag("O301", `Unknown element \`${n.name}\` in fragment`, n), fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined });
        }
        const allowed = isPrimitive(n.name) ? allowedProps(n.name)! : undefined;
        const seen = new Set<string>();
        for (const p of n.props) {
          if (seen.has(p.name)) ctx.out.push(diag("O113", `Prop \`${p.name}\` is given twice on ${n.name}`, p));
          seen.add(p.name);
          if (allowed && !allowed.includes(p.name)) {
            const near = closest(p.name, allowed);
            ctx.out.push({ ...diag("O104", `Unknown prop \`${p.name}\` on ${n.name}`, p), fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined });
          }
          if (isEventProp(p.name)) {
            const code = p.value.kind === "code" ? p.value.code : p.value.kind === "ref" ? p.value.path : undefined;
            const call = code ? parseActionCall(code) : undefined;
            if (!call) {
              ctx.out.push(diag("O302", `Event prop \`${p.name}\` on ${n.name} must be an action call such as act("save", data.id)`, p));
              continue;
            }
            if (ctx.opts.actions && !ctx.opts.actions.includes(call.name)) {
              const near = closest(call.name, ctx.opts.actions);
              ctx.out.push({ ...diag("O303", `Unknown action \`${call.name}\``, p), fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined });
            }
            for (const a of call.args) checkExpr(a, scope, ctx, p, `argument of act("${call.name}")`);
          } else {
            checkExpr(p.value.kind === "code" ? classify(p.value.code) : p.value, scope, ctx, p, `prop \`${p.name}\``);
          }
        }
        for (const r of (isPrimitive(n.name) ? PRIMITIVES[n.name]!.required : undefined) ?? []) {
          if (!n.props.some((p) => p.name === r)) ctx.out.push(diag("O105", `${n.name} requires prop \`${r}\``, n));
        }
        visit(n.children, scope, ctx);
        break;
      }
    }
  }
}

function checkExpr(e: Expr, scope: Set<string>, ctx: Ctx, at: { span?: UiNode["span"] }, what: string): void {
  if (e.kind === "code") {
    if (TEMPLATE.test(e.code.trim())) {
      // Template literals are allowed when every interpolation is itself safe.
      const inner = [...e.code.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!.trim());
      for (const i of inner) checkExpr(classify(i), scope, ctx, at, what);
      return;
    }
    ctx.out.push(diag("O302", `Unsafe ${what} \`${truncate(e.code)}\`: fragments allow literals, data paths, tokens and act(...) calls only`, at));
    return;
  }
  if (e.kind !== "ref") return;
  const head = e.path.split(".")[0]!;
  if (scope.has(head)) return;
  if (head === "data") {
    const key = e.path.split(".")[1];
    if (ctx.opts.data && key !== undefined && !ctx.opts.data.includes(key)) {
      const near = closest(key, ctx.opts.data);
      ctx.out.push({ ...diag("O304", `Unknown data path \`${e.path}\``, at), fix: near ? { description: `Did you mean \`data.${near}\`?`, replacement: `data.${near}` } : undefined });
    }
    return;
  }
  if (IDENT.test(e.path) && !scope.has(e.path)) {
    ctx.out.push(diag("O304", `Unknown name \`${e.path}\` in ${what}; use data.${e.path} to read host data`, at));
    return;
  }
  const tokens = ctx.opts.tokens ?? DEFAULT_TOKEN_NAMESPACES;
  if (!tokens.includes(head) && !tokens.includes(e.path)) {
    ctx.out.push(diag("O304", `Unknown token or name \`${e.path}\` in ${what}; read host data as data.${e.path}`, at));
  }
}

/** Token namespaces a fragment may reference when the host does not list its own. */
export const DEFAULT_TOKEN_NAMESPACES = ["color", "space", "radius", "size", "font", "shadow", "weight", "z", "opacity", "line"];

function diag(code: string, message: string, at: { span?: UiNode["span"] }): Diagnostic {
  return { code, severity: "error", message, range: at.span };
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}

/** Read a dotted path from a scope object; undefined when any step is missing. */
export function readPath(path: string, scope: Record<string, unknown>): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parse and validate in one go; throws the first error as an OrchidError. */
export function fragment(source: string, opts: FragmentOptions = {}): UiNode[] {
  const nodes = parseFragment(source);
  const d = validateFragment(nodes, opts);
  if (d.length) throw new OrchidError(d[0]!);
  return nodes;
}
