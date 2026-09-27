import { z } from "zod";

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export const Position = z.object({
  line: z.number().int().min(1),
  col: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export type Position = z.infer<typeof Position>;

export const Span = z.object({ start: Position, end: Position });
export type Span = z.infer<typeof Span>;

const spanned = { span: Span.optional() };

// ---------------------------------------------------------------------------
// Expressions. Orchidery is structural, not expressive: anything that is not
// a literal or a dotted reference is TypeScript passed through verbatim.
// ---------------------------------------------------------------------------

export const StringLit = z.object({ kind: z.literal("string"), value: z.string(), ...spanned });
export const NumberLit = z.object({ kind: z.literal("number"), value: z.number(), ...spanned });
export const BooleanLit = z.object({ kind: z.literal("boolean"), value: z.boolean(), ...spanned });
/** A dotted identifier such as `space.md`. Resolved to a token if one matches, else emitted as code. */
export const Ref = z.object({ kind: z.literal("ref"), path: z.string(), ...spanned });
/** Raw TypeScript. */
export const Code = z.object({ kind: z.literal("code"), code: z.string(), ...spanned });

export const Expr = z.discriminatedUnion("kind", [StringLit, NumberLit, BooleanLit, Ref, Code]);
export type Expr = z.infer<typeof Expr>;

// ---------------------------------------------------------------------------
// UI tree
// ---------------------------------------------------------------------------

export const Prop = z.object({
  kind: z.literal("prop"),
  name: z.string(),
  value: Expr,
  ...spanned,
});
export type Prop = z.infer<typeof Prop>;

export type UiNode =
  | Element
  | TextNode
  | ExprNode
  | SlotNode
  | IfNode
  | ForNode;

export interface Element {
  kind: "element";
  name: string;
  id?: string;
  props: Prop[];
  children: UiNode[];
  span?: Span;
}
export interface TextNode { kind: "text"; value: string; span?: Span }
export interface ExprNode { kind: "expr"; code: string; span?: Span }
export interface SlotNode { kind: "slot"; name: string; span?: Span }
export interface IfNode { kind: "if"; test: Expr; then: UiNode[]; else?: UiNode[]; span?: Span }
export interface ForNode {
  kind: "for";
  item: string;
  index?: string;
  iterable: Expr;
  key?: Expr;
  body: UiNode[];
  span?: Span;
}

export const UiNode: z.ZodType<UiNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("element"),
      name: z.string(),
      id: z.string().optional(),
      props: z.array(Prop),
      children: z.array(UiNode),
      ...spanned,
    }),
    z.object({ kind: z.literal("text"), value: z.string(), ...spanned }),
    z.object({ kind: z.literal("expr"), code: z.string(), ...spanned }),
    z.object({ kind: z.literal("slot"), name: z.string(), ...spanned }),
    z.object({
      kind: z.literal("if"),
      test: Expr,
      then: z.array(UiNode),
      else: z.array(UiNode).optional(),
      ...spanned,
    }),
    z.object({
      kind: z.literal("for"),
      item: z.string(),
      index: z.string().optional(),
      iterable: Expr,
      key: Expr.optional(),
      body: z.array(UiNode),
      ...spanned,
    }),
  ]) as unknown as z.ZodType<UiNode>,
);

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export const Param = z.object({
  kind: z.literal("param"),
  name: z.string(),
  type: z.string().optional(),
  ...spanned,
});
export type Param = z.infer<typeof Param>;

export const TokenEntry = z.object({
  kind: z.literal("token"),
  path: z.string(),
  value: z.union([z.string(), z.number()]),
  ...spanned,
});
export type TokenEntry = z.infer<typeof TokenEntry>;

export const TokensDecl = z.object({
  kind: z.literal("tokens"),
  entries: z.array(TokenEntry),
  ...spanned,
});
export type TokensDecl = z.infer<typeof TokensDecl>;

export const ImportDecl = z.object({
  kind: z.literal("import"),
  /** Default import name, if any. */
  default: z.string().optional(),
  /** Named imports. */
  names: z.array(z.string()),
  from: z.string(),
  ...spanned,
});
export type ImportDecl = z.infer<typeof ImportDecl>;

export const ComponentDecl = z.object({
  kind: z.literal("component"),
  name: z.string(),
  params: z.array(Param),
  body: z.array(UiNode),
  ...spanned,
});
export type ComponentDecl = z.infer<typeof ComponentDecl>;

export const LoadBinding = z.object({
  kind: z.literal("binding"),
  name: z.string(),
  expr: Expr,
  ...spanned,
});
export type LoadBinding = z.infer<typeof LoadBinding>;

export const LoadBlock = z.object({
  kind: z.literal("load"),
  bindings: z.array(LoadBinding),
  ...spanned,
});
export type LoadBlock = z.infer<typeof LoadBlock>;

