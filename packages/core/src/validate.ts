import { isEventProp, setterName, type Document, type Expr, type Prop, type Span, type UiNode } from "./ast.js";
import { isRoot, rootAddress, rootUi, type Root, walk } from "./address.js";
import type { Diagnostic } from "./diagnostics.js";
import { PRIMITIVES, allowedProps, isPrimitive } from "./primitives.js";
import { exprIdentifiers } from "./emit/util.js";
import {
  componentsOf,
  islandsOf,
  importedNames,
  layoutsOf,
  pagesOf,
  tokenNamespaces,
  tokensOf,
  type Program,
} from "./program.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;
const CALL = /^([A-Za-z_$][\w$]*)\s*\((.*)\)$/s;

/** Validate a whole program. Returns diagnostics; empty means valid. */
export function validate(program: Program): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tokens = new Set(tokensOf(program).map((t) => t.path));
  const namespaces = tokenNamespaces(program);
  const components = new Map([...componentsOf(program), ...islandsOf(program)].map((c) => [c.name, c] as const));

  // Duplicate components and islands (O111)
  const seenComponents = new Set<string>();
  for (const c of [...componentsOf(program), ...islandsOf(program)]) {
    if (seenComponents.has(c.name)) out.push(diag("O111", `${c.kind === "island" ? "Island" : "Component"} \`${c.name}\` is declared more than once`, fileOf(program, c), c.span));
    seenComponents.add(c.name);
  }

  // Duplicate routes (O101)
  for (const [label, items] of [["page", pagesOf(program)], ["layout", layoutsOf(program)]] as const) {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.route)) out.push(diag("O101", `Route \`${it.route}\` is declared by more than one ${label}`, fileOf(program, it), it.span));
      seen.add(it.route);
    }
  }

  for (const doc of program.documents) {
    const imports = importedNames(doc);
    for (const item of doc.items) {
      if (!isRoot(item)) continue;
      validateRoot(item, { doc, imports, tokens, namespaces, components, out });
    }
  }

  validateScenarios(program, out);
  validateResources(program, out);
  return out;
}

function validateResources(program: Program, out: Diagnostic[]): void {
  const seen = new Set<string>();
  for (const doc of program.documents) {
    for (const r of doc.items) {
      if (r.kind !== "resource") continue;
      if (seen.has(r.name)) out.push(diag("O121", `Resource \`${r.name}\` is declared more than once`, doc.file, r.span));
      seen.add(r.name);
      if (!r.fields.length) out.push(diag("O120", `Resource \`${r.name}\` has no fields`, doc.file, r.span));
      if (!r.source) out.push(diag("O120", `Resource \`${r.name}\` needs a \`source\` such as db.${r.name.toLowerCase()}s`, doc.file, r.span));
      if (!r.routes) out.push(diag("O120", `Resource \`${r.name}\` needs \`routes "/path"\``, doc.file, r.span));
      const fields = new Set<string>();
      for (const f of r.fields) {
        if (f.name === "id") out.push(diag("O120", `Field \`id\` is implicit on every resource`, doc.file, f.span));
        if (fields.has(f.name)) out.push(diag("O121", `Field \`${f.name}\` is declared twice on ${r.name}`, doc.file, f.span));
        fields.add(f.name);
      }
    }
  }
}

/** Scenarios: unique names (O117), start with visit (O119), targets resolve (O118). */
function validateScenarios(program: Program, out: Diagnostic[]): void {
  const addresses = new Set<string>();
  const ids = new Set<string>();
  for (const doc of program.documents) {
    for (const item of doc.items) {
      if (!isRoot(item)) continue;
      addresses.add(rootAddress(item));
      for (const loc of walk(item)) {
        addresses.add(loc.address);
        if (loc.node.kind === "element" && loc.node.id) ids.add(loc.node.id);
      }
    }
  }
  const seen = new Set<string>();
  for (const doc of program.documents) {
    for (const s of doc.items) {
      if (s.kind !== "scenario") continue;
      if (seen.has(s.name)) out.push(diag("O117", `Scenario \`${s.name}\` is declared more than once`, doc.file, s.span));
      seen.add(s.name);
      if (s.steps[0]?.kind !== "visit") out.push(diag("O119", `Scenario \`${s.name}\` must start with a \`visit\` step`, doc.file, s.steps[0]?.span ?? s.span));
      for (const step of s.steps) {
        if (!("target" in step)) continue;
        const t = step.target.trim();
        if (t.startsWith("#")) {
          if (!ids.has(t.slice(1))) {
            const near = closest(t.slice(1), [...ids]);
            out.push({ ...diag("O118", `No node with id \`${t}\` in any page`, doc.file, step.span), fix: near ? { description: `Did you mean \`#${near}\`?`, replacement: `#${near}` } : undefined });
          }
        } else if (!addresses.has(t.split(">").map((p) => p.trim()).join(" > "))) {
          out.push(diag("O118", `Address \`${t}\` does not exist`, doc.file, step.span));
        }
      }
    }
  }
}

