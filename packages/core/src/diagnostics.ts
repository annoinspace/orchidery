import type { Span } from "./ast.js";

export type Severity = "error" | "warning" | "info";

export interface Fix {
  description: string;
  /** Replacement text for the diagnostic's range, when the fix is a simple substitution. */
  replacement?: string;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  file?: string;
  range?: Span;
  fix?: Fix;
}

export class OrchidError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "OrchidError";
  }
}

/**
 * Every diagnostic code Orchidery can produce. Kept in one place so
 * docs/diagnostics.md and `orchid_explain` stay in sync with the code.
 */
export const DIAGNOSTIC_DOCS: Record<string, { title: string; explanation: string }> = {
  // Syntax: O0xx
  O001: { title: "Unexpected token", explanation: "The parser found something it did not expect at this position. Check for a missing brace, parenthesis or quote." },
  O002: { title: "Unterminated string", explanation: "A string literal was opened but never closed on the same line." },
  O003: { title: "Unterminated block", explanation: "A `{` was opened but the file ended before its matching `}`." },
  O004: { title: "Expected identifier", explanation: "A name was expected here, such as a component, page or prop name." },
  O005: { title: "Unknown top-level declaration", explanation: "Only `tokens`, `import`, `component`, `layout` and `page` may appear at the top level of a .orchid file." },
  O006: { title: "Unknown page block", explanation: "Inside a `page` only `load`, `action`, `meta` and `ui` blocks are allowed." },
  O007: { title: "Invalid route", explanation: "Routes must start with `/` and use Next.js segment syntax such as `/todos/[id]`." },
  O008: { title: "Invalid token path", explanation: "Token paths are dotted identifiers such as `color.primary`." },

  // Semantics: O1xx
  O101: { title: "Duplicate route", explanation: "Two pages or two layouts declare the same route. Each route may be declared once across the project." },
  O102: { title: "Unknown component", explanation: "An element name starting with a capital letter is neither a built-in primitive, a declared component nor an imported name." },
  O103: { title: "Unknown token", explanation: "A dotted reference looks like a token path but no token with that path is declared." },
  O104: { title: "Unknown prop", explanation: "The prop is not accepted by this built-in primitive. The fix suggests the closest valid prop name." },
  O105: { title: "Missing required prop", explanation: "A built-in primitive or declared component requires a prop that was not given." },
  O106: { title: "Duplicate id", explanation: "Two nodes in the same page, layout or component share a `#id`. Ids must be unique within their root so addresses stay unambiguous." },
  O107: { title: "Event prop outside a page", explanation: "Event handlers such as `onClick` can only reference actions declared in the enclosing page." },
  O108: { title: "Unknown action", explanation: "An event handler calls an action that is not declared in this page." },
  O109: { title: "Action arity mismatch", explanation: "The action is called with a different number of arguments than it declares." },
  O110: { title: "Missing children slot", explanation: "A layout must render `children` somewhere in its `ui` block so pages have a place to go." },
  O111: { title: "Duplicate declaration", explanation: "Two components or two load bindings share a name." },
  O112: { title: "Unknown prop on component", explanation: "The prop is not one of the component's declared parameters." },
  O113: { title: "Duplicate prop", explanation: "The same prop is given twice on one element." },
  O114: { title: "Slot outside component or layout", explanation: "`children` can only be rendered inside a `component` or `layout` body." },

  // Graft: O2xx
  O201: { title: "Address not found", explanation: "No node matches the given address in this document." },
  O202: { title: "Invalid graft op", explanation: "The graft operation is malformed or targets a node kind it cannot apply to." },
  O203: { title: "Graft would produce invalid document", explanation: "Applying the ops produced a document that fails validation, so nothing was written." },
  O204: { title: "Invalid address syntax", explanation: "Addresses look like `page:/todos/[id] > ui > Card[0] > #done`." },
};

export function explain(code: string): { code: string; title: string; explanation: string } | undefined {
  const d = DIAGNOSTIC_DOCS[code];
  return d ? { code, ...d } : undefined;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file
    ? `${d.file}${d.range ? `:${d.range.start.line}:${d.range.start.col}` : ""}`
    : d.range
      ? `${d.range.start.line}:${d.range.start.col}`
      : "";
  const fix = d.fix ? `\n  fix: ${d.fix.description}` : "";
  return `${d.severity} ${d.code}${where ? ` ${where}` : ""}: ${d.message}${fix}`;
}
