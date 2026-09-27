import { describe, expect, it } from "vitest";
import { emit, growResource, grownRoutes, parse, print, validate, programFromDocument, programFromSources } from "../src/index.js";

const SRC = `import { db } from "@/lib/db"

resource Note {
  fields {
    title: string
    body: string?
    pinned: boolean = false
    priority: number = 1
    due: Date?
  }
  source db.notes
  routes "/notes"
}
`;

describe("resources", () => {
  it("parses, prints and validates", () => {
    const doc = parse(SRC);
    const r = doc.items[1];
    if (r.kind !== "resource") throw new Error("expected resource");
    expect(r.fields.map((f) => [f.name, f.type, f.optional, f.default?.kind])).toEqual([
      ["title", "string", false, undefined],
      ["body", "string", true, undefined],
      ["pinned", "boolean", false, "boolean"],
      ["priority", "number", false, "number"],
      ["due", "Date", true, undefined],
    ]);
    expect(r.source).toBe("db.notes");
    expect(r.routes).toBe("/notes");
    const text = print(doc);
    expect(print(parse(text))).toBe(text);
    expect(validate(programFromDocument(doc))).toEqual([]);
  });

  it("reports invalid resources", () => {
    expect(() => parse(`resource X { fields { a: object } source db.x routes "/x" }`)).toThrowError(/O120/);
    expect(() => parse(`resource X { fields { a: string } source db.x routes "x" }`)).toThrowError(/O007/);
    const codes = (s: string) => validate(programFromDocument(parse(s))).map((d) => d.code);
    expect(codes(`resource X { fields { a: string } source db.x }`)).toEqual(["O120"]);
    expect(codes(`resource X { fields { a: string \n a: number } source db.x routes "/x" }`)).toEqual(["O121"]);
    expect(codes(`resource X { fields { id: string } source db.x routes "/x" }`)).toEqual(["O120"]);
    expect(codes(`resource X { fields { a: string } source db.x routes "/x" }  resource X { fields { a: string } source db.x routes "/y" }`)).toEqual(["O121"]);
  });

  it("emits a resource module with a coercing parser", () => {
    const r = emit(programFromDocument(parse(SRC)));
    const mod = r.files["_orchidery/resources/Note.ts"]!;
    expect(mod).toContain("export interface Note {");
    expect(mod).toContain("body?: string;");
    expect(mod).toContain("due?: Date;");
    expect(mod).toContain("export function parseNote(form: FormData): NoteInput");
    expect(mod).toContain('throw new Error("title is required")');
    expect(mod).toContain("out.pinned = v === undefined ? false :");
    expect(mod).toContain("out.priority = 1;");
    expect(mod).toContain("out.due = undefined;");
  });

  it("grows list and detail pages that parse, validate and compile", () => {
    const doc = parse(SRC, { file: "orchid/note.orchid" });
    const res = doc.items[1];
    if (res.kind !== "resource") throw new Error();
    expect(grownRoutes(res)).toEqual(["/notes", "/notes/[id]"]);
    const grown = growResource(res, { out: "app", imports: doc.items.filter((i) => i.kind === "import") });
    expect(grown).toContain('import { db } from "@/lib/db"');
    expect(grown).toContain('import { parseNote } from "@/app/_orchidery/resources/Note"');
    expect(grown).toContain('page "/notes" {');
    expect(grown).toContain('page "/notes/[id]" {');
    expect(grown).toContain('Input(name: "pinned", type: "checkbox", label: "Pinned", defaultChecked: note.pinned)');
    expect(grown).toContain('Input(name: "due", type: "date", placeholder: "Due", defaultValue: note.due?.toISOString().slice(0, 10))');
    expect(grown).toContain("await db.notes.create(parseNote(form))");
    expect(grown).toContain('redirect "/notes"');
    const program = programFromSources([{ file: "orchid/note.orchid", text: SRC }, { file: "orchid/notes-pages.orchid", text: grown }]);
    expect(validate(program)).toEqual([]);
    const out = emit(program, { dev: true });
    expect(out.diagnostics).toEqual([]);
    expect(Object.keys(out.files)).toEqual(expect.arrayContaining(["notes/page.tsx", "notes/actions.ts", "notes/[id]/page.tsx", "notes/[id]/actions.ts", "notes/[id]/_islands/Island_remove.tsx"]));
    expect(out.files["notes/[id]/page.tsx"]).toContain("<Form action={update.bind(null, note.id)}");
  });
});

describe("binding shadowing", () => {
  it("flags a load binding that shadows the import it reads (O122) and grow avoids it", () => {
    const codes = validate(programFromDocument(parse(`import { notes } from "@/lib/db"\npage "/" { load { notes: await notes.list() } ui { Text { "x" } } }`))).map((d) => d.code);
    expect(codes).toEqual(["O122"]);
    const doc = parse(`import { notes } from "@/lib/db"\nresource Note { fields { title: string } source notes routes "/notes" }`);
    const res = doc.items[1];
    if (res.kind !== "resource") throw new Error();
    const grown = growResource(res, { imports: doc.items.filter((i) => i.kind === "import") });
    expect(grown).toContain("noteList: await notes.list()");
    expect(validate(programFromSources([{ file: "a.orchid", text: grown }]))).toEqual([]);
  });
});
