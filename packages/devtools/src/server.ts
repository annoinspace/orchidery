import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@orchidery/core";
import { BrowserPool } from "./browser.js";
import { preview, type PreviewRequest } from "./preview.js";
import { describe as describeStep, loadScenarios, runScenario } from "./scenario.js";
import { Store } from "./store.js";
import type { AnnotationStatus, NewAnnotation } from "./types.js";

export interface DevtoolsOptions {
  root: string;
  srcDir?: string;
  port?: number;
  /** Path to the built overlay bundle. Defaults to the one shipped with this package. */
  overlayPath?: string;
  /** Base URL of the Next.js dev server, for preview and scenarios. */
  appUrl?: string;
  log?: (msg: string) => void;
}

/** The bundle lives in dist/, whether this module runs from dist/ or src/. */
function defaultOverlayPath(): string {
  const candidates = [new URL("./overlay.js", import.meta.url), new URL("../dist/overlay.js", import.meta.url)].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * The devtools server the overlay talks to. Plain node:http, no framework.
 * Everything is CORS-open because the overlay runs on the Next.js origin.
 */
export function createDevtoolsServer(opts: DevtoolsOptions): { server: Server; store: Store; pool: BrowserPool; listen: () => Promise<number>; close: () => Promise<void> } {
  const store = new Store(opts.root, opts.srcDir);
  const overlayPath = opts.overlayPath ?? defaultOverlayPath();
  const log = opts.log ?? (() => {});
  const pool = new BrowserPool();
  const config = () => loadConfig(opts.root);
  const appUrl = () => opts.appUrl ?? config().appUrl ?? "http://localhost:3000";
  const browserDeps = () => ({ pool, store, root: opts.root, config: config(), appUrl: appUrl() });

  const server = createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return end(res, 204);
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/overlay.js") {
        if (!existsSync(overlayPath)) return text(res, 404, "overlay bundle not built");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(overlayPath));
      }
      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, appUrl: appUrl() });
      if (req.method === "GET" && path === "/map") return json(res, 200, store.readMap());

      if (req.method === "POST" && path === "/preview") {
        const body = ((await readJson(req)) ?? {}) as PreviewRequest;
        const result = await preview(body, browserDeps());
        log(`preview ${result.url} (${Object.keys(result.boxes).length} boxes, ${result.a11y?.violations.length ?? 0} a11y issues)`);
        return json(res, 200, result);
      }
      if (req.method === "GET" && path === "/history") {
        return json(res, 200, store.history({ address: url.searchParams.get("address") ?? undefined, annotation: url.searchParams.get("annotation") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 50) }));
      }
      if (req.method === "GET" && path === "/pending") return json(res, 200, store.listPending());
      const pm = /^\/pending\/([a-z0-9]+)\/(accept|reject)$/.exec(path);
      if (pm && req.method === "POST") {
        const id = pm[1]!;
        if (pm[2] === "reject") return store.reject(id) ? end(res, 204) : json(res, 404, { error: "not found" });
        const r = store.accept(id, "human");
        if (!r.ok) return json(res, 409, { error: r.reason });
        log(`accepted graft ${id} on ${r.entry.file}`);
        return json(res, 200, r.entry);
      }
      if (req.method === "GET" && path === "/scenarios") {
        return json(res, 200, loadScenarios(opts.root, config()).map((s) => ({ name: s.name, steps: s.steps.map(describeStep) })));
      }
      if (req.method === "POST" && path === "/scenarios/run") {
        const body = ((await readJson(req)) ?? {}) as { name?: string; timeout?: number };
        const scenarios = loadScenarios(opts.root, config(), body.name);
        const results = [];
        for (const s of scenarios) {
          const r = await runScenario(s, { ...browserDeps(), timeout: body.timeout });
          log(`scenario "${r.name}" ${r.ok ? "passed" : "FAILED"} in ${r.ms}ms`);
          results.push(r);
        }
        return json(res, 200, results);
      }

      if (req.method === "GET" && path === "/annotations") {
        const status = url.searchParams.get("status") as AnnotationStatus | null;
        return json(res, 200, store.list(status ?? undefined));
      }
      if (req.method === "POST" && path === "/annotations") {
        const body = (await readJson(req)) as NewAnnotation;
        if (!body || typeof body.note !== "string" || !Array.isArray(body.targets)) return json(res, 400, { error: "note and targets are required" });
        const a = store.create(body);
        log(`annotation ${a.id}: ${a.targets.join(", ")} — ${a.note}`);
        return json(res, 201, a);
      }
      const m = /^\/annotations\/([a-z0-9]+)(\/screenshot\.png|\/diff)?$/.exec(path);
      if (m) {
        const id = m[1]!;
        if (req.method === "GET" && m[2] === "/screenshot.png") {
          const p = store.screenshotPath(id);
          if (!p) return text(res, 404, "no screenshot");
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(readFileSync(p));
        }
        if (req.method === "GET" && m[2] === "/diff") return text(res, 200, store.diff(id));
        if (req.method === "GET") {
          const a = store.get(id);
          return a ? json(res, 200, a) : json(res, 404, { error: "not found" });
        }
        if (req.method === "PATCH") {
          const body = (await readJson(req)) as { status?: AnnotationStatus; summary?: string; note?: string };
          const a = store.update(id, body);
          return a ? json(res, 200, a) : json(res, 404, { error: "not found" });
        }
        if (req.method === "DELETE") return store.remove(id) ? end(res, 204) : json(res, 404, { error: "not found" });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  const listen = () =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 4747, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : (opts.port ?? 4747));
      });
    });

  const close = async () => {
    await pool.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, store, pool, listen, close };
}

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}
function end(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
