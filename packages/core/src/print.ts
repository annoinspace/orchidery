import { exprToCode, type Document, type Expr, type Item, type Param, type ScenarioStep, type UiNode } from "./ast.js";

const INDENT = "  ";

/** Print a document in canonical Orchidery formatting. parse(print(ast)) equals ast (minus spans). */
export function print(doc: Document): string {
  let out = "";
  doc.items.forEach((item, i) => {
    const prev = doc.items[i - 1];
    if (i > 0) out += prev?.kind === "import" && item.kind === "import" ? "\n" : "\n\n";
    out += printItem(item);
  });
  return out + "\n";
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
    case "scenario":
      return `scenario ${JSON.stringify(item.name)} {\n${item.steps.map((s) => INDENT + printStep(s)).join("\n")}\n}`;
    case "resource": {
      const fields = item.fields
        .map((f) => `${INDENT}${INDENT}${f.name}: ${f.type}${f.optional ? "?" : ""}${f.default ? ` = ${exprToCode(f.default)}` : ""}`)
        .join("\n");
      return `resource ${item.name} {\n${INDENT}fields {\n${fields}\n${INDENT}}\n${INDENT}source ${item.source}\n${INDENT}routes ${JSON.stringify(item.routes)}\n}`;
    }
    case "island": {
      const blocks: string[] = [];
      if (item.state.length) {
        blocks.push(`${INDENT}state {\n${item.state.map((s) => `${INDENT}${INDENT}${s.name}: ${exprToCode(s.initial)}`).join("\n")}\n${INDENT}}`);
      }
      blocks.push(`${INDENT}ui {\n${printUi(item.body, 2)}\n${INDENT}}`);
      return `island ${item.name}${printParams(item.params)} {\n${blocks.join("\n\n")}\n}`;
    }
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

export function printStep(s: ScenarioStep): string {
  const q = JSON.stringify;
  switch (s.kind) {
    case "visit": return `visit ${q(s.path)}`;
    case "click": return `click ${q(s.target)}`;
    case "fill": return `fill ${q(s.target)} ${q(s.value)}`;
    case "submit": return `submit ${q(s.target)}`;
    case "press": return `press ${q(s.key)}`;
    case "wait": return `wait ${s.ms}`;
    case "screenshot": return `screenshot ${q(s.name)}`;
    case "expect":
      switch (s.check) {
        case "visible":
        case "hidden": return `expect ${q(s.target)} ${s.check}`;
        case "count": return `expect ${q(s.target)} count ${s.value}`;
        case "attr": return `expect ${q(s.target)} attr ${q(s.attr ?? "")} ${q(String(s.value ?? ""))}`;
        default: return `expect ${q(s.target)} ${s.check} ${q(String(s.value ?? ""))}`;
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
