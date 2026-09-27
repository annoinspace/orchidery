import { createTwoFilesPatch } from "diff";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AddressMap, Annotation, AnnotationStatus, NewAnnotation } from "./types.js";

/**
 * File-backed annotation queue under `<root>/.orchidery/`. Both the devtools
 * server and the MCP server read and write it, so an agent can tend
 * annotations whether or not the dev server is running.
 */
export class Store {
  readonly dir: string;
  readonly annotationsDir: string;

  constructor(public root: string, public srcDir = "orchid") {
    this.dir = join(root, ".orchidery");
    this.annotationsDir = join(this.dir, "annotations");
    mkdirSync(this.annotationsDir, { recursive: true });
  }

  // -- address map -------------------------------------------------------

  readMap(): AddressMap {
    const p = join(this.dir, "map.json");
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8")) as AddressMap;
    } catch {
      return {};
    }
  }

  writeMap(map: AddressMap): void {
    writeFileSync(join(this.dir, "map.json"), JSON.stringify(map, null, 2));
  }

  // -- sources -----------------------------------------------------------

  /** All .orchid files under the source dir, keyed by path relative to root. */
  readSources(): Record<string, string> {
    const out: Record<string, string> = {};
    const base = join(this.root, this.srcDir);
    if (!existsSync(base)) return out;
    const visit = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) visit(p);
        else if (e.name.endsWith(".orchid")) out[relative(this.root, p)] = readFileSync(p, "utf8");
      }
    };
    visit(base);
    return out;
  }

  // -- annotations -------------------------------------------------------

  list(status?: AnnotationStatus): Annotation[] {
    const out: Annotation[] = [];
    for (const f of readdirSync(this.annotationsDir)) {
      if (!f.endsWith(".json") || f.endsWith(".before.json")) continue;
      try {
        const a = JSON.parse(readFileSync(join(this.annotationsDir, f), "utf8")) as Annotation;
        if (!status || a.status === status) out.push(a);
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Annotation | undefined {
    const p = join(this.annotationsDir, `${safe(id)}.json`);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as Annotation;
  }

  create(input: NewAnnotation): Annotation {
    const id = newId();
    const now = new Date().toISOString();
    const a: Annotation = {
      id,
      createdAt: now,
      updatedAt: now,
      url: input.url,
      targets: input.targets,
      commonAncestor: input.commonAncestor,
      region: input.region,
      note: input.note,
      status: "pending",
      viewport: input.viewport,
    };
    if (input.screenshot?.startsWith("data:image/png;base64,")) {
      const png = Buffer.from(input.screenshot.slice("data:image/png;base64,".length), "base64");
      writeFileSync(join(this.annotationsDir, `${id}.png`), png);
      a.screenshot = `.orchidery/annotations/${id}.png`;
    }
    // Snapshot the sources so a diff can be shown once the agent has worked.
    writeFileSync(join(this.annotationsDir, `${id}.before.json`), JSON.stringify(this.readSources()));
    this.write(a);
    return a;
  }

  update(id: string, patch: { status?: AnnotationStatus; summary?: string; note?: string }): Annotation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (patch.status) a.status = patch.status;
    if (patch.summary !== undefined) a.summary = patch.summary;
    if (patch.note !== undefined) a.note = patch.note;
    a.updatedAt = new Date().toISOString();
    this.write(a);
    return a;
  }

  remove(id: string): boolean {
    const base = join(this.annotationsDir, safe(id));
    if (!existsSync(`${base}.json`)) return false;
    for (const ext of [".json", ".png", ".before.json"]) rmSync(`${base}${ext}`, { force: true });
    return true;
  }

  screenshotPath(id: string): string | undefined {
    const p = join(this.annotationsDir, `${safe(id)}.png`);
    return existsSync(p) ? p : undefined;
  }

  /** Unified diff of the sources since the annotation was created. */
  diff(id: string): string {
    const p = join(this.annotationsDir, `${safe(id)}.before.json`);
    const before: Record<string, string> = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
    const after = this.readSources();
    const files = new Set([...Object.keys(before), ...Object.keys(after)]);
    let out = "";
    for (const f of [...files].sort()) {
      const a = before[f] ?? "";
      const b = after[f] ?? "";
      if (a === b) continue;
      out += createTwoFilesPatch(f, f, a, b, "before", "after") + "\n";
    }
    return out;
  }

  private write(a: Annotation): void {
    writeFileSync(join(this.annotationsDir, `${a.id}.json`), JSON.stringify(a, null, 2));
  }
}

function safe(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`Invalid annotation id: ${id}`);
  return id;
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
