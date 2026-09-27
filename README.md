# Orchidery

**An agent-first UI format that grows on Next.js.**

Orchidery is a small, constrained source format (`.orchid` files) plus the tooling that
lets a coding agent and a human build a Next.js app together. The human points at the
running UI and leaves a note. The agent changes the source with structural patches.
The page reloads. Repeat.

An orchidery is where orchids are grown. Orchids are epiphytes: they grow on another
plant without harming it. Orchidery grows on Next.js the same way. It compiles to
ordinary App Router files, so the runtime, the ecosystem and the deploy are unchanged.

## Why

Next.js is hard for agents. Routing lives in magic filenames. The server/client boundary
is implicit until it breaks at runtime. There are several blessed ways to load data.
Build errors are walls of text. Every Figma-to-code pass reinvents layout, styling and
token mapping.

Orchidery fixes the parts that make the agent loop unreliable:

- **One file per route.** Route, data loading, actions and UI tree live together.
- **Stable addresses.** Every rendered element traces back to a source node such as
  `page:/todos/[id] > Card[0] > #done`. What you circle and what the agent edits are the
  same object.
- **Grafts, not rewrites.** Agents apply structural patch operations that are validated
  and applied atomically. No half-broken files.
- **Semantic props and tokens.** "Make it bigger" is a token change, not a pixel fiddle.
- **Structured diagnostics.** Every error has a code, a range and, where possible, a fix.
- **Edit mode.** In development the app gets an overlay: click a node or draw around a
  region, leave a note, and it lands in a queue any MCP client can work through.

## The loop

1. `orchidery dev` starts the compiler, `next dev` and the devtools server.
2. Press the edit-mode toggle. Click or draw around part of the page. Type a note.
3. Point Claude Code (or any MCP client) at `@orchidery/mcp` and say
   "tend the annotations".
4. The agent reads each annotation with its screenshot and source, grafts the change,
   marks it done. The page reloads.

## A page

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

That compiles to `app/todos/[id]/page.tsx`, `app/todos/[id]/actions.ts` and a client
island for the button. The server/client boundary is inferred: anything with an event
handler becomes an island.

## Vocabulary

- **graft**: apply a structural patch to a node
- **prune**: remove a node
- **tend**: work through the annotation queue
- **grove**: a group of routes sharing a layout

## Packages

| Package | What |
| --- | --- |
| `@orchidery/core` | Parser, printer, addresses, validator, graft engine, Next.js emitter |
| `@orchidery/runtime` | The built-in primitives (`Box`, `Stack`, `Text`, ...) and token helpers |
| `@orchidery/devtools` | The devtools server and the edit-mode overlay |
| `orchidery` | The CLI: `dev`, `check`, `build`, `format`, `init`, `tend` |
| `@orchidery/mcp` | The MCP server agents use to validate, compile, graft and tend |

## Prior art

Onlook edits plain Next.js apps visually and writes back React. The Vercel toolbar lets
you comment on previews. `espalier` on npm calls itself an architecture compiler for
agent-driven development. Orchidery's difference is the constrained source: stable
addresses, structured grafts and tokens make an agent's changes predictable and
reviewable rather than best-effort.

## Status

Early. See `docs/language.md` for the grammar, `docs/diagnostics.md` for every error
code, and `docs/agent-guide.md` for how an agent should work an annotation.
