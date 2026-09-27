import type {
  ActionDecl,
  ActionStmt,
  ComponentDecl,
  Document,
  Expr,
  ImportDecl,
  Item,
  LayoutDecl,
  LoadBlock,
  MetaBlock,
  PageDecl,
  Param,
  Prop,
  TokensDecl,
  UiNode,
} from "./ast.js";
import { Scanner } from "./lexer.js";

const TOP_LEVEL = ["tokens", "import", "component", "layout", "page"];
const PAGE_BLOCKS = ["load", "action", "meta", "ui"];
const LAYOUT_BLOCKS = ["load", "meta", "ui"];
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export interface ParseOptions {
  file?: string;
}

export function parse(src: string, opts: ParseOptions = {}): Document {
  return new Parser(src, opts.file).document();
}

/** Classify a raw value the same way prop values are classified. */
export function parseExpr(raw: string): Expr {
  const p = new Parser(raw);
  return p.exprValue(raw.trim(), p.s.position());
}

/** Parse a fragment of ui block content into nodes. */
export function parseUiSnippet(src: string): UiNode[] {
  const p = new Parser(src);
  const items = p.uiItems();
  p.s.skipWs();
  if (!p.s.eof) p.s.fail("O001", `Unexpected \`${p.s.describeNext()}\` after ui snippet`);
  return items;
}

/** Parse a single top-level declaration such as a component. */
export function parseItem(src: string): Item {
  const p = new Parser(src);
  p.s.skipWs();
  const item = p.item();
  p.s.skipWs();
  if (!p.s.eof) p.s.fail("O001", "Expected exactly one declaration");
  return item;
}

class Parser {
  s: Scanner;
  constructor(src: string, file?: string) {
    this.s = new Scanner(src, file);
  }

  document(): Document {
    const items: Item[] = [];
    this.s.skipWs();
    while (!this.s.eof) {
      items.push(this.item());
      this.s.skipWs();
    }
    return { kind: "document", file: this.s.file, items };
  }

  item(): Item {
    const start = this.s.position();
    const word = this.s.readIdent();
    switch (word) {
      case "tokens": return this.tokens(start);
      case "import": return this.import(start);
      case "component": return this.component(start);
      case "layout": return this.layout(start);
      case "page": return this.page(start);
      default:
        this.s.fail("O005", `Unknown top-level declaration \`${word}\`; expected one of ${TOP_LEVEL.join(", ")}`, start);
    }
  }

  // -- tokens --------------------------------------------------------------

  private tokens(start: ReturnType<Scanner["position"]>): TokensDecl {
    this.s.skipWs();
    this.s.expect("{");
    const entries: TokensDecl["entries"] = [];
    for (;;) {
      this.s.skipWs();
      if (this.s.eat("}")) break;
      if (this.s.eof) this.s.fail("O003", "Unterminated tokens block", start);
      const es = this.s.position();
      const path = this.s.readDotted();
      if (!path.includes(".")) this.s.fail("O008", `Token path \`${path}\` must be dotted, e.g. \`color.primary\``, es);
      this.s.skipInline();
      this.s.expect(":");
      this.s.skipInline();
      let value: string | number;
      if (this.s.peek() === '"' || this.s.peek() === "'") {
        value = this.s.readString();
      } else {
        const raw = this.s.readRaw("}", true);
        if (!NUMBER.test(raw)) this.s.fail("O001", `Token value must be a string or number, got \`${raw}\``, es);
        value = Number(raw);
      }
      entries.push({ kind: "token", path, value, span: this.s.spanFrom(es) });
      this.s.skipInline();
      this.s.eat(";");
    }
    return { kind: "tokens", entries, span: this.s.spanFrom(start) };
  }

  // -- import --------------------------------------------------------------

