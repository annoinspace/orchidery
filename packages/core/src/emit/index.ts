import type { ActionDecl, ComponentDecl, Document, IslandDecl, LayoutDecl, PageDecl, Span, UiNode } from "../ast.js";
import { exprToCode, setterName } from "../ast.js";
import { rootAddress, stamp, type Root } from "../address.js";
import type { Diagnostic } from "../diagnostics.js";
import { componentsOf, importedNames, importsOf, islandsOf, layoutsOf, pagesOf, resourcesOf, tokensOf, type Program } from "../program.js";
import { validate } from "../validate.js";
import { emitJsx, newNeeds, type Island, type JsxContext, type Needs } from "./jsx.js";
import { emitResourceModule } from "./resources.js";
import { emitTokensCss, emitTokensTs } from "./tokens.js";
import { identifiers, paramsType, relativeImport, routeDir, Writer } from "./util.js";

export interface EmitOptions {
  /** Development build: stamp elements with data-orchid, produce the address map and load the devtools overlay. */
  dev?: boolean;
  /** Keep stamps and the map without the devtools loader. Used for `stamps: "always"` production builds. */
  stamps?: boolean;
  /** Module specifier for the runtime. Default `@orchidery/runtime`. */
  runtime?: string;
  /** Where the devtools overlay is served from (dev only). */
  devtoolsUrl?: string;
}

export interface MapEntry {
  address: string;
  file?: string;
  range?: Span;
  name: string;
}

export interface EmitResult {
  /** Path (relative to the app dir) -> contents. */
  files: Record<string, string>;
  /** data-orchid stamp -> source location. Empty unless dev. */
  map: Record<string, MapEntry>;
  diagnostics: Diagnostic[];
}

const GEN = "_orchidery";

/** Compile a program to Next.js App Router files. */
export function emit(program: Program, opts: EmitOptions = {}): EmitResult {
  const diagnostics = validate(program);
  const files: Record<string, string> = {};
  const map: Record<string, MapEntry> = {};
  if (diagnostics.some((d) => d.severity === "error")) return { files, map, diagnostics };

  const dev = opts.dev ?? false;
  const stamp = dev || (opts.stamps ?? false);
  const runtime = opts.runtime ?? "@orchidery/runtime";
  const tokens = tokensOf(program);
  const tokenPaths = new Set(tokens.map((t) => t.path));
  const components = componentsOf(program);
  const componentNames = new Set(components.map((c) => c.name));
  const islands = islandsOf(program);
  const islandNames = new Set(islands.map((i) => i.name));

  files[`${GEN}/tokens.css`] = emitTokensCss(tokens);
  files[`${GEN}/tokens.ts`] = emitTokensTs(tokens);
  for (const r of resourcesOf(program)) files[`${GEN}/resources/${r.name}.ts`] = emitResourceModule(r);

  const shared = { dev, stamp, runtime, tokenPaths, componentNames, islandNames, opts };

  for (const doc of program.documents) {
    const importNames = importedNames(doc);
    for (const c of components.filter((c) => doc.items.includes(c))) {
      emitComponent(c, doc, { ...shared, importNames }, files, map);
    }
    for (const i of islands.filter((i) => doc.items.includes(i))) {
      emitDeclaredIsland(i, doc, { ...shared, importNames }, files, map);
    }
    for (const p of pagesOf(program).filter((p) => doc.items.includes(p))) {
      emitPage(p, doc, { ...shared, importNames }, files, map);
    }
    for (const l of layoutsOf(program).filter((l) => doc.items.includes(l))) {
      emitLayout(l, doc, { ...shared, importNames }, files, map);
    }
  }

  if (!layoutsOf(program).some((l) => l.route === "/")) {
    files["layout.tsx"] = defaultRootLayout({ ...shared, importNames: new Set<string>() });
  }

  return { files, map, diagnostics };
}

