import type { Expr, UiNode } from "../ast.js";

/** Identifiers referenced in a piece of code, excluding property names after `.`. */
export function identifiers(code: string): Set<string> {
  const out = new Set<string>();
  const stripped = code
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^${}]/g, " ")) // keep ${} interpolations only
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) out.add(m[2]!);
  return out;
}

export function exprIdentifiers(e: Expr): Set<string> {
  switch (e.kind) {
    case "code": return identifiers(e.code);
    case "ref": return new Set([e.path.split(".")[0]!]);
    default: return new Set();
  }
}

/** All identifiers referenced anywhere in a UI subtree. */
export function subtreeIdentifiers(nodes: UiNode[]): Set<string> {
  const out = new Set<string>();
  const visit = (n: UiNode) => {
    switch (n.kind) {
      case "element":
        for (const p of n.props) for (const id of exprIdentifiers(p.value)) out.add(id);
        n.children.forEach(visit);
        break;
      case "expr":
        for (const id of identifiers(n.code)) out.add(id);
        break;
      case "if":
        for (const id of exprIdentifiers(n.test)) out.add(id);
        n.then.forEach(visit);
        n.else?.forEach(visit);
        break;
      case "for":
        for (const id of exprIdentifiers(n.iterable)) out.add(id);
        if (n.key) for (const id of exprIdentifiers(n.key)) out.add(id);
        n.body.forEach(visit);
        break;
      default:
        break;
    }
  };
  nodes.forEach(visit);
  return out;
}

/** `/todos/[id]` -> `todos/[id]`; `/` -> ``. */
export function routeDir(route: string): string {
  return route.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** TypeScript type for a route's params. */
export function paramsType(route: string): string {
  const fields: string[] = [];
  for (const seg of route.split("/")) {
    let m = /^\[\[\.\.\.(\w+)\]\]$/.exec(seg);
    if (m) { fields.push(`${m[1]}?: string[]`); continue; }
    m = /^\[\.\.\.(\w+)\]$/.exec(seg);
    if (m) { fields.push(`${m[1]}: string[]`); continue; }
    m = /^\[(\w+)\]$/.exec(seg);
    if (m) fields.push(`${m[1]}: string`);
  }
  return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, never>";
}

/** Relative import path from a file in `fromDir` to `toPath` (both app-relative, posix). */
export function relativeImport(fromDir: string, toPath: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.length - i;
  const rest = to.slice(i).join("/");
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return prefix + rest;
}

export class Writer {
  private lines: string[] = [];
  private depth = 0;
  line(s = ""): void {
    this.lines.push(s === "" ? "" : "  ".repeat(this.depth) + s);
  }
  indent(fn: () => void): void {
    this.depth++;
    fn();
    this.depth--;
  }
  toString(): string {
    return this.lines.join("\n") + "\n";
  }
}

export function pascal(s: string): string {
  return s.replace(/(^|[^A-Za-z0-9])([a-z0-9])/g, (_, __, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
}
