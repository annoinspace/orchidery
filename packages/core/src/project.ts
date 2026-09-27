import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Diagnostic } from "./diagnostics.js";
import { OrchidError } from "./diagnostics.js";
import { emit, type EmitOptions, type MapEntry } from "./emit/index.js";
import { parse } from "./parser.js";
import type { Program } from "./program.js";

/** Contents of orchidery.config.json, with defaults applied. */
export interface ProjectConfig {
  /** Directory of .orchid files, relative to the project root. */
  src: string;
  /** Next.js app directory the compiler writes into, relative to the root. */
  out: string;
  devtoolsPort: number;
  /** Where the browser loads the overlay from. Defaults to http://localhost:<devtoolsPort>. */
  devtoolsUrl?: string;
  /** Base URL of the Next.js dev server, used by preview and scenarios. `orchidery dev` sets it from its port. */
  appUrl?: string;
  /**
   * When to stamp elements with data-orchid. `dev` (default) stamps development
   * builds only. `always` keeps stamps in production and publishes the address
   * map at public/.orchidery/map.json so operating agents can resolve addresses.
   */
  stamps: "dev" | "always";
}

export const DEFAULT_CONFIG: ProjectConfig = { src: "orchid", out: "app", devtoolsPort: 4747, stamps: "dev" };

export function loadConfig(root: string): ProjectConfig {
  const p = join(root, "orchidery.config.json");
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<ProjectConfig>) };
}

export interface SourceFile {
  /** Path relative to the project root, posix separators. */
  file: string;
  text: string;
}

export function readSources(root: string, src: string): SourceFile[] {
  const base = join(root, src);
  const out: SourceFile[] = [];
  if (!existsSync(base)) return out;
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".orchid")) out.push({ file: relative(root, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  visit(base);
  return out;
}

export interface LoadedProgram {
  program: Program;
  /** Parse errors, one per file that failed. Files that failed are absent from the program. */
  diagnostics: Diagnostic[];
}

export function loadProgram(sources: SourceFile[]): LoadedProgram {
  const program: Program = { documents: [] };
  const diagnostics: Diagnostic[] = [];
  for (const s of sources) {
    try {
      program.documents.push(parse(s.text, { file: s.file }));
    } catch (e) {
      if (e instanceof OrchidError) diagnostics.push(e.diagnostic);
      else throw e;
    }
  }
  return { program, diagnostics };
}

export interface CompileResult {
  /** Paths written, relative to the project root. */
  written: string[];
  /** Paths removed because a previous build produced them and this one did not. */
  removed: string[];
  diagnostics: Diagnostic[];
  map: Record<string, MapEntry>;
}

/**
 * Compile the project's .orchid files into its Next.js app directory.
 * Only changed files are written, so Next's watcher is not woken needlessly.
 * A manifest under .orchidery/ tracks generated files so stale ones are removed.
 */
export function compileProject(root: string, config: ProjectConfig, opts: EmitOptions = {}): CompileResult {
  const { program, diagnostics } = loadProgram(readSources(root, config.src));
  const result: CompileResult = { written: [], removed: [], diagnostics, map: {} };
  if (diagnostics.length) return result;

  const emitted = emit(program, { devtoolsUrl: config.devtoolsUrl, stamps: config.stamps === "always", ...opts });
  result.diagnostics = emitted.diagnostics;
  result.map = emitted.map;
  if (emitted.diagnostics.some((d) => d.severity === "error")) return result;

  const gen = join(root, ".orchidery");
  mkdirSync(gen, { recursive: true });
  const manifestPath = join(gen, "generated.json");
  const previous: string[] = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as string[]) : [];

  const current: string[] = [];
  for (const [rel, content] of Object.entries(emitted.files)) {
    const outRel = join(config.out, rel).split("\\").join("/");
    current.push(outRel);
    const abs = join(root, outRel);
    if (existsSync(abs) && readFileSync(abs, "utf8") === content) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    result.written.push(outRel);
  }
  for (const stale of previous) {
    if (current.includes(stale)) continue;
    const abs = join(root, stale);
    if (existsSync(abs)) {
      rmSync(abs);
      result.removed.push(stale);
      pruneEmptyDirs(dirname(abs), join(root, config.out));
    }
  }
  writeFileSync(manifestPath, JSON.stringify(current, null, 2));
  writeFileSync(join(gen, "map.json"), JSON.stringify(emitted.map, null, 2));
  // With stamps: "always", operating agents resolve addresses on the live site from the public map.
  const publicMap = join(root, "public", ".orchidery", "map.json");
  if (config.stamps === "always") {
    mkdirSync(dirname(publicMap), { recursive: true });
    writeFileSync(publicMap, JSON.stringify(emitted.map));
  } else if (existsSync(publicMap)) {
    rmSync(publicMap);
  }
  return result;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  while (dir.startsWith(stopAt) && dir !== stopAt && existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true });
    dir = dirname(dir);
  }
}
