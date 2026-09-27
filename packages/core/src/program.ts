import type { ComponentDecl, Document, ImportDecl, LayoutDecl, PageDecl, TokenEntry } from "./ast.js";
import { parse } from "./parser.js";

/** A set of .orchid documents compiled together. */
export interface Program {
  documents: Document[];
}

export function programFromSources(sources: { file: string; text: string }[]): Program {
  return { documents: sources.map((s) => parse(s.text, { file: s.file })) };
}

export function programFromDocument(doc: Document): Program {
  return { documents: [doc] };
}

export function tokensOf(p: Program): TokenEntry[] {
  return p.documents.flatMap((d) => d.items.filter((i) => i.kind === "tokens").flatMap((t) => t.entries));
}

export function tokenNamespaces(p: Program): Set<string> {
  return new Set(tokensOf(p).map((t) => t.path.split(".")[0]!));
}

export function componentsOf(p: Program): ComponentDecl[] {
  return p.documents.flatMap((d) => d.items.filter((i): i is ComponentDecl => i.kind === "component"));
}

export function pagesOf(p: Program): PageDecl[] {
  return p.documents.flatMap((d) => d.items.filter((i): i is PageDecl => i.kind === "page"));
}

export function layoutsOf(p: Program): LayoutDecl[] {
  return p.documents.flatMap((d) => d.items.filter((i): i is LayoutDecl => i.kind === "layout"));
}

export function importsOf(doc: Document): ImportDecl[] {
  return doc.items.filter((i): i is ImportDecl => i.kind === "import");
}

export function importedNames(doc: Document): Set<string> {
  const names = new Set<string>();
  for (const imp of importsOf(doc)) {
    if (imp.default) names.add(imp.default);
    for (const n of imp.names) names.add(n);
  }
  return names;
}

export function documentOf(p: Program, item: object): Document | undefined {
  return p.documents.find((d) => d.items.includes(item as never));
}
