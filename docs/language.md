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
stamps back to addresses, files and line ranges. Production builds carry no stamps.

## Formatting

`orchidery format` rewrites files in canonical form. Parsing the printed output gives the
same tree, so agents may edit either the text or the JSON AST (`orchid_schema` returns the
schema).