  private import(start: ReturnType<Scanner["position"]>): ImportDecl {
    this.s.skipInline();
    let def: string | undefined;
    const names: string[] = [];
    if (this.s.peek() !== "{") {
      def = this.s.readIdent();
      this.s.skipInline();
      this.s.eat(",");
      this.s.skipInline();
    }
    if (this.s.eat("{")) {
      for (;;) {
        this.s.skipWs();
        if (this.s.eat("}")) break;
        names.push(this.s.readIdent());
        this.s.skipWs();
        this.s.eat(",");
      }
    }
    this.s.skipInline();
    if (!this.s.peekWord("from")) this.s.fail("O001", "Expected `from` in import");
    this.s.readIdent();
    this.s.skipInline();
    const from = this.s.readString();
    this.s.skipInline();
    this.s.eat(";");
    return { kind: "import", default: def, names, from, span: this.s.spanFrom(start) };
  }

  // -- component -----------------------------------------------------------

  private component(start: ReturnType<Scanner["position"]>): ComponentDecl {
    this.s.skipInline();
    const name = this.s.readIdent();
    this.s.skipInline();
    const params = this.s.peek() === "(" ? this.params() : [];
    this.s.skipWs();
    const body = this.block(() => this.uiItems());
    return { kind: "component", name, params, body, span: this.s.spanFrom(start) };
  }

  private params(): Param[] {
    this.s.expect("(");
    const params: Param[] = [];
    for (;;) {
      this.s.skipWs();
      if (this.s.eat(")")) break;
      const ps = this.s.position();
      const name = this.s.readIdent();
      this.s.skipInline();
      let type: string | undefined;
      if (this.s.eat(":")) {
        this.s.skipInline();
        type = this.s.readRaw(",)", false);
      }
      params.push({ kind: "param", name, type, span: this.s.spanFrom(ps) });
      this.s.skipWs();
      this.s.eat(",");
    }
    return params;
  }

  // -- page / layout -------------------------------------------------------

  private route(): string {
    this.s.skipInline();
    const rs = this.s.position();
    const route = this.s.readString();
    if (!route.startsWith("/")) this.s.fail("O007", `Route \`${route}\` must start with /`, rs);
    return route;
  }

  private page(start: ReturnType<Scanner["position"]>): PageDecl {
    const route = this.route();
    this.s.skipWs();
    const page: PageDecl = { kind: "page", route, actions: [], ui: [] };
    let sawUi = false;
    this.block(() => {
      for (;;) {
        this.s.skipWs();
        if (this.s.peek() === "}" || this.s.eof) return;
        const bs = this.s.position();
        const word = this.s.readIdent();
        switch (word) {
          case "load": page.load = this.load(bs); break;
          case "action": page.actions.push(this.action(bs)); break;
          case "meta": page.meta = this.meta(bs); break;
          case "ui": this.s.skipWs(); page.ui = this.block(() => this.uiItems()); sawUi = true; break;
          default:
            this.s.fail("O006", `Unknown block \`${word}\` in page; expected one of ${PAGE_BLOCKS.join(", ")}`, bs);
        }
      }
    });
    void sawUi;
    page.span = this.s.spanFrom(start);
    return page;
  }

  private layout(start: ReturnType<Scanner["position"]>): LayoutDecl {
    const route = this.route();
    this.s.skipWs();
    const layout: LayoutDecl = { kind: "layout", route, ui: [] };
    this.block(() => {
      for (;;) {
        this.s.skipWs();
        if (this.s.peek() === "}" || this.s.eof) return;
        const bs = this.s.position();
        const word = this.s.readIdent();
        switch (word) {
          case "load": layout.load = this.load(bs); break;
          case "meta": layout.meta = this.meta(bs); break;
          case "ui": this.s.skipWs(); layout.ui = this.block(() => this.uiItems()); break;
          default:
            this.s.fail("O006", `Unknown block \`${word}\` in layout; expected one of ${LAYOUT_BLOCKS.join(", ")}`, bs);
        }
      }
    });
    layout.span = this.s.spanFrom(start);
    return layout;
  }

  private load(start: ReturnType<Scanner["position"]>): LoadBlock {
    this.s.skipWs();
    const bindings: LoadBlock["bindings"] = [];
    this.block(() => {
      for (;;) {
        this.s.skipWs();
        if (this.s.peek() === "}" || this.s.eof) return;
        const bs = this.s.position();
        const name = this.s.readIdent();
        this.s.skipInline();
        this.s.expect(":");
        this.s.skipInline();
        const expr = this.exprValue(this.s.readRaw("}", true), bs);
        bindings.push({ kind: "binding", name, expr, span: this.s.spanFrom(bs) });
        this.s.skipInline();
        this.s.eat(";");
      }
    });
    return { kind: "load", bindings, span: this.s.spanFrom(start) };
  }

