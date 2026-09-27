import { exprToCode, type Document, type Expr, type Item, type Param, type UiNode } from "./ast.js";

const INDENT = "  ";

/** Print a document in canonical Orchidery formatting. parse(print(ast)) equals ast (minus spans). */
export function print(doc: Document): string {
  return doc.items.map(printItem).join("\n\n") + "\n";
}

function printItem(item: Item): string {
  switch (item.kind) {
    case "tokens":
      return `tokens {\n${item.entries
        .map((e) => `${INDENT}${e.path}: ${typeof e.value === "string" ? JSON.stringify(e.value) : e.value}`)
        .join("\n")}\n}`;
    case "import": {
      const parts: string[] = [];
      if (item.default) parts.push(item.default);
      if (item.names.length) parts.push(`{ ${item.names.join(", ")} }`);
      return `import ${parts.join(", ")} from ${JSON.stringify(item.from)}`;
    }
    case "component":
      return `component ${item.name}${printParams(item.params)} {\n${printUi(item.body, 1)}\n}`;
    case "layout": {
      const blocks: string[] = [];
      if (item.load) blocks.push(printLoad(item.load.bindings));
      if (item.meta) blocks.push(printMeta(item.meta.entries));
      blocks.push(`${INDENT}ui {\n${printUi(item.ui, 2)}\n${INDENT}}`);
      return `layout ${JSON.stringify(item.route)} {\n${blocks.join("\n\n")}\n}`;
    }
    case "page": {
      const blocks: string[] = [];
      if (item.meta) blocks.push(printMeta(item.meta.entries));
      if (item.load) blocks.push(printLoad(item.load.bindings));
      for (const a of item.actions) {
        const body = a.body
          .map((s) => {
            if (s.kind === "raw") return `${INDENT}${INDENT}${s.code}`;
            return `${INDENT}${INDENT}${s.kind} ${JSON.stringify(s.path)}`;
          })
          .join("\n");
        blocks.push(`${INDENT}action ${a.name}${printParams(a.params)} {\n${body}\n${INDENT}}`);
      }
      blocks.push(`${INDENT}ui {\n${printUi(item.ui, 2)}\n${INDENT}}`);
      return `page ${JSON.stringify(item.route)} {\n${blocks.join("\n\n")}\n}`;
    }
  }
}

function printParams(params: Param[]): string {
  if (!params.length) return "()";
  return `(${params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(", ")})`;
}

function printLoad(bindings: { name: string; expr: Expr }[]): string {
  return `${INDENT}load {\n${bindings.map((b) => `${INDENT}${INDENT}${b.name}: ${exprToCode(b.expr)}`).join("\n")}\n${INDENT}}`;
}

function printMeta(entries: { name: string; value: Expr }[]): string {
  return `${INDENT}meta {\n${entries.map((e) => `${INDENT}${INDENT}${e.name}: ${exprToCode(e.value)}`).join("\n")}\n${INDENT}}`;
}

export function printUi(nodes: UiNode[], depth: number): string {
  return nodes.map((n) => printNode(n, depth)).join("\n");
}

function printNode(n: UiNode, depth: number): string {
  const pad = INDENT.repeat(depth);
  switch (n.kind) {
    case "text":
      return `${pad}${JSON.stringify(n.value)}`;
    case "expr":
      return `${pad}${n.code}`;
    case "slot":
      return `${pad}${n.name}`;
    case "element": {
      let s = `${pad}${n.name}`;
      if (n.id) s += `#${n.id}`;
      if (n.props.length) {
        s += `(${n.props
          .map((p) => (p.value.kind === "boolean" && p.value.value === true ? p.name : `${p.name}: ${exprToCode(p.value)}`))
          .join(", ")})`;
      }
      if (n.children.length) s += ` {\n${printUi(n.children, depth + 1)}\n${pad}}`;
      return s;
    }
    case "if": {
      let s = `${pad}if ${exprToCode(n.test)} {\n${printUi(n.then, depth + 1)}\n${pad}}`;
      if (n.else) {
        if (n.else.length === 1 && n.else[0]!.kind === "if") {
          s += ` else ${printNode(n.else[0]!, depth).trimStart()}`;
        } else {
          s += ` else {\n${printUi(n.else, depth + 1)}\n${pad}}`;
        }
      }
      return s;
    }
    case "for": {
      const head = n.index ? `${n.item}, ${n.index}` : n.item;
      const key = n.key ? ` key ${exprToCode(n.key)}` : "";
      return `${pad}for ${head} in ${exprToCode(n.iterable)}${key} {\n${printUi(n.body, depth + 1)}\n${pad}}`;
    }
  }
}