interface Ctx {
  doc: Document;
  imports: Set<string>;
  tokens: Set<string>;
  namespaces: Set<string>;
  components: Map<string, { params: { name: string }[] }>;
  out: Diagnostic[];
}

function validateRoot(root: Root, ctx: Ctx): void {
  const file = ctx.doc.file;
  const scope = new Set<string>(ctx.imports);
  const actions = new Map<string, number>();

  if (root.kind === "component" || root.kind === "island") for (const p of root.params) scope.add(p.name);
  if (root.kind === "island") {
    const seen = new Set<string>();
    for (const st of root.state) {
      if (seen.has(st.name)) ctx.out.push(diag("O111", `State \`${st.name}\` is declared more than once in ${rootAddress(root)}`, file, st.span));
      seen.add(st.name);
      scope.add(st.name);
      scope.add(setterName(st.name));
    }
  }
  if (root.kind === "page") {
    const seen = new Set<string>();
    for (const a of root.actions) {
      if (seen.has(a.name)) ctx.out.push(diag("O111", `Action \`${a.name}\` is declared more than once in ${rootAddress(root)}`, file, a.span));
      seen.add(a.name);
      actions.set(a.name, a.params.length);
      scope.add(a.name);
    }
  }
  if ((root.kind === "page" || root.kind === "layout") && root.load) {
    const seen = new Set<string>();
    for (const b of root.load.bindings) {
      if (seen.has(b.name)) ctx.out.push(diag("O111", `Load binding \`${b.name}\` is declared more than once in ${rootAddress(root)}`, file, b.span));
      if (ctx.imports.has(b.name) && exprIdentifiers(b.expr).has(b.name)) {
        ctx.out.push(diag("O122", `Load binding \`${b.name}\` shadows the import it reads from; rename the binding`, file, b.span));
      }
      seen.add(b.name);
      scope.add(b.name);
    }
    scope.add("params");
    scope.add("searchParams");
  }

  // Layout must render children (O110)
  if (root.kind === "layout" && !hasSlot(root.ui)) {
    ctx.out.push(diag("O110", `Layout \`${root.route}\` never renders \`children\``, file, root.span));
  }

  const ids = new Set<string>();
  for (const loc of walk(root)) {
    const n = loc.node;
    if (n.kind === "slot" && root.kind === "page") {
      ctx.out.push(diag("O114", "`children` can only be rendered inside a component or layout", file, n.span));
    }
    if (n.kind !== "element") continue;

    if (n.id) {
      if (ids.has(n.id)) ctx.out.push(diag("O106", `Duplicate id \`#${n.id}\` in ${rootAddress(root)}`, file, n.span));
      ids.add(n.id);
    }

    // Duplicate props (O113)
    const seenProps = new Set<string>();
    for (const p of n.props) {
      if (seenProps.has(p.name)) ctx.out.push(diag("O113", `Prop \`${p.name}\` is given twice on ${n.name}`, file, p.span));
      seenProps.add(p.name);
    }

    if (isPrimitive(n.name)) {
      const allowed = allowedProps(n.name)!;
      for (const p of n.props) {
        if (!allowed.includes(p.name)) {
          const near = closest(p.name, allowed);
          ctx.out.push({
            ...diag("O104", `Unknown prop \`${p.name}\` on ${n.name}`, file, p.span),
            fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined,
          });
        }
      }
      for (const r of PRIMITIVES[n.name]!.required ?? []) {
        if (!n.props.some((p) => p.name === r)) ctx.out.push(diag("O105", `${n.name} requires prop \`${r}\``, file, n.span));
      }
    } else if (ctx.components.has(n.name)) {
      const params = ctx.components.get(n.name)!.params.map((p) => p.name);
      for (const p of n.props) {
        if (!params.includes(p.name) && p.name !== "children") {
          const near = closest(p.name, params);
          ctx.out.push({
            ...diag("O112", `Unknown prop \`${p.name}\` on component ${n.name}`, file, p.span),
            fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined,
          });
        }
      }
    } else if (!ctx.imports.has(n.name)) {
      const near = closest(n.name, [...Object.keys(PRIMITIVES), ...ctx.components.keys()]);
      ctx.out.push({
        ...diag("O102", `Unknown component \`${n.name}\``, file, n.span),
        fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined,
      });
    }

    for (const p of n.props) {
      checkTokenRef(p.value, ctx, file);
      if (isEventProp(p.name)) checkHandler(p, root, scope, actions, ctx, file);
    }
  }
}