  private meta(start: ReturnType<Scanner["position"]>): MetaBlock {
    this.s.skipWs();
    const entries: MetaBlock["entries"] = [];
    this.block(() => {
      for (;;) {
        this.s.skipWs();
        if (this.s.peek() === "}" || this.s.eof) return;
        const bs = this.s.position();
        const name = this.s.readIdent();
        this.s.skipInline();
        this.s.expect(":");
        this.s.skipInline();
        const value = this.exprValue(this.s.readRaw("}", true), bs);
        entries.push({ kind: "meta-entry", name, value, span: this.s.spanFrom(bs) });
        this.s.skipInline();
        this.s.eat(";");
      }
    });
    return { kind: "meta", entries, span: this.s.spanFrom(start) };
  }

  private action(start: ReturnType<Scanner["position"]>): ActionDecl {
    this.s.skipInline();
    const name = this.s.readIdent();
    this.s.skipInline();
    const params = this.s.peek() === "(" ? this.params() : [];
    this.s.skipWs();
    const body: ActionStmt[] = [];
    this.block(() => {
      for (;;) {
        this.s.skipWs();
        if (this.s.peek() === "}" || this.s.eof) return;
        const bs = this.s.position();
        if (this.s.peekWord("revalidate") || this.s.peekWord("redirect")) {
          const kind = this.s.readIdent() as "revalidate" | "redirect";
          this.s.skipInline();
          const path = this.s.readString();
          body.push({ kind, path, span: this.s.spanFrom(bs) });
        } else {
          const code = this.s.readRaw("}", true);
          if (code) body.push({ kind: "raw", code, span: this.s.spanFrom(bs) });
        }
        this.s.skipInline();
        this.s.eat(";");
      }
    });
    return { kind: "action", name, params, body, span: this.s.spanFrom(start) };
  }

  // -- ui ------------------------------------------------------------------

  private block<T>(body: () => T): T {
    const start = this.s.position();
    this.s.expect("{");
    const result = body();
    this.s.skipWs();
    if (this.s.eof) this.s.fail("O003", "Unterminated block", start);
    this.s.expect("}");
    return result;
  }

  uiItems(): UiNode[] {
    const items: UiNode[] = [];
    for (;;) {
      this.s.skipWs();
      if (this.s.peek() === "}" || this.s.eof) return items;
      if (this.s.eat(";")) continue;
      items.push(this.uiItem());
    }
  }

  private uiItem(): UiNode {
    const start = this.s.position();
    const c = this.s.peek();

    if (c === '"' || c === "'") {
      const value = this.s.readString();
      return { kind: "text", value, span: this.s.spanFrom(start) };
    }

    if (this.s.peekWord("children")) {
      this.s.readIdent();
      return { kind: "slot", name: "children", span: this.s.spanFrom(start) };
    }
    if (this.s.peekWord("if")) return this.ifNode(start);
    if (this.s.peekWord("for")) return this.forNode(start);

    if (this.looksLikeElement()) return this.element(start);

    const code = this.s.readRaw("}", true);
    if (!code) this.s.fail("O001", `Unexpected \`${this.s.describeNext()}\` in ui block`, start);
    return { kind: "expr", code, span: this.s.spanFrom(start) };
  }

  /** An element is a Capitalised identifier followed by `#`, `(`, `{`, newline, `}` or EOF. */
  private looksLikeElement(): boolean {
    if (!/[A-Z]/.test(this.s.peek())) return false;
    let i = 0;
    while (this.s.isIdentPart(this.s.peek(i))) i++;
    while (this.s.peek(i) === " " || this.s.peek(i) === "\t") i++;
    const next = this.s.peek(i);
    return next === "#" || next === "(" || next === "{" || next === "\n" || next === "}" || next === ";" || next === "";
  }

