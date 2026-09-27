# The Orchidery language

Orchidery source lives in `.orchid` files. The format is **structural, not expressive**:
it owns routes, blocks, the UI tree, props, tokens and actions. Anything that is an
expression (`await db.todo.find(params.id)`, `todo.title`) is TypeScript passed through
verbatim and type-checked by `tsc` on the emitted output.

## A file

```orchid
import { db } from "@/lib/db"

tokens {
  color.primary: "#7b3fa0"
  space.md: 16
}

component Card(title: string, children) {
  Box(padding: space.md, radius: 12) {
    Heading(level: 2) { title }
    children
  }
}

layout "/" {
  ui {
    Stack(gap: space.md) { children }
  }
}

page "/todos/[id]" {
  meta { title: "Todo" }

  load {
    todo: await db.todo.find(params.id)
  }

  action toggle(id: string) {
    await db.todo.toggle(id)
    revalidate "/todos"
  }

  ui {
    Card(title: todo.title) {
      Button#done(onClick: toggle(todo.id), variant: "primary") { "Mark done" }
    }
  }
}
```

## Top-level declarations

| Form | Meaning |
| --- | --- |
| `import { a, b } from "x"` / `import d from "x"` | Names available to expressions. Paths are passed through unchanged, so use aliases like `@/lib/db` rather than relative paths. |
| `tokens { path: value }` | Design tokens. Paths are dotted (`color.primary`). Values are strings or numbers. Numbers become `px` except in namespaces like `weight`, `z`, `opacity`. |
| `component Name(params) { ui }` | A reusable component. `children` as a param makes it accept children. Untyped params are `any`. |
| `layout "/route" { load? meta? ui }` | A Next.js layout. The root layout (`"/"`) is wrapped in `<html><body>` for you. Must render `children`. |
| `page "/route" { load? action* meta? ui }` | A Next.js page. Routes use Next segment syntax: `/todos/[id]`, `/docs/[...slug]`. |
| `island Name(params) { state? ui }` | A client component with local state. The only way to get client state. See Islands below. |
| `scenario "name" { steps }` | A test in the addressing vocabulary. See Scenarios below. Ignored by the compiler. |

### Inside a page

- `load { name: expr }` runs on the server before render. Bindings run in order and may
  reference earlier ones. `params` and `searchParams` are in scope. Bindings are in scope
  in `ui`.
- `action name(params) { statements }` becomes a server action. Statements are raw
  TypeScript lines plus two keywords: `revalidate "/path"` and `redirect "/path"`.
- `meta { title: "..." }` becomes `export const metadata`.
- `ui { ... }` is the tree.

## The UI tree

Each line inside `ui { }` is one of:

| Item | Example | Notes |
| --- | --- | --- |
| Element | `Button#done(variant: "primary") { "Save" }` | Capitalised name, optional `#id`, optional `(props)`, optional `{ children }`. |
| Text | `"Hello"` | A string literal. |
| Expression | `todo.title` | Any other line is TypeScript rendered as `{expr}`. |
| Slot | `children` | Where a component's or layout's children go. |
| Conditional | `if todo.done { ... } else if x { ... } else { ... }` | |
| Loop | `for item, index in items key item.id { ... }` | `index` and `key` are optional. Without `key`, the index is used. |

### Props

`Name(a: "string", b: 3, c: true, d, e: space.md, f: todo.title, g: () => go())`

- `d` alone means `d: true`.
- A dotted name that matches a token (`space.md`) becomes that token's CSS variable.
- Any other dotted name or expression is TypeScript.
- Event props (`onClick`, `onChange`, ...) that are not already functions are wrapped:
  `onClick: toggle(todo.id)` becomes `onClick={() => toggle(todo.id)}`.
- `Form(action: add)` passes a page action to the form. No client JavaScript is needed.

### Built-in primitives

`Box`, `Stack`, `Text`, `Heading`, `Button`, `Input`, `Textarea`, `Form`, `Link`, `Image`,
`Divider`, `Spacer`. Their props are the single source of truth in
`packages/core/src/primitives.ts` and are what the validator checks. Any other capitalised
name must be a declared `component` or an imported name.

## Addresses

Every node has an address the overlay, the agent and the graft engine agree on:

```
page:/todos/[id] > Card[0] > Button[0]
page:/todos/[id] > #done
component:Card > Box[0] > Heading[0]
layout:/ > if[0] > then > Text[0]
```