export const ActionStmt = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw"), code: z.string(), ...spanned }),
  z.object({ kind: z.literal("revalidate"), path: z.string(), ...spanned }),
  z.object({ kind: z.literal("redirect"), path: z.string(), ...spanned }),
]);
export type ActionStmt = z.infer<typeof ActionStmt>;

export const ActionDecl = z.object({
  kind: z.literal("action"),
  name: z.string(),
  params: z.array(Param),
  body: z.array(ActionStmt),
  ...spanned,
});
export type ActionDecl = z.infer<typeof ActionDecl>;

export const MetaEntry = z.object({
  kind: z.literal("meta-entry"),
  name: z.string(),
  value: Expr,
  ...spanned,
});
export const MetaBlock = z.object({
  kind: z.literal("meta"),
  entries: z.array(MetaEntry),
  ...spanned,
});
export type MetaBlock = z.infer<typeof MetaBlock>;

export const PageDecl = z.object({
  kind: z.literal("page"),
  route: z.string(),
  load: LoadBlock.optional(),
  actions: z.array(ActionDecl),
  meta: MetaBlock.optional(),
  ui: z.array(UiNode),
  ...spanned,
});
export type PageDecl = z.infer<typeof PageDecl>;

export const LayoutDecl = z.object({
  kind: z.literal("layout"),
  route: z.string(),
  load: LoadBlock.optional(),
  meta: MetaBlock.optional(),
  ui: z.array(UiNode),
  ...spanned,
});
export type LayoutDecl = z.infer<typeof LayoutDecl>;

// ---------------------------------------------------------------------------
// Scenarios: tests written in the addressing vocabulary. Ignored by the
// emitter; run by the devtools scenario runner against the dev server.
// ---------------------------------------------------------------------------

/** A step target: a full address, or `#id` resolved against the current page. */
const Target = z.string();

export const ScenarioStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visit"), path: z.string(), ...spanned }),
  z.object({ kind: z.literal("click"), target: Target, ...spanned }),
  z.object({ kind: z.literal("fill"), target: Target, value: z.string(), ...spanned }),
  z.object({ kind: z.literal("submit"), target: Target, ...spanned }),
  z.object({ kind: z.literal("press"), key: z.string(), ...spanned }),
  z.object({
    kind: z.literal("expect"),
    target: Target,
    check: z.enum(["text", "contains", "visible", "hidden", "count", "attr"]),
    /** For text/contains/attr: the expected string. For count: the expected number. */
    value: z.union([z.string(), z.number()]).optional(),
    /** For attr: the attribute name. */
    attr: z.string().optional(),
    ...spanned,
  }),
  z.object({ kind: z.literal("wait"), ms: z.number(), ...spanned }),
  z.object({ kind: z.literal("screenshot"), name: z.string(), ...spanned }),
]);
export type ScenarioStep = z.infer<typeof ScenarioStep>;

export const ScenarioDecl = z.object({
  kind: z.literal("scenario"),
  name: z.string(),
  steps: z.array(ScenarioStep),
  ...spanned,
});
export type ScenarioDecl = z.infer<typeof ScenarioDecl>;

// ---------------------------------------------------------------------------
// Islands: client components with local state. The only way to get client
// state in Orchidery, which keeps the server/client boundary explicit.
// ---------------------------------------------------------------------------

export const StateEntry = z.object({
  kind: z.literal("state"),
  name: z.string(),
  initial: Expr,
  ...spanned,
});
export type StateEntry = z.infer<typeof StateEntry>;

export const IslandDecl = z.object({
  kind: z.literal("island"),
  name: z.string(),
  params: z.array(Param),
  state: z.array(StateEntry),
  body: z.array(UiNode),
  ...spanned,
});
export type IslandDecl = z.infer<typeof IslandDecl>;

/** `count` -> `setCount` */
export function setterName(state: string): string {
  return "set" + state.charAt(0).toUpperCase() + state.slice(1);
}

export const Item = z.discriminatedUnion("kind", [
  TokensDecl,
  ImportDecl,
  ComponentDecl,
  IslandDecl,
  PageDecl,
  LayoutDecl,
  ScenarioDecl,
]);
export type Item = z.infer<typeof Item>;

export const Document = z.object({
  kind: z.literal("document"),
  file: z.string().optional(),
  items: z.array(Item),
});
export type Document = z.infer<typeof Document>;

/** JSON Schema for a whole document, for agents using structured output. */
export function documentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Document, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

export function exprToCode(e: Expr): string {
  switch (e.kind) {
    case "string": return JSON.stringify(e.value);
    case "number": return String(e.value);
    case "boolean": return String(e.value);
    case "ref": return e.path;
    case "code": return e.code;
  }
}