interface Shared {
  /** Development build: load the devtools overlay. */
  dev: boolean;
  /** Stamp elements with data-orchid (dev, or `stamps: "always"`). */
  stamp: boolean;
  runtime: string;
  tokenPaths: Set<string>;
  componentNames: Set<string>;
  islandNames: Set<string>;
  importNames: Set<string>;
  opts: EmitOptions;
}

function ctxFor(root: Root, s: Shared, dataNames: Set<string>, map: Record<string, MapEntry>, doc: Document, extractIslands: boolean): JsxContext {
  return {
    rootAddress: rootAddress(root),
    dev: s.stamp,
    onStamp: (address, node) => {
      map[stamp(address)] = { address, file: doc.file, range: node.span, name: node.kind === "element" ? node.name : node.kind };
    },
    tokenPaths: s.tokenPaths,
    componentNames: s.componentNames,
    islandNames: s.islandNames,
    importNames: s.importNames,
    actionNames: new Set(root.kind === "page" ? root.actions.map((a) => a.name) : []),
    dataNames,
    extractIslands,
    islands: [],
    needs: newNeeds(),
  };
}

// ---------------------------------------------------------------------------
// Imports header shared by all emitted files
// ---------------------------------------------------------------------------

function header(w: Writer, needs: Needs, s: Shared, doc: Document, dir: string, extra: { actions?: string[]; actionsPath?: string; react?: string[] } = {}): void {
  const react = new Set(extra.react ?? []);
  if (needs.fragment) react.add("Fragment");
  if (react.size) w.line(`import { ${[...react].sort().join(", ")} } from "react";`);
  if (needs.primitives.size) w.line(`import { ${[...needs.primitives].sort().join(", ")} } from "${s.runtime}";`);
  if (needs.tokens) w.line(`import { tokens } from "${relativeImport(dir, `${GEN}/tokens`)}";`);
  for (const c of [...needs.components].sort()) w.line(`import { ${c} } from "${relativeImport(dir, `${GEN}/components/${c}`)}";`);
  for (const i of [...needs.islands].sort()) w.line(`import { ${i} } from "${relativeImport(dir, `${GEN}/islands/${i}`)}";`);
  userImports(w, needs.imports, doc);
  if (extra.actions?.length && extra.actionsPath) w.line(`import { ${extra.actions.sort().join(", ")} } from "${extra.actionsPath}";`);
}

