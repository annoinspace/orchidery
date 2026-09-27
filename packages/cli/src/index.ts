import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  compileProject,
  formatDiagnostic,
  loadConfig,
  loadProgram,
  print,
  readSources,
  validate,
  type Diagnostic,
} from "@orchidery/core";
import { BrowserPool, createDevtoolsServer, loadScenarios, preview, runScenario, Store } from "@orchidery/devtools";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  purple: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const tag = c.purple("orchidery");

function report(diagnostics: Diagnostic[]): boolean {
  for (const d of diagnostics) console.error((d.severity === "error" ? c.red : c.dim)(formatDiagnostic(d)));
  return diagnostics.some((d) => d.severity === "error");
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command("orchidery").description("An agent-first UI format that grows on Next.js").version("0.1.0");
  program.option("-C, --cwd <dir>", "project root", process.cwd());
  const root = () => resolve(program.opts<{ cwd: string }>().cwd);

  program
    .command("build")
    .description("compile .orchid files into the Next.js app directory")
    .option("--dev", "stamp elements with source addresses and write the address map")
    .action((o: { dev?: boolean }) => {
      const r = compileProject(root(), loadConfig(root()), { dev: !!o.dev });
      if (report(r.diagnostics)) process.exit(1);
      console.log(`${tag} wrote ${r.written.length} file(s)${r.removed.length ? `, removed ${r.removed.length}` : ""}`);
    });

  program
    .command("check")
    .description("parse and validate without writing anything")
    .action(() => {
      const { program: p, diagnostics } = loadProgram(readSources(root(), loadConfig(root()).src));
      const all = [...diagnostics, ...(diagnostics.length ? [] : validate(p))];
      if (report(all)) process.exit(1);
      console.log(`${tag} ${c.green("ok")} ${p.documents.length} file(s)`);
    });

  program
    .command("format")
    .description("rewrite .orchid files in canonical form")
    .option("--check", "exit non-zero if any file would change")
    .action((o: { check?: boolean }) => {
      const { program: p, diagnostics } = loadProgram(readSources(root(), loadConfig(root()).src));
      if (report(diagnostics)) process.exit(1);
      let changed = 0;
      for (const doc of p.documents) {
        const text = print(doc);
        const abs = join(root(), doc.file!);
        if (readFileSync(abs, "utf8") === text) continue;
        changed++;
        if (o.check) console.log(`${c.dim("would format")} ${doc.file}`);
        else {
          writeFileSync(abs, text);
          console.log(`${c.dim("formatted")} ${doc.file}`);
        }
      }
      if (o.check && changed) process.exit(1);
      if (!changed) console.log(`${tag} already formatted`);
    });

  program
    .command("dev")
    .description("compile in watch mode, run next dev and the devtools server")
    .option("-p, --port <port>", "Next.js port", "3000")
    .action(async (o: { port: string }) => {
      const r = root();
      const config = loadConfig(r);
      const url = config.devtoolsUrl ?? `http://localhost:${config.devtoolsPort}`;
      const build = () => {
        const res = compileProject(r, { ...config, devtoolsUrl: url }, { dev: true });
        if (!report(res.diagnostics) && (res.written.length || res.removed.length)) {
          console.log(`${tag} ${c.dim(`rebuilt ${res.written.length} file(s)`)}`);
        }
      };
      build();

      const appUrl = config.appUrl ?? `http://localhost:${o.port}`;
      const devtools = createDevtoolsServer({ root: r, srcDir: config.src, port: config.devtoolsPort, appUrl, log: (m) => console.log(`${tag} ${m}`) });
      const port = await devtools.listen();
      console.log(`${tag} devtools on http://localhost:${port}  ${c.dim("(Alt+Shift+E toggles edit mode in the app)")}`);

      const srcDir = join(r, config.src);
      mkdirSync(srcDir, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      watch(srcDir, { recursive: true }, (_e, name) => {
        if (name && !String(name).endsWith(".orchid")) return;
        clearTimeout(timer);
        timer = setTimeout(build, 60);
      });

      const child = spawn(nextBin(r), ["dev", "-p", o.port], {
        cwd: r,
        stdio: "inherit",
        env: { ...process.env, NEXT_PUBLIC_ORCHIDERY_DEVTOOLS_URL: url },
      });
      const stop = () => { child.kill("SIGTERM"); void devtools.close().finally(() => process.exit(0)); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      child.on("exit", (code) => { void devtools.close().finally(() => process.exit(code ?? 0)); });
    });

  program
    .command("scenario [name]")
    .description("run scenarios against the running dev server (all of them when no name is given)")
    .option("--app <url>", "base URL of the running app (default: config appUrl or http://localhost:3000)")
    .option("--timeout <ms>", "per-step timeout", "10000")
    .action(async (name: string | undefined, o: { app?: string; timeout: string }) => {
      const r = root();
      const config = loadConfig(r);
      const appUrl = o.app ?? config.appUrl ?? "http://localhost:3000";
      const scenarios = loadScenarios(r, config, name);
      if (!scenarios.length) {
        console.log(`${tag} no scenarios. Add one to a .orchid file:\n\n  scenario "smoke" {\n    visit "/"\n    expect "page:/ > Card[0]" visible\n  }`);
        return;
      }
      const pool = new BrowserPool();
      const store = new Store(r, config.src);
      let failed = 0;
      try {
        for (const s of scenarios) {
          const res = await runScenario(s, { pool, store, root: r, config, appUrl, timeout: Number(o.timeout) });
          console.log(`${res.ok ? c.green("pass") : c.red("FAIL")} ${c.bold(res.name)} ${c.dim(`${res.ms}ms`)}`);
          for (const st of res.steps) {
            console.log(`  ${st.ok ? c.dim("✓") : c.red("✗")} ${st.step}${st.error ? `\n      ${c.red(st.error)}` : ""}${st.screenshot && !st.ok ? `\n      ${c.dim(st.screenshot)}` : ""}`);
          }
          if (!res.ok) failed++;
        }
      } finally {
        await pool.close();
      }
      if (failed) process.exit(1);
    });

  program
    .command("preview <route>")
    .description("screenshot a route of the running dev server and report accessibility issues")
    .option("--app <url>", "base URL of the running app")
    .option("-o, --out <file>", "where to write the PNG", ".orchidery/preview.png")
    .option("--full", "capture the whole page, not just the viewport")
    .action(async (route: string, o: { app?: string; out: string; full?: boolean }) => {
      const r = root();
      const config = loadConfig(r);
      const appUrl = o.app ?? config.appUrl ?? "http://localhost:3000";
      const pool = new BrowserPool();
      try {
        const res = await preview({ route, fullPage: !!o.full }, { pool, store: new Store(r, config.src), root: r, config, appUrl });
        const out = resolve(r, o.out);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, Buffer.from(res.screenshot, "base64"));
        console.log(`${tag} ${res.title || res.url} → ${out}`);
        console.log(`  ${Object.keys(res.boxes).length} addressable node(s)`);
        for (const e of res.errors) console.log(`  ${c.red("console")} ${e}`);
        for (const v of res.a11y?.violations ?? []) {
          console.log(`  ${c.red(v.impact)} ${v.id}: ${v.help}`);
          for (const n of v.nodes) console.log(`      ${c.dim("→")} ${n.address ?? n.target.join(" ")}`);
        }
        if (!res.a11y?.violations.length) console.log(`  ${c.green("no accessibility violations")}`);
      } finally {
        await pool.close();
      }
    });

  program
    .command("tend")
    .description("list open annotations left in edit mode")
    .option("--all", "include done and rejected")
    .action((o: { all?: boolean }) => {
      const config = loadConfig(root());
      const store = new Store(root(), config.src);
      const list = store.list().filter((a) => o.all || (a.status !== "done" && a.status !== "rejected"));
      if (!list.length) {
        console.log(`${tag} no open annotations. Run ${c.bold("orchidery dev")}, press Alt+Shift+E in the app, and leave one.`);
        return;
      }
      for (const a of list) {
        console.log(`${c.bold(a.id)} ${c.dim(a.status)} ${a.url}`);
        console.log(`  ${a.note}`);
        for (const t of a.targets) console.log(`  ${c.dim("→")} ${t}`);
        if (a.screenshot) console.log(`  ${c.dim(a.screenshot)}`);
        if (a.summary) console.log(`  ${c.green(a.summary)}`);
      }
      console.log(c.dim(`\nAn MCP client can work these: claude mcp add orchidery -- npx orchidery mcp`));
    });

  program
    .command("log")
    .description("show the graft log: who changed which nodes, when")
    .option("--address <address>", "only grafts touching this address or its subtree")
    .option("--annotation <id>", "only grafts for this annotation")
    .option("-n, --limit <n>", "how many entries", "30")
    .action((o: { address?: string; annotation?: string; limit: string }) => {
      const config = loadConfig(root());
      const entries = new Store(root(), config.src).history({ address: o.address, annotation: o.annotation, limit: Number(o.limit) });
      if (!entries.length) {
        console.log(`${tag} no grafts logged yet`);
        return;
      }
      for (const e of entries) {
        console.log(`${c.dim(e.at)} ${c.bold(e.agent)} ${e.file}${e.annotation ? c.dim(`  annotation ${e.annotation}`) : ""}`);
        console.log(`  ${(e.ops as { op: string }[]).map((op) => op.op).join(", ")}`);
        for (const t of e.touched) console.log(`  ${c.dim("→")} ${t}`);
      }
    });

  program
    .command("review")
    .description("list grafts held for review; accept or reject them")
    .option("--accept <id>", "write this pending graft to its file")
    .option("--reject <id>", "discard this pending graft")
    .option("--accept-all", "accept every pending graft")
    .action((o: { accept?: string; reject?: string; acceptAll?: boolean }) => {
      const config = loadConfig(root());
      const store = new Store(root(), config.src);
      const user = process.env.USER ?? "human";
      const accept = (id: string) => {
        const r = store.accept(id, user);
        console.log(r.ok ? `${c.green("accepted")} ${id} → ${r.entry.file}` : `${c.red("refused")} ${id}: ${r.reason}`);
        if (!r.ok) process.exitCode = 1;
      };
      if (o.accept) return accept(o.accept);
      if (o.reject) return console.log(store.reject(o.reject) ? `${c.dim("rejected")} ${o.reject}` : `${c.red("no such pending graft")} ${o.reject}`);
      const pending = store.listPending();
      if (o.acceptAll) return pending.forEach((p) => accept(p.id));
      if (!pending.length) {
        console.log(`${tag} nothing pending${config.review !== "required" ? c.dim(' (set "review": "required" in orchidery.config.json to hold agent grafts)') : ""}`);
        return;
      }
      for (const p of pending) {
        console.log(`${c.bold(p.id)} ${c.dim(p.createdAt)} ${p.agent} → ${p.file}${p.annotation ? c.dim(`  annotation ${p.annotation}`) : ""}`);
        for (const t of p.touched) console.log(`  ${c.dim("→")} ${t}`);
        console.log(p.diff.split("\n").map((l) => "  " + (l.startsWith("+") ? c.green(l) : l.startsWith("-") ? c.red(l) : c.dim(l))).join("\n"));
      }
      console.log(c.dim(`\norchidery review --accept <id> | --reject <id> | --accept-all`));
    });

  program
    .command("mcp")
    .description("run the MCP server over stdio for agents")
    .action(async () => {
      const { serve } = await import("@orchidery/mcp");
      await serve({ root: root() });
    });

  program
    .command("init")
    .description("add Orchidery to a Next.js project")
    .action(() => {
      const r = root();
      const config = loadConfig(r);
      const src = join(r, config.src);
      if (!existsSync(join(r, "orchidery.config.json"))) writeFileSync(join(r, "orchidery.config.json"), JSON.stringify(config, null, 2) + "\n");
      mkdirSync(src, { recursive: true });
      const home = join(src, "home.orchid");
      if (!existsSync(home)) {
        writeFileSync(home, STARTER);
        console.log(`${tag} created ${config.src}/home.orchid`);
      }
      const gi = join(r, ".gitignore");
      const ignore = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      if (!ignore.includes(".orchidery")) writeFileSync(gi, ignore + (ignore.endsWith("\n") || !ignore ? "" : "\n") + "\n# Orchidery\n.orchidery/\n");
      console.log(`${tag} run ${c.bold("orchidery dev")} to start`);
    });

  await program.parseAsync(argv);
}

function nextBin(root: string): string {
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  return existsSync(local) ? local : "next";
}

const STARTER = `tokens {
  color.primary: "#7b3fa0"
  color.surface: "#ffffff"
  color.border: "#e5e7eb"
  space.sm: 8
  space.md: 16
  space.lg: 32
  radius.lg: 12
}

component Card(title: string, children) {
  Box(padding: space.md, radius: radius.lg, bg: color.surface, border: "1px solid var(--color-border)") {
    Heading(level: 2) { title }
    children
  }
}

layout "/" {
  meta {
    title: "Orchidery app"
  }
  ui {
    Stack(gap: space.lg, padding: space.lg, maxWidth: 720, margin: "0 auto") {
      children
    }
  }
}

page "/" {
  ui {
    Card(title: "Hello from Orchidery") {
      Text { "Press Alt+Shift+E, click or draw around anything, and leave a note." }
    }
  }
}
`;
