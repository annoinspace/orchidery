import { createTwoFilesPatch } from "diff";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AddressMap, Annotation, AnnotationStatus, GraftLogEntry, NewAnnotation, PendingGraft } from "./types.js";

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

  // -- graft log ---------------------------------------------------------

  get logPath(): string {
    return join(this.dir, "grafts.jsonl");
  }

  appendGraft(entry: Omit<GraftLogEntry, "id" | "at">): GraftLogEntry {
    const full: GraftLogEntry = { id: newId(), at: new Date().toISOString(), ...entry };
    appendFileSync(this.logPath, JSON.stringify(full) + "\n");
    return full;
  }

  history(filter: { address?: string; annotation?: string; agent?: string; since?: string; limit?: number } = {}): GraftLogEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, "utf8").split("\n").filter(Boolean);
    let out: GraftLogEntry[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as GraftLogEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    if (filter.since) out = out.filter((e) => e.at >= filter.since!);
    if (filter.agent) out = out.filter((e) => e.agent === filter.agent);
    if (filter.annotation) out = out.filter((e) => e.annotation === filter.annotation);
    if (filter.address) {
      const a = filter.address.split(">").map((s) => s.trim()).join(" > ");
      out = out.filter((e) => e.touched.some((t: string) => t === a || t.startsWith(a + " > ") || a.startsWith(t + " > ")));
    }
    out.reverse();
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  /** Distinct addresses already touched for an annotation, for the nodes-per-annotation budget. */
  touchedFor(annotation: string): string[] {
    return [...new Set(this.history({ annotation }).flatMap((e) => e.touched))];
  }

  // -- review gate -------------------------------------------------------

  get pendingDir(): string {
    const p = join(this.dir, "pending");
    mkdirSync(p, { recursive: true });
    return p;
  }

  /** Hold a graft for review instead of writing it. */
  hold(p: Omit<PendingGraft, "id" | "createdAt" | "diff">): PendingGraft {
    const current = this.readFile(p.file);
    const diff = createTwoFilesPatch(p.file, p.file, current, p.text, "current", "proposed");
    const full: PendingGraft = { id: newId(), createdAt: new Date().toISOString(), diff, ...p };
    writeFileSync(join(this.pendingDir, `${full.id}.json`), JSON.stringify(full, null, 2));
    return full;
  }

  listPending(): PendingGraft[] {
    return readdirSync(this.pendingDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.pendingDir, f), "utf8")) as PendingGraft)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getPending(id: string): PendingGraft | undefined {
    const p = join(this.pendingDir, `${safe(id)}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PendingGraft) : undefined;
  }

  /**
   * Write a held graft to its file and log it. Fails when the file changed
   * since the graft was computed, so a stale proposal never clobbers newer work.
   */
  accept(id: string, by = "human"): { ok: true; entry: GraftLogEntry } | { ok: false; reason: string } {
    const p = this.getPending(id);
    if (!p) return { ok: false, reason: `No pending graft ${id}` };
    const current = this.readFile(p.file);
    if (sha(current) !== p.before) return { ok: false, reason: `${p.file} changed since this graft was proposed; ask the agent to redo it` };
    writeFileSync(join(this.root, p.file), p.text);
    const entry = this.appendGraft({ agent: `${p.agent} (accepted by ${by})`, file: p.file, ops: p.ops, touched: p.touched, annotation: p.annotation, before: p.before, after: sha(p.text), pending: id });
    rmSync(join(this.pendingDir, `${id}.json`), { force: true });
    return { ok: true, entry };
  }

  reject(id: string): boolean {
    const f = join(this.pendingDir, `${safe(id)}.json`);
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }

  readFile(rel: string): string {
    const abs = join(this.root, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : "";
  }
}

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function safe(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`Invalid annotation id: ${id}`);
  return id;
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
