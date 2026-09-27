# Orchidery

**An agent-first UI format that grows on Next.js.**

You point at the running app and leave a note. An agent changes the source. The page
reloads. Orchidery is the small, constrained format and the tooling that makes that loop
reliable.

```orchid
import { db } from "@/lib/db"

page "/todos/[id]" {
  load {
    todo: await db.todo.find(params.id)
  }

  action toggle(id: string) {
    await db.todo.toggle(id)
    revalidate "/todos"
  }

  ui {
    Card(title: todo.title) {
      Text { todo.description }
      Button#done(onClick: toggle(todo.id), variant: "primary") { "Mark done" }
    }
  }
}
```

That compiles to `app/todos/[id]/page.tsx`, a `"use server"` actions module and a client
island for the button. Ordinary Next.js App Router files, deployable anywhere Next runs.

## Why

Next.js is hard for agents. Routing hides in magic filenames, the server/client boundary is
implicit until it breaks, data loading has several blessed shapes, and build errors are
walls of text. Orchidery gives an agent what it needs to be reliable instead of lucky:

- **One file per route.** Route, data, actions and UI together.
- **Stable addresses.** Every rendered element traces back to a node like
  `page:/todos/[id] > #done`. What you circle and what the agent edits are the same thing.
- **Grafts, not rewrites.** Edits are structural ops, validated and applied atomically.
- **Semantic props and tokens.** "Make it bigger" is a token change, not a pixel fiddle.
- **Coded diagnostics with fixes.** `O104 Unknown prop \`colour\` on Text. Did you mean \`color\`?`
- **Edit mode.** In dev, click a node or draw around a region, type a note. It lands in a
  queue any MCP client can work.
- **The agent can look.** `orchid_preview` returns a screenshot, the box of every addressable
  node, console errors and an axe-core accessibility report. `scenario` blocks are tests
  written with addresses, runnable by the agent after every change.

## Try it

```sh
git clone https://github.com/annoinspace/orchidery && cd orchidery
pnpm install && pnpm build
cd examples/todo && pnpm dev
```

Open http://localhost:3000, press **Alt+Shift+E**, draw a box around something and leave a
note. Then connect an agent:

```sh
claude mcp add orchidery -- npx orchidery mcp
```

and ask it to *tend the Orchidery annotations*. It reads each note with its screenshot and
source, grafts the change, marks it done. The page reloads. `orchidery tend` shows the queue
from the terminal.

## Add to an existing Next.js app

```sh
pnpm add orchidery @orchidery/runtime
npx orchidery init      # creates orchid/home.orchid and orchidery.config.json
npx orchidery dev       # compiler in watch mode + next dev + devtools
```

`orchidery build` runs before `next build` in CI. Generated files live in `app/` and are
safe to gitignore or commit, your choice.

## CLI

| Command | What |
| --- | --- |
| `orchidery dev` | Watch `.orchid` files, run `next dev` and the devtools server |
| `orchidery build [--dev]` | Compile to the app directory |
| `orchidery check` | Parse and validate, print diagnostics |
| `orchidery format` | Rewrite sources in canonical form |
| `orchidery tend` | List open annotations |
| `orchidery scenario [name]` | Run scenarios against the dev server |
| `orchidery preview <route>` | Screenshot a route and report accessibility issues |
| `orchidery mcp` | Run the MCP server over stdio |
| `orchidery init` | Scaffold a project |

## Packages

| Package | What |
| --- | --- |
| `orchidery` | The CLI |
| `@orchidery/core` | Parser, printer, addresses, validator, graft engine, Next.js emitter |
| `@orchidery/runtime` | Primitives (`Box`, `Stack`, `Text`, `Button`, ...) and token helpers |
| `@orchidery/devtools` | Devtools server, annotation store, edit-mode overlay |
| `@orchidery/mcp` | MCP server: `orchid_project`, `orchid_get_node`, `orchid_graft`, `orchid_annotations`, ... |

## Docs

- [The language](docs/language.md): grammar, props, addresses, what gets emitted
- [Diagnostics](docs/diagnostics.md): every code and its fix
- [Agent guide](docs/agent-guide.md): how an agent should tend annotations

## Name

An orchidery is where orchids are grown. Orchids are epiphytes: they grow on another plant
without harming it. Orchidery grows on Next.js the same way.

## Prior art

[Onlook](https://onlook.com) edits plain Next.js apps visually and writes back React. The
Vercel toolbar lets you comment on previews. Orchidery's difference is the constrained
source: stable addresses, structured grafts and tokens make an agent's changes predictable
and reviewable.

## Status

Early and moving. Deferred to later: accept/revert in the overlay, Figma frame attachment,
client `state` blocks, an LSP.

MIT.