function userImports(w: Writer, used: Set<string>, doc: Document): void {
  for (const imp of importsOf(doc)) {
    const def = imp.default && used.has(imp.default) ? imp.default : undefined;
    const names = imp.names.filter((n) => used.has(n));
    if (!def && !names.length) continue;
    const parts: string[] = [];
    if (def) parts.push(def);
    if (names.length) parts.push(`{ ${names.join(", ")} }`);
    w.line(`import ${parts.join(", ")} from ${JSON.stringify(imp.from)};`);
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function emitComponent(c: ComponentDecl, doc: Document, s: Shared, files: Record<string, string>, map: Record<string, MapEntry>): void {
  const dir = `${GEN}/components`;
  const dataNames = new Set(c.params.map((p) => p.name));
  const ctx = ctxFor(c, s, dataNames, map, doc, false);
  const jsx = emitJsx(c.body, ctx);
  const isClient = hasEventProps(c.body);
  const w = new Writer();
  w.line("// Generated by Orchidery from " + (doc.file ?? "a .orchid file") + ". Do not edit; edit the source instead.");
  if (isClient) w.line('"use client";');
  const hasChildren = c.params.some((p) => p.name === "children");
  header(w, ctx.needs, s, doc, dir, { react: hasChildren ? ["type ReactNode"] : [] });
  w.line();
  const propsType = c.params
    .map((p) => (p.name === "children" ? "children?: ReactNode" : `${p.name}${p.type ? `: ${p.type}` : ": any"}`))
    .join("; ");
  const destructure = c.params.map((p) => p.name).join(", ");
  w.line(`export function ${c.name}({ ${destructure} }: { ${propsType} }) {`);
  w.indent(() => {
    w.line("return (");
    w.indent(() => jsx.split("\n").forEach((l) => w.line(l)));
    w.line(");");
  });
  w.line("}");
  files[`${dir}/${c.name}.tsx`] = w.toString();
}

// ---------------------------------------------------------------------------
// Islands: declared client components with useState per state entry
// ---------------------------------------------------------------------------

function emitDeclaredIsland(isl: IslandDecl, doc: Document, s: Shared, files: Record<string, string>, map: Record<string, MapEntry>): void {
  const dir = `${GEN}/islands`;
  const dataNames = new Set<string>([...isl.params.map((p) => p.name), ...isl.state.map((st) => st.name), ...isl.state.map((st) => setterName(st.name))]);
  const ctx = ctxFor(isl, s, dataNames, map, doc, false);
  const jsx = emitJsx(isl.body, ctx);
  for (const st of isl.state) for (const id of identifiers(exprToCode(st.initial))) if (s.importNames.has(id)) ctx.needs.imports.add(id);
  const w = new Writer();
  w.line('"use client";');
  w.line("// Generated by Orchidery from " + (doc.file ?? "a .orchid file") + ". Do not edit; edit the source instead.");
  const hasChildren = isl.params.some((p) => p.name === "children");
  header(w, ctx.needs, s, doc, dir, { react: ["useState", ...(hasChildren ? ["type ReactNode"] : [])] });
  w.line();
  const propsType = isl.params
    .map((p) => (p.name === "children" ? "children?: ReactNode" : `${p.name}${p.type ? `: ${p.type}` : ": any"}`))
    .join("; ");
  const destructure = isl.params.map((p) => p.name).join(", ");
  w.line(`export function ${isl.name}(${isl.params.length ? `{ ${destructure} }: { ${propsType} }` : ""}) {`);
  w.indent(() => {
    for (const st of isl.state) w.line(`const [${st.name}, ${setterName(st.name)}] = useState(${exprToCode(st.initial)});`);
    w.line("return (");
    w.indent(() => jsx.split("\n").forEach((l) => w.line(l)));
    w.line(");");
  });
  w.line("}");
  files[`${dir}/${isl.name}.tsx`] = w.toString();
}

function hasEventProps(nodes: UiNode[]): boolean {
  for (const n of nodes) {
    if (n.kind === "element") {
      if (n.props.some((p) => /^on[A-Z]/.test(p.name))) return true;
      if (hasEventProps(n.children)) return true;
    }
    if (n.kind === "if" && (hasEventProps(n.then) || (n.else ? hasEventProps(n.else) : false))) return true;
    if (n.kind === "for" && hasEventProps(n.body)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function emitPage(p: PageDecl, doc: Document, s: Shared, files: Record<string, string>, map: Record<string, MapEntry>): void {
  const dir = routeDir(p.route);
  const prefix = dir ? `${dir}/` : "";
  const dataNames = new Set<string>(["params", "searchParams", ...(p.load?.bindings.map((b) => b.name) ?? [])]);
  const ctx = ctxFor(p, s, dataNames, map, doc, true);
  const jsx = emitJsx(p.ui, ctx);

  if (p.actions.length) files[`${prefix}actions.ts`] = emitActions(p.actions, doc);
  for (const island of ctx.islands) {
    files[`${prefix}_islands/${island.name}.tsx`] = emitIsland(island, doc, s, dir, p);
  }

  const w = new Writer();
  w.line("// Generated by Orchidery from " + (doc.file ?? "a .orchid file") + ". Do not edit; edit the source instead.");
  const loadIds = new Set<string>();
  for (const b of p.load?.bindings ?? []) for (const id of identifiers(exprToCode(b.expr))) loadIds.add(id);
  for (const id of loadIds) if (s.importNames.has(id)) ctx.needs.imports.add(id);
  for (const e of p.meta?.entries ?? []) for (const id of identifiers(exprToCode(e.value))) if (s.importNames.has(id)) ctx.needs.imports.add(id);
  header(w, ctx.needs, s, doc, dir, { actions: [...ctx.needs.actions], actionsPath: "./actions" });
  for (const island of ctx.islands) w.line(`import { ${island.name} } from "./_islands/${island.name}";`);
  w.line();
  w.line(`type Params = ${paramsType(p.route)};`);
  w.line("type SearchParams = Record<string, string | string[] | undefined>;");
  w.line();
  if (p.load) {
    w.line("async function load(params: Params, searchParams: SearchParams) {");
    w.indent(() => {
      for (const b of p.load!.bindings) w.line(`const ${b.name} = ${exprToCode(b.expr)};`);
      w.line(`return { ${p.load!.bindings.map((b) => b.name).join(", ")} };`);
    });
    w.line("}");
    w.line("export type PageData = Awaited<ReturnType<typeof load>>;");
    w.line();
  }
  if (p.meta) emitMetadata(w, p.meta.entries);
  w.line("export default async function Page(props: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {");
  w.indent(() => {
    w.line("const params = await props.params;");
    w.line("const searchParams = await props.searchParams;");
    w.line("void params; void searchParams;");
    if (p.load) w.line(`const { ${p.load.bindings.map((b) => b.name).join(", ")} } = await load(params, searchParams);`);
    w.line("return (");
    w.indent(() => jsx.split("\n").forEach((l) => w.line(l)));
    w.line(");");
  });
  w.line("}");
  files[`${prefix}page.tsx`] = w.toString();
}

function emitMetadata(w: Writer, entries: { name: string; value: import("../ast.js").Expr }[]): void {
  w.line("export const metadata = {");
  w.indent(() => entries.forEach((e) => w.line(`${e.name}: ${exprToCode(e.value)},`)));
  w.line("};");
  w.line();
}

function emitActions(actions: ActionDecl[], doc: Document): string {
  const w = new Writer();
  w.line('"use server";');
  w.line("// Generated by Orchidery from " + (doc.file ?? "a .orchid file") + ". Do not edit; edit the source instead.");
  const usesRevalidate = actions.some((a) => a.body.some((s) => s.kind === "revalidate"));
  const usesRedirect = actions.some((a) => a.body.some((s) => s.kind === "redirect"));
  if (usesRevalidate) w.line('import { revalidatePath } from "next/cache";');
  if (usesRedirect) w.line('import { redirect } from "next/navigation";');
  const used = new Set<string>();
  for (const a of actions) for (const st of a.body) if (st.kind === "raw") for (const id of identifiers(st.code)) used.add(id);
  userImports(w, used, doc);
  for (const a of actions) {
    w.line();
    const params = a.params.map((p) => `${p.name}${p.type ? `: ${p.type}` : ": any"}`).join(", ");
    w.line(`export async function ${a.name}(${params}) {`);
    w.indent(() => {
      for (const st of a.body) {
        if (st.kind === "raw") w.line(st.code.endsWith(";") || st.code.endsWith("}") ? st.code : st.code + ";");
        else if (st.kind === "revalidate") w.line(`revalidatePath(${JSON.stringify(st.path)}${st.path.includes("[") ? ', "page"' : ""});`);
        else w.line(`redirect(${JSON.stringify(st.path)});`);
      }
    });
    w.line("}");
  }
  return w.toString();
}

function emitIsland(island: Island, doc: Document, s: Shared, pageDir: string, page: PageDecl): string {
  const dir = pageDir ? `${pageDir}/_islands` : "_islands";
  const loaded = new Set(page.load?.bindings.map((b) => b.name) ?? []);
  const w = new Writer();
  w.line('"use client";');
  w.line("// Generated by Orchidery. Client island for " + island.address);
  header(w, island.needs, s, doc, dir, page.actions.length ? { actions: [...island.needs.actions], actionsPath: "../actions" } : {});
  if (island.props.some((p) => loaded.has(p))) w.line('import type { PageData } from "../page";');
  w.line();
  const propsType = island.props.map((p) => `${p}: ${loaded.has(p) ? `PageData[${JSON.stringify(p)}]` : "any"}`).join("; ");
  const destructure = island.props.join(", ");
  w.line(`export function ${island.name}(${island.props.length ? `{ ${destructure} }: { ${propsType} }` : ""}) {`);
  w.indent(() => {
    w.line("return (");
    w.indent(() => island.jsx.split("\n").forEach((l) => w.line(l)));
    w.line(");");
  });
  w.line("}");
  return w.toString();
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function emitLayout(l: LayoutDecl, doc: Document, s: Shared, files: Record<string, string>, map: Record<string, MapEntry>): void {
  const dir = routeDir(l.route);
  const prefix = dir ? `${dir}/` : "";
  const isRoot = l.route === "/";
  const dataNames = new Set<string>(["params", ...(l.load?.bindings.map((b) => b.name) ?? [])]);
  const ctx = ctxFor(l, s, dataNames, map, doc, false);
  const jsx = emitJsx(l.ui, ctx);
  const w = new Writer();
  w.line("// Generated by Orchidery from " + (doc.file ?? "a .orchid file") + ". Do not edit; edit the source instead.");
  if (isRoot) {
    w.line(`import "${s.runtime}/styles.css";`);
    w.line(`import "./${GEN}/tokens.css";`);
    if (s.dev) w.line(`import { OrchideryDevTools } from "${s.runtime}/devtools";`);
  }
  for (const b of l.load?.bindings ?? []) for (const id of identifiers(exprToCode(b.expr))) if (s.importNames.has(id)) ctx.needs.imports.add(id);
  header(w, ctx.needs, s, doc, dir, { react: ["type ReactNode"] });
  w.line();
  w.line(`type Params = ${paramsType(l.route)};`);
  w.line();
  if (l.meta) emitMetadata(w, l.meta.entries);
  w.line("export default async function Layout(props: { children: ReactNode; params: Promise<Params> }) {");
  w.indent(() => {
    w.line("const { children } = props;");
    w.line("const params = await props.params;");
    w.line("void params;");
    for (const b of l.load?.bindings ?? []) w.line(`const ${b.name} = ${exprToCode(b.expr)};`);
    w.line("return (");
    w.indent(() => {
      if (isRoot) {
        w.line('<html lang="en">');
        w.indent(() => {
          w.line("<body>");
          w.indent(() => {
            jsx.split("\n").forEach((line) => w.line(line));
            if (s.dev) w.line(`<OrchideryDevTools${s.opts.devtoolsUrl ? ` url=${JSON.stringify(s.opts.devtoolsUrl)}` : ""} />`);
          });
          w.line("</body>");
        });
        w.line("</html>");
      } else {
        jsx.split("\n").forEach((line) => w.line(line));
      }
    });
    w.line(");");
  });
  w.line("}");
  files[`${prefix}layout.tsx`] = w.toString();
}

function defaultRootLayout(s: Shared): string {
  const w = new Writer();
  w.line("// Generated by Orchidery. Declare `layout \"/\"` in a .orchid file to customise this.");
  w.line(`import "${s.runtime}/styles.css";`);
  w.line(`import "./${GEN}/tokens.css";`);
  if (s.dev) w.line(`import { OrchideryDevTools } from "${s.runtime}/devtools";`);
  w.line('import type { ReactNode } from "react";');
  w.line();
  w.line("export default function Layout({ children }: { children: ReactNode }) {");
  w.indent(() => {
    w.line("return (");
    w.indent(() => {
      w.line('<html lang="en">');
      w.indent(() => {
        w.line("<body>");
        w.indent(() => {
          w.line("{children}");
          if (s.dev) w.line(`<OrchideryDevTools${s.opts.devtoolsUrl ? ` url=${JSON.stringify(s.opts.devtoolsUrl)}` : ""} />`);
        });
        w.line("</body>");
      });
      w.line("</html>");
    });
    w.line(");");
  });
  w.line("}");
  return w.toString();
}