- The head is `page:<route>`, `layout:<route>` or `component:<Name>`.
- Segments are `Name[i]` where `i` counts siblings with the same name, or `#id`.
- `if` nodes have `then` and `else` branches. `for` bodies are addressed directly.
- A `#id` **restarts** the path: everything under a pinned node is addressed relative to
  it, so moving the node elsewhere does not change the addresses of its contents. Pin
  anything an agent will edit repeatedly.

## What the compiler produces

For `page "/todos/[id]"`:

| File | Contents |
| --- | --- |
| `app/todos/[id]/page.tsx` | An async server component. `load` becomes a `load()` function and `PageData` type. |
| `app/todos/[id]/actions.ts` | `"use server"` module with one export per action. |
| `app/todos/[id]/_islands/Island_done.tsx` | A `"use client"` component for every subtree that has an event prop. Its data props are typed from `PageData`. |
| `app/_orchidery/tokens.css` and `tokens.ts` | CSS variables and a typed `tokens` object. |
| `app/_orchidery/components/Card.tsx` | One file per component. A component with event props becomes a client component. |
| `app/layout.tsx` | From `layout "/"`, or a generated default. |

In development every primitive gets a `data-orchid` stamp and `.orchidery/map.json` maps
stamps back to addresses, files and line ranges. Production builds carry no stamps unless
`orchidery.config.json` sets `"stamps": "always"`, which keeps them and publishes the map at
`public/.orchidery/map.json` so an operating agent can resolve addresses on the live site.

## Islands

Pages and layouts render on the server. A subtree with an event prop is extracted into an
anonymous client island automatically, which covers buttons that call actions. When you
need **client state**, declare an island:

```orchid
island Counter(initial: number) {
  state {
    count: initial
    open: false
  }

  ui {
    Button#inc(onClick: setCount(count + 1)) { count }
    if open {
      Text { "Expanded" }
    }
    Button(onClick: setOpen(!open), variant: "ghost") { open ? "Less" : "More" }
  }
}

page "/counter" {
  ui {
    Counter(initial: 0)
  }
}
```

- Each `state` entry becomes a `useState` in a `"use client"` component under
  `app/_orchidery/islands/<Name>.tsx`. The value and its setter (`count`, `setCount`) are in
  scope in `ui`, alongside the params.
- Islands take data in as params and reach the server through props: pass a page action in
  as a param (`onSave: save`) and call it from an event prop.
- An island cannot declare `load` or `action` (O115). The boundary is the declaration, so
  using an island in a page never creates a second, extracted island.
- Address root: `island:Counter`. Graft ops: `add_island`, `set_state`, `remove_state`, plus
  the ordinary node ops on its `ui`.

## Scenarios

A scenario is a test written in the addressing vocabulary. It lives in a `.orchid` file, so
an agent can add or edit one with a graft, and it runs against the dev server with
`orchidery scenario` or the `orchid_scenario_run` tool.

```orchid
scenario "toggle a todo" {
  visit "/todos/b2"
  expect "#toggle" text "Mark done"
  click "#toggle"
  expect "#toggle" text "Mark open"
  fill "page:/ > #add > Stack[0] > Input[0]" "Buy milk"
  submit "#add"
  expect "page:/ > Card[0] > for[0] > Stack[0]" count 4
  screenshot "after-add"
}
```

| Step | Meaning |
| --- | --- |
| `visit "/path"` | Open a route. Must be the first step. |
| `click "<target>"` | Click a node. |
| `fill "<target>" "value"` | Type into an input. |
| `submit "<target>"` | Submit a form (or the form inside the target). |
| `press "Key"` | Press a key, e.g. `"Enter"` or `"Escape"`. |
| `expect "<target>" text "..."` | Exact trimmed text. |
| `expect "<target>" contains "..."` | Substring. |
| `expect "<target>" visible` / `hidden` | Visibility. |
| `expect "<target>" count N` | Number of rendered matches. |
| `expect "<target>" attr "name" "value"` | An attribute equals or (for space-separated values like `class`) includes the value. |
| `wait N` | Milliseconds. |
| `screenshot "name"` | Saves `.orchidery/scenarios/<scenario>/<name>.png`. |

A target is a full address, or `#id` which resolves against the page the scenario is
currently on. The validator checks every target exists somewhere in the project (O118)
and suggests the closest id when it does not. Expectations retry until the step timeout.
A failing step records its error and a full-page screenshot.

Addresses: `scenario:<name>`. Graft ops: `add_scenario`, `set_step`, `insert_step`,
`remove_step`, `remove_scenario`.

## Formatting

`orchidery format` rewrites files in canonical form. Parsing the printed output gives the
same tree, so agents may edit either the text or the JSON AST (`orchid_schema` returns the
schema).
