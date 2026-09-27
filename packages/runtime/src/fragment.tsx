"use client";
/**
 * <Orchid>: render a fragment of Orchidery ui at runtime, typically from
 * model output. The fragment is parsed and validated first (see
 * @orchidery/core fragment.ts); nothing in it is evaluated as code. Data
 * paths read from `data`, tokens become CSS variables, and event props
 * become calls to `onAction`.
 *
 * This is a client component so `onAction` can be a function. To render
 * on the server without actions, use renderFragmentToHtml from
 * "@orchidery/runtime/fragment-server".
 */
import { createElement, Fragment, useMemo, type ComponentType, type ReactNode } from "react";
import { classify, parseActionCall, parseFragment, readPath, validateFragment, type Diagnostic, type Expr, type FragmentOptions, type UiNode } from "@orchidery/core/browser";
import { isEventProp } from "@orchidery/core/browser";
import * as primitives from "./index.js";

export interface OrchidProps {
  /** Fragment source text (the contents of a ui block). */
  source?: string;
  /** Or an already-parsed fragment, e.g. from structured model output. */
  nodes?: UiNode[];
  /** Host data the fragment reads as `data.<key>`. */
  data?: Record<string, unknown>;
  /** Host components the fragment may use by name. */
  components?: Record<string, ComponentType<Record<string, unknown>>>;
  /** Called for `act("name", ...args)` on event props. */
  onAction?: (name: string, args: unknown[]) => void;
  /** Action names to validate against. Defaults to any. */
  actions?: string[];
  /** Token namespaces to validate against. Defaults to the conventional set. */
  tokens?: string[];
  /** What to render when the fragment is invalid. Defaults to nothing. */
  fallback?: (diagnostics: Diagnostic[]) => ReactNode;
  /** Called with diagnostics when the fragment is invalid. */
  onInvalid?: (diagnostics: Diagnostic[]) => void;
}

export interface Prepared {
  nodes: UiNode[];
  diagnostics: Diagnostic[];
}

/** Parse and validate a fragment against the host's registrations. */
export function prepareFragment(input: { source?: string; nodes?: UiNode[] }, opts: FragmentOptions): Prepared {
  let nodes: UiNode[] = [];
  try {
    nodes = input.nodes ?? (input.source !== undefined ? parseFragment(input.source) : []);
  } catch (e) {
    const d = (e as { diagnostic?: Diagnostic }).diagnostic ?? { code: "O001", severity: "error" as const, message: (e as Error).message };
    return { nodes: [], diagnostics: [d] };
  }
  return { nodes, diagnostics: validateFragment(nodes, opts) };
}

export function Orchid(props: OrchidProps) {
  const { source, nodes, data, components, onAction, actions, tokens, fallback, onInvalid } = props;
  const componentNames = useMemo(() => Object.keys(components ?? {}), [components]);
  const prepared = useMemo(
    () => prepareFragment({ source, nodes }, { components: componentNames, actions, tokens, data: data ? Object.keys(data) : undefined }),
    [source, nodes, componentNames, actions, tokens, data],
  );
  if (prepared.diagnostics.length) {
    onInvalid?.(prepared.diagnostics);
    return fallback ? <>{fallback(prepared.diagnostics)}</> : null;
  }
  return <>{renderNodes(prepared.nodes, { data: data ?? {} }, { components: components ?? {}, onAction })}</>;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

export interface RenderEnv {
  components: Record<string, ComponentType<Record<string, unknown>>>;
  onAction?: (name: string, args: unknown[]) => void;
}

type Scope = Record<string, unknown>;

const PRIMITIVES: Record<string, ComponentType<Record<string, unknown>>> = {
  Box: primitives.Box as ComponentType<Record<string, unknown>>,
  Stack: primitives.Stack as ComponentType<Record<string, unknown>>,
  Text: primitives.Text as ComponentType<Record<string, unknown>>,
  Heading: primitives.Heading as ComponentType<Record<string, unknown>>,
  Button: primitives.Button as ComponentType<Record<string, unknown>>,
  Input: primitives.Input as ComponentType<Record<string, unknown>>,
  Textarea: primitives.Textarea as ComponentType<Record<string, unknown>>,
  Form: primitives.Form as ComponentType<Record<string, unknown>>,
  Link: primitives.Link as ComponentType<Record<string, unknown>>,
  Image: primitives.Image as ComponentType<Record<string, unknown>>,
  Divider: primitives.Divider as ComponentType<Record<string, unknown>>,
  Spacer: primitives.Spacer as ComponentType<Record<string, unknown>>,
};

export function renderNodes(nodes: UiNode[], scope: Scope, env: RenderEnv): ReactNode[] {
  return nodes.map((n, i) => renderNode(n, scope, env, i));
}

function renderNode(n: UiNode, scope: Scope, env: RenderEnv, key: number | string): ReactNode {
  switch (n.kind) {
    case "text":
      return n.value;
    case "expr":
      return stringify(evaluate(classify(n.code), scope));
    case "slot":
      return null;
    case "if": {
      const test = evaluate(n.test.kind === "code" ? classify(n.test.code) : n.test, scope);
      const branch = test ? n.then : n.else;
      return branch ? createElement(Fragment, { key }, ...renderNodes(branch, scope, env)) : null;
    }
    case "for": {
      const iterable = evaluate(n.iterable.kind === "code" ? classify(n.iterable.code) : n.iterable, scope);
      const items = Array.isArray(iterable) ? iterable : [];
      return createElement(
        Fragment,
        { key },
        ...items.map((item, i) => {
          const inner: Scope = { ...scope, [n.item]: item };
          if (n.index) inner[n.index] = i;
          const k = n.key ? stringify(evaluate(n.key.kind === "code" ? classify(n.key.code) : n.key, inner)) : String(i);
          return createElement(Fragment, { key: k }, ...renderNodes(n.body, inner, env));
        }),
      );
    }
    case "element": {
      const Comp = PRIMITIVES[n.name] ?? env.components[n.name];
      if (!Comp) return null;
      const props: Record<string, unknown> = { key };
      for (const p of n.props) {
        if (isEventProp(p.name)) {
          const code = p.value.kind === "code" ? p.value.code : p.value.kind === "ref" ? p.value.path : "";
          const call = parseActionCall(code);
          if (!call) continue;
          props[p.name] = () => env.onAction?.(call.name, call.args.map((a) => evaluate(a, scope)));
        } else {
          props[p.name] = evaluate(p.value.kind === "code" ? classify(p.value.code) : p.value, scope);
        }
      }
      if (n.id) props["data-orchid-id"] = n.id;
      const children = n.children.length ? renderNodes(n.children, scope, env) : undefined;
      return children ? createElement(Comp, props, ...children) : createElement(Comp, props);
    }
  }
}

/** Evaluate a fragment-safe expression. Never runs code. */
export function evaluate(e: Expr, scope: Scope): unknown {
  switch (e.kind) {
    case "string":
    case "number":
    case "boolean":
      return e.value;
    case "ref": {
      const head = e.path.split(".")[0]!;
      if (head in scope) return readPath(e.path, scope);
      // A token: color.primary -> var(--color-primary)
      return `var(--${e.path.replace(/\./g, "-")})`;
    }
    case "code": {
      const s = e.code.trim();
      if (s.startsWith("`") && s.endsWith("`")) {
        return s.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_, inner: string) => stringify(evaluate(classify(inner), scope)));
      }
      return undefined;
    }
  }
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