function checkTokenRef(e: Expr, ctx: Ctx, file?: string): void {
  if (e.kind !== "ref") return;
  const ns = e.path.split(".")[0]!;
  if (ctx.namespaces.has(ns) && !ctx.tokens.has(e.path)) {
    const near = closest(e.path, [...ctx.tokens].filter((t) => t.startsWith(ns + ".")));
    ctx.out.push({
      ...diag("O103", `Unknown token \`${e.path}\``, file, e.span),
      fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined,
    });
  }
}

function checkHandler(p: Prop, root: Root, scope: Set<string>, actions: Map<string, number>, ctx: Ctx, file?: string): void {
  if (root.kind === "layout") {
    ctx.out.push(diag("O107", `Event prop \`${p.name}\` is not allowed in a layout; move it into a page or component`, file, p.span));
    return;
  }
  const code = p.value.kind === "code" ? p.value.code : p.value.kind === "ref" ? p.value.path : undefined;
  if (!code) return;
  let callee: string | undefined;
  let argc: number | undefined;
  const m = CALL.exec(code);
  if (m) {
    callee = m[1];
    argc = m[2]!.trim() === "" ? 0 : splitArgs(m[2]!).length;
  } else if (IDENT.test(code)) {
    callee = code;
  }
  if (!callee) return; // arrow function or other expression: left to tsc
  if (root.kind === "page" && !scope.has(callee) && !isLoopVar(root, callee)) {
    const near = closest(callee, [...actions.keys()]);
    ctx.out.push({
      ...diag("O108", `\`${callee}\` is not an action declared in ${rootAddress(root)}`, file, p.value.span ?? p.span),
      fix: near ? { description: `Did you mean \`${near}\`?`, replacement: near } : undefined,
    });
    return;
  }
  if (argc !== undefined && actions.has(callee) && actions.get(callee) !== argc) {
    ctx.out.push(diag("O109", `Action \`${callee}\` takes ${actions.get(callee)} argument(s) but is called with ${argc}`, file, p.value.span ?? p.span));
  }
}

function isLoopVar(root: Root, name: string): boolean {
  for (const loc of walk(root)) {
    if (loc.node.kind === "for" && (loc.node.item === name || loc.node.index === name)) return true;
  }
  return false;
}

function hasSlot(nodes: UiNode[]): boolean {
  for (const n of nodes) {
    if (n.kind === "slot") return true;
    if (n.kind === "element" && hasSlot(n.children)) return true;
    if (n.kind === "if" && (hasSlot(n.then) || (n.else ? hasSlot(n.else) : false))) return true;
    if (n.kind === "for" && hasSlot(n.body)) return true;
  }
  return false;
}

export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") { cur += s[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function fileOf(program: Program, item: object): string | undefined {
  return program.documents.find((d) => d.items.includes(item as never))?.file;
}

function diag(code: string, message: string, file?: string, range?: Span): Diagnostic {
  return { code, severity: "error", message, file, range };
}

/** Closest candidate by edit distance, if within a sensible threshold. */
export function closest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]!;
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i]!;
      dp[i] = Math.min(dp[i]! + 1, dp[i - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[a.length]!;
}

void rootUi;
