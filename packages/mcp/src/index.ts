import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DIAGNOSTIC_DOCS,
  PRIMITIVES,
  documentJsonSchema,
  emit,
  explain,
  findByAddress,
  graft,
  graftOpsJsonSchema,
  GraftOp,
  loadConfig,
  loadProgram,
  OrchidError,
  parse,
  print,
  printUi,
  readSources,
  rootAddress,
  rootUi,
  isRoot,
  validate,
  walk,
  type Diagnostic,
  type Document,
  type Program,
  type Root,
  type UiNode,
} from "@orchidery/core";
import { Store } from "@orchidery/devtools";

export interface ServeOptions {
  root: string;
}

/** Run the server over stdio. */
export async function serve(opts: ServeOptions): Promise<void> {
  const server = createServer(opts);
  await server.connect(new StdioServerTransport());
}

/** Build the MCP server; exported so tests can connect an in-memory client. */
export function createServer(opts: ServeOptions): McpServer {
  const root = opts.root;
  const server = new McpServer(
    { name: "orchidery", version: "0.1.0" },
    {
      instructions: [
        "Orchidery projects are .orchid files that compile to Next.js. Nodes are addressed like",
        "`page:/todos/[id] > Card[0] > #done`. Read with orchid_project / orchid_get_node, change with",
        "orchid_graft (structural ops, validated atomically), and work the human's edit-mode queue with",
        "orchid_annotations -> orchid_annotation -> orchid_graft -> orchid_annotation_update.",
        "Never edit generated files under the app directory; edit .orchid sources through grafts.",
      ].join(" "),
    },
  );

  const config = () => loadConfig(root);
  const store = () => new Store(root, config().src);
  const load = () => loadProgram(readSources(root, config().src));

  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  const fail = (e: unknown) => {
    const d: Diagnostic = e instanceof OrchidError ? e.diagnostic : { code: "E000", severity: "error", message: (e as Error).message };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: d }, null, 2) }] };
  };

  server.registerTool(
    "orchid_schema",
    { description: "JSON Schema for .orchid documents and graft ops, the built-in primitives with their props, and every diagnostic code.", inputSchema: {} },
    async () => text({ document: documentJsonSchema(), graftOps: graftOpsJsonSchema(), primitives: PRIMITIVES, diagnostics: DIAGNOSTIC_DOCS }),
  );

  server.registerTool(
    "orchid_project",
    { description: "Overview of the project: source files, pages, layouts, components (with their addresses and top-level children) and tokens.", inputSchema: {} },
    async () => {
      const { program, diagnostics } = load();
      const roots = program.documents.flatMap((d) =>
        d.items.filter(isRoot).map((r) => ({
          address: rootAddress(r),
          file: d.file,
          kind: r.kind,
          params: r.kind === "component" ? r.params.map((p) => p.name) : undefined,
          actions: r.kind === "page" ? r.actions.map((a) => `${a.name}(${a.params.map((p) => p.name).join(", ")})`) : undefined,
          load: r.kind !== "component" && r.load ? r.load.bindings.map((b) => b.name) : undefined,
          children: childAddresses(r, rootUi(r)),
        })),
      );
      const tokens = program.documents.flatMap((d) => d.items.filter((i) => i.kind === "tokens").flatMap((t) => t.entries.map((e) => `${e.path}: ${JSON.stringify(e.value)}`)));
      return text({ root, config: config(), files: program.documents.map((d) => d.file), roots, tokens, parseErrors: diagnostics, validation: diagnostics.length ? [] : validate(program) });
    },
  );

  server.registerTool(
    "orchid_read",
    { description: "Read a .orchid source file with every node address in it.", inputSchema: { file: z.string().describe("Path relative to the project root, e.g. orchid/todos.orchid") } },
    async ({ file }) => {
      try {
        const source = readFileSync(join(root, file), "utf8");
        const doc = parse(source, { file });
        const addresses = doc.items.filter(isRoot).flatMap((r) => [...walk(r)].map((l) => `${l.address}${l.node.span ? `  (line ${l.node.span.start.line})` : ""}`));
        return text({ file, source, addresses });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_validate",
    {
      description: "Validate the whole project, or a single .orchid source string in the context of the project. Returns diagnostics with codes, ranges and suggested fixes.",
      inputSchema: { source: z.string().optional().describe("A .orchid document to validate instead of the project files") },
    },
    async ({ source }) => {
      try {
        const { program, diagnostics } = load();
        if (diagnostics.length && !source) return text({ diagnostics });
        if (source) {
          const doc = parse(source, { file: "<source>" });
          program.documents.push(doc);
        }
        return text({ diagnostics: validate(program) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_compile",
    {
      description: "Compile the project (or one source string) to Next.js files. Returns the files; writes them to the app directory only when write is true. The dev server writes automatically after grafts, so write is rarely needed.",
      inputSchema: {
        source: z.string().optional(),
        dev: z.boolean().optional().describe("Include data-orchid stamps and the address map"),
        write: z.boolean().optional(),
      },
    },
    async ({ source, dev, write }) => {
      try {
        if (source) {
          const r = emit({ documents: [parse(source, { file: "<source>" })] }, { dev });
          return text({ files: r.files, diagnostics: r.diagnostics });
        }
        const { compileProject } = await import("@orchidery/core");
        if (write) {
          const r = compileProject(root, config(), { dev });
          return text(r);
        }
        const { program, diagnostics } = load();
        if (diagnostics.length) return text({ diagnostics });
        const r = emit(program, { dev });
        return text({ files: r.files, diagnostics: r.diagnostics });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_format",
    { description: "Return a .orchid source in canonical formatting.", inputSchema: { source: z.string() } },
    async ({ source }) => {
      try {
        return text(print(parse(source)));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_explain",
    { description: "Explain a diagnostic code such as O104.", inputSchema: { code: z.string() } },
    async ({ code }) => text(explain(code) ?? { error: `Unknown code ${code}` }),
  );

  server.registerTool(
    "orchid_get_node",
    {
      description: "Fetch the node at an address: its file, source excerpt, canonical snippet, AST and child addresses.",
      inputSchema: { address: z.string() },
    },
    async ({ address }) => {
      try {
        const { program } = load();
        const found = locate(program, address);
        if (!found) return fail(new OrchidError({ code: "O201", severity: "error", message: `No node at \`${address}\`` }));
        return text(describeNode(found.doc, found.node, address, root));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_graft",
    {
      description:
        "Apply structural edits to a .orchid file atomically. Ops run in order; the result is validated and nothing is written if it is invalid. `file` is inferred from the first op's address when omitted. Node values may be .orchid snippets.",
      inputSchema: { file: z.string().optional(), ops: z.array(GraftOp).min(1) },
    },
    async ({ file, ops }) => {
      try {
        const { program, diagnostics } = load();
        if (diagnostics.length) return text({ error: "Fix parse errors first", diagnostics });
        const target = resolveFile(program, file, ops);
        const doc = program.documents.find((d) => d.file === target);
        if (!doc) throw new OrchidError({ code: "O201", severity: "error", message: `No such source file \`${target}\`` });
        const r = graft(doc, ops, { program });
        writeFileSync(join(root, target), r.text);
        return text({ file: target, touched: r.touched, text: r.text });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "orchid_annotations",
    { description: "List annotations the human left in edit mode. Defaults to open ones (pending and in_progress).", inputSchema: { status: z.enum(["pending", "in_progress", "done", "rejected", "all"]).optional() } },
    async ({ status }) => {
      const all = store().list();
      const list = status === "all" ? all : status ? all.filter((a) => a.status === status) : all.filter((a) => a.status === "pending" || a.status === "in_progress");
      return text(list.map(({ id, status, url, note, targets, commonAncestor, createdAt }) => ({ id, status, url, note, targets, commonAncestor, createdAt })));
    },
  );

  server.registerTool(
    "orchid_annotation",
    {
      description: "Everything needed to work one annotation: the note, the target nodes with source excerpts, their common ancestor, and the screenshot the human drew on.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const a = store().get(id);
      if (!a) return fail(new Error(`No annotation ${id}`));
      const { program } = load();
      const nodes = a.targets.map((address) => {
        const found = locate(program, address);
        return found ? describeNode(found.doc, found.node, address, root) : { address, error: "not found (source may have changed)" };
      });
      const ancestor = a.commonAncestor ? locate(program, a.commonAncestor) : undefined;
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...a,
              screenshotPath: a.screenshot ? join(root, a.screenshot) : undefined,
              targetsDetail: nodes,
              commonAncestorDetail: ancestor ? describeNode(ancestor.doc, ancestor.node, a.commonAncestor!, root) : undefined,
              howTo: "Make the change with orchid_graft, then orchid_annotation_update with status done and a one-line summary.",
            },
            null,
            2,
          ),
        },
      ];
      const shot = store().screenshotPath(id);
      if (shot) content.push({ type: "image", data: readFileSync(shot).toString("base64"), mimeType: "image/png" });
      return { content };
    },
  );

  server.registerTool(
    "orchid_annotation_update",
    { description: "Set an annotation's status (in_progress while working, done or rejected when finished) with an optional summary shown to the human.", inputSchema: { id: z.string(), status: z.enum(["pending", "in_progress", "done", "rejected"]), summary: z.string().optional() } },
    async ({ id, status, summary }) => {
      const a = store().update(id, { status, summary });
      return a ? text(a) : fail(new Error(`No annotation ${id}`));
    },
  );

  server.registerTool(
    "orchid_diff",
    { description: "Unified diff of the .orchid sources since an annotation was created, for the human to review.", inputSchema: { id: z.string() } },
    async ({ id }) => text(store().diff(id) || "(no changes)"),
  );

  return server;
}

// ---------------------------------------------------------------------------

function locate(program: Program, address: string): { doc: Document; node: UiNode | Root } | undefined {
  for (const doc of program.documents) {
    const r = rootItem(doc, address);
    if (r) return { doc, node: r };
    const loc = findByAddress(doc, address);
    if (loc) return { doc, node: loc.node };
  }
  return undefined;
}

function rootItem(doc: Document, address: string): Root | undefined {
  if (address.includes(" > ")) return undefined;
  return doc.items.filter(isRoot).find((r) => rootAddress(r) === address.trim());
}

function describeNode(doc: Document, node: UiNode | Root, address: string, root: string) {
  const file = doc.file;
  let excerpt: string | undefined;
  if (file && node.span) {
    try {
      const src = readFileSync(join(root, file), "utf8");
      excerpt = src.slice(node.span.start.offset, node.span.end.offset);
    } catch {
      /* ignore */
    }
  }
  const isUi = "kind" in node && ["element", "text", "expr", "slot", "if", "for"].includes(node.kind);
  let children: string[] = [];
  if (!isUi) {
    const r = node as Root;
    children = childAddresses(r, rootUi(r));
  } else {
    const r = doc.items.filter(isRoot).find((it) => rootAddress(it) === address.split(" > ")[0]!.trim());
    const n = node as UiNode;
    const kids = n.kind === "element" ? n.children : n.kind === "if" ? [...n.then, ...(n.else ?? [])] : n.kind === "for" ? n.body : [];
    if (r) children = childAddresses(r, kids);
  }
  return {
    address,
    file,
    line: node.span?.start.line,
    canonical: isUi ? printUi([node as UiNode], 0) : print({ kind: "document", items: [node as never] }).trim(),
    excerpt,
    children,
    ast: node,
  };
}

/** Addresses of the given nodes, looked up by identity within their root. */
function childAddresses(root: Root, nodes: UiNode[]): string[] {
  const byNode = new Map<UiNode, string>();
  for (const l of walk(root)) byNode.set(l.node, l.address);
  return nodes.map((n) => byNode.get(n)).filter((a): a is string => !!a);
}

function resolveFile(program: Program, file: string | undefined, ops: GraftOp[]): string {
  if (file) return file;
  for (const op of ops) {
    const address = "address" in op ? op.address : undefined;
    if (!address) continue;
    for (const doc of program.documents) if (findByAddress(doc, address) || rootItem(doc, address)) return doc.file!;
  }
  const withTokens = program.documents.find((d) => d.items.some((i) => i.kind === "tokens"));
  if (withTokens?.file) return withTokens.file;
  const first = program.documents[0]?.file;
  if (!first) throw new OrchidError({ code: "O201", severity: "error", message: "No .orchid files in the project" });
  return first;
}
