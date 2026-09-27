import type { Document, ImportDecl, Item, PageDecl, ResourceDecl, UiNode } from "./ast.js";
import { parse } from "./parser.js";
import { print } from "./print.js";
import { lower } from "./emit/resources.js";

/**
 * Grow a resource into ordinary pages: a list page with a create form, a
 * detail page with an edit form and delete, all as `.orchid` source the
 * agent can then graft like anything else. Nothing here runs at build time.
 */
export interface GrowOptions {
  /** The Next.js app dir, for the `@/<out>/_orchidery/resources/<Name>` import. Default `app`. */
  out?: string;
  /** Imports to carry over (usually the resource's own document imports, for its `source`). */
  imports?: ImportDecl[];
}

export function growResource(r: ResourceDecl, opts: GrowOptions = {}): string {
  const out = opts.out ?? "app";
  const N = r.name;
  const sourceHead = r.source.split(".")[0]!;
  // Bindings must not shadow the source object they read from (`notes: await notes.list()`).
  const one = lower(N) === sourceHead ? `${lower(N)}Item` : lower(N);
  const many = `${lower(N)}s` === sourceHead ? `${lower(N)}List` : `${lower(N)}s`;
  const base = r.routes.replace(/\/+$/, "");
  const parseFn = `parse${N}`;
  const imports: ImportDecl[] = [
    ...(opts.imports ?? []).filter((i) => !i.names.includes(parseFn) && !i.names.includes("notFound")),
    { kind: "import", names: [parseFn], from: `@/${out}/_orchidery/resources/${N}` },
    { kind: "import", names: ["notFound"], from: "next/navigation" },
  ];

  const label = (f: string) => f.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const inputFor = (f: ResourceDecl["fields"][number], existing?: string): string => {
    const props: string[] = [`name: ${JSON.stringify(f.name)}`];
    if (f.type === "boolean") {
      props.push(`type: "checkbox"`, `label: ${JSON.stringify(label(f.name))}`);
      if (existing) props.push(`defaultChecked: ${existing}.${f.name}`);
    } else {
      if (f.type === "number") props.push(`type: "number"`);
      if (f.type === "Date") props.push(`type: "date"`);
      props.push(`placeholder: ${JSON.stringify(label(f.name))}`);
      if (existing) props.push(`defaultValue: ${f.type === "Date" ? `${existing}.${f.name}?.toISOString().slice(0, 10)` : `${existing}.${f.name}`}`);
      if (!f.optional && f.default === undefined) props.push("required");
    }
    return `Input(${props.join(", ")})`;
  };
  const title = r.fields.find((f) => f.type === "string")?.name ?? "id";

  const listPage = `page ${JSON.stringify(base)} {
  meta {
    title: ${JSON.stringify(N + "s")}
  }

  load {
    ${many}: await ${r.source}.list()
  }

  action create(form: FormData) {
    await ${r.source}.create(${parseFn}(form))
    revalidate ${JSON.stringify(base)}
  }

  ui {
    Stack(gap: 16) {
      Heading(level: 1) { ${JSON.stringify(N + "s")} }
      Form#create(action: create) {
        Stack(gap: 8) {
${r.fields.map((f) => `          ${inputFor(f)}`).join("\n")}
          Button(type: "submit", variant: "primary") { ${JSON.stringify("Add " + one)} }
        }
      }
      if ${many}.length === 0 {
        Text(muted) { ${JSON.stringify(`No ${many} yet.`)} }
      }
      for ${one} in ${many} key ${one}.id {
        Link(href: \`${base}/\${${one}.id}\`) { ${one}.${title} }
      }
    }
  }
}`;

  const detailPage = `page ${JSON.stringify(base + "/[id]")} {
  load {
    ${one}: (await ${r.source}.find(params.id)) ?? notFound()
  }

  action update(id: string, form: FormData) {
    await ${r.source}.update(id, ${parseFn}(form))
    revalidate ${JSON.stringify(base)}
    revalidate ${JSON.stringify(base + "/[id]")}
  }

  action remove(id: string) {
    await ${r.source}.remove(id)
    revalidate ${JSON.stringify(base)}
    redirect ${JSON.stringify(base)}
  }

  ui {
    Stack(gap: 16) {
      Heading#title(level: 1) { ${one}.${title} }
      Form#edit(action: update.bind(null, ${one}.id)) {
        Stack(gap: 8) {
${r.fields.map((f) => `          ${inputFor(f, one)}`).join("\n")}
          Stack(direction: "row", gap: 8) {
            Button(type: "submit", variant: "primary") { "Save" }
            Button#remove(onClick: remove(${one}.id), variant: "danger") { "Delete" }
            Button(href: ${JSON.stringify(base)}) { "Back" }
          }
        }
      }
    }
  }
}`;

  // Round-trip through the parser so the output is canonical and known-valid syntax.
  const text = `${imports.map(printImport).join("\n")}\n\n${listPage}\n\n${detailPage}\n`;
  const doc: Document = parse(text, { file: `<grown ${N}>` });
  return print(doc);
}

function printImport(i: ImportDecl): string {
  const parts: string[] = [];
  if (i.default) parts.push(i.default);
  if (i.names.length) parts.push(`{ ${i.names.join(", ")} }`);
  return `import ${parts.join(", ")} from ${JSON.stringify(i.from)}`;
}

/** The routes a grown resource would declare, to detect clashes before writing. */
export function grownRoutes(r: ResourceDecl): string[] {
  const base = r.routes.replace(/\/+$/, "");
  return [base, `${base}/[id]`];
}

export type { PageDecl, Item, UiNode };