  private element(start: ReturnType<Scanner["position"]>): UiNode {
    const name = this.s.readIdent();
    let id: string | undefined;
    if (this.s.eat("#")) id = this.s.readIdent();
    this.s.skipInline();
    let props: Prop[] = [];
    if (this.s.peek() === "(") props = this.props();
    this.s.skipInline();
    let children: UiNode[] = [];
    if (this.s.peek() === "{") children = this.block(() => this.uiItems());
    return { kind: "element", name, id, props, children, span: this.s.spanFrom(start) };
  }

  private props(): Prop[] {
    this.s.expect("(");
    const props: Prop[] = [];
    for (;;) {
      this.s.skipWs();
      if (this.s.eat(")")) break;
      if (this.s.eof) this.s.fail("O003", "Unterminated prop list");
      const ps = this.s.position();
      const name = this.s.readIdent();
      this.s.skipInline();
      let value: Expr;
      if (this.s.eat(":")) {
        this.s.skipWs();
        const vs = this.s.position();
        value = this.exprValue(this.s.readRaw(",)", false), vs);
      } else {
        value = { kind: "boolean", value: true, span: this.s.spanFrom(ps) };
      }
      props.push({ kind: "prop", name, value, span: this.s.spanFrom(ps) });
      this.s.skipWs();
      this.s.eat(",");
    }
    return props;
  }

  private ifNode(start: ReturnType<Scanner["position"]>): UiNode {
    this.s.readIdent(); // if
    this.s.skipInline();
    const ts = this.s.position();
    const test = this.exprValue(this.s.readRaw("{", true), ts);
    this.s.skipWs();
    const then = this.block(() => this.uiItems());
    let elseBranch: UiNode[] | undefined;
    const save = { pos: this.s.pos, line: this.s.line, col: this.s.col };
    this.s.skipWs();
    if (this.s.peekWord("else")) {
      this.s.readIdent();
      this.s.skipWs();
      if (this.s.peekWord("if")) {
        elseBranch = [this.ifNode(this.s.position())];
      } else {
        elseBranch = this.block(() => this.uiItems());
      }
    } else {
      Object.assign(this.s, save);
    }
    return { kind: "if", test, then, else: elseBranch, span: this.s.spanFrom(start) };
  }

  private forNode(start: ReturnType<Scanner["position"]>): UiNode {
    this.s.readIdent(); // for
    this.s.skipInline();
    const item = this.s.readIdent();
    this.s.skipInline();
    let index: string | undefined;
    if (this.s.eat(",")) {
      this.s.skipInline();
      index = this.s.readIdent();
      this.s.skipInline();
    }
    if (!this.s.peekWord("in")) this.s.fail("O001", "Expected `in` in for loop");
    this.s.readIdent();
    this.s.skipInline();
    const is = this.s.position();
    let raw = this.s.readRaw("{", true);
    let key: Expr | undefined;
    const m = /\s+key\s+(.+)$/.exec(raw);
    if (m) {
      key = this.exprValue(m[1]!.trim(), is);
      raw = raw.slice(0, m.index).trim();
    }
    const iterable = this.exprValue(raw, is);
    this.s.skipWs();
    const body = this.block(() => this.uiItems());
    return { kind: "for", item, index, iterable, key, body, span: this.s.spanFrom(start) };
  }

  // -- expressions ---------------------------------------------------------

  /** Classify a raw expression as a literal, a dotted reference, or code. */
  exprValue(raw: string, at: ReturnType<Scanner["position"]>): Expr {
    const span = this.s.spanFrom(at);
    if (raw === "") this.s.fail("O001", "Expected a value", at);
    if ((raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0]!) && raw.length >= 2) {
      const inner = new Scanner(raw);
      try {
        const value = inner.readString();
        if (inner.eof) return { kind: "string", value, span };
      } catch {
        /* fall through to code */
      }
    }
    if (NUMBER.test(raw)) return { kind: "number", value: Number(raw), span };
    if (raw === "true" || raw === "false") return { kind: "boolean", value: raw === "true", span };
    if (DOTTED.test(raw)) return { kind: "ref", path: raw, span };
    return { kind: "code", code: raw, span };
  }
}
