/**
 * Server-side rendering of fragments: no actions, plain HTML out. Useful for
 * emails, previews, and rendering model output inside a server component.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import type { Diagnostic, FragmentOptions, UiNode } from "@orchidery/core/browser";
import { prepareFragment, renderNodes } from "./fragment.js";

export interface RenderFragmentOptions extends Omit<FragmentOptions, "data"> {
  /** Host data the fragment reads as `data.<key>`. Its keys are what the validator allows. */
  data?: Record<string, unknown>;
  componentMap?: Record<string, ComponentType<Record<string, unknown>>>;
}

export function renderFragmentToHtml(
  input: { source?: string; nodes?: UiNode[] },
  opts: RenderFragmentOptions = {},
): { html: string; diagnostics: Diagnostic[] } {
  const prepared = prepareFragment(input, {
    components: opts.components ?? Object.keys(opts.componentMap ?? {}),
    actions: opts.actions,
    tokens: opts.tokens,
    data: opts.data ? Object.keys(opts.data) : undefined,
  });
  if (prepared.diagnostics.length) return { html: "", diagnostics: prepared.diagnostics };
  const html = renderToStaticMarkup(<>{renderNodes(prepared.nodes, { data: opts.data ?? {} }, { components: opts.componentMap ?? {} })}</>);
  return { html, diagnostics: [] };
}
