# Runtime fragments

A fragment is the contents of a `ui { }` block rendered **at runtime**, typically from a
model's output. It is the generative-UI half of Orchidery: the same primitives, tokens
and addressing as compiled pages, but interpreted rather than compiled, and constrained so
that nothing in it runs as code.

```orchid
Stack(gap: space.md) {
  Heading(level: 3) { data.order.title }
  Text(muted) { `Total: ${data.order.total}` }
  for line in data.order.lines key line.id {
    Text { line.name }
  }
  if data.order.open {
    Button(onClick: act("close", data.order.id), variant: "danger") { "Close order" }
  }
}
```

## What a fragment may contain

| Allowed | Example |
| --- | --- |
| Built-in primitives | `Stack`, `Text`, `Button`, ... |
| Host components the page registers | `Chart(points: data.series)` |
| Literals | `"text"`, `42`, `true` |
| Data paths | `data.order.total`, `line.name` inside a `for` |
| Tokens | `space.md`, `color.primary` |
| Template literals over those | `` `Total: ${data.order.total}` `` |
| Action calls on event props | `onClick: act("close", data.order.id)` |
| `if` and `for` with the same expression rules | |

Everything else is rejected before rendering with an O3xx diagnostic: `O301` unknown
element, `O302` unsafe expression (a ternary, arithmetic, a function call, an arrow
function), `O303` unknown action, `O304` unknown data path or name. The renderer never
evaluates code: data paths are looked up, tokens become CSS variables, actions become
callbacks. A fragment that fails validation renders the `fallback` or nothing.

## Rendering

`<Orchid>` is a client component. Give it `source` (text) or `nodes` (parsed JSON), the
`data` it may read, any host `components`, and an `onAction` handler.

```tsx
"use client";
import { Orchid } from "@orchidery/runtime/fragment";

export function Assistant({ source, order }: { source: string; order: Order }) {
  return (
    <Orchid
      source={source}
      data={{ order }}
      components={{ Chart }}
      actions={["close"]}
      onAction={(name, args) => name === "close" && closeOrder(args[0] as string)}
      fallback={(diagnostics) => <p>Could not render: {diagnostics[0]?.message}</p>}
    />
  );
}
```

From a server component with no actions, pass only serialisable props (`source`, `data`),
as the example app does in `orchid/assistant.orchid`:

```orchid
import { Orchid } from "@orchidery/runtime/fragment"

page "/assistant" {
  load {
    todos: await db.list()
    fragment: summaryFragment()
  }
  ui {
    Orchid#summary(source: fragment, data: { todos })
  }
}
```

For HTML without React on the client (emails, previews), use the server renderer:

```ts
import { renderFragmentToHtml } from "@orchidery/runtime/fragment-server";
const { html, diagnostics } = renderFragmentToHtml({ source }, { data: { order } });
```

## Getting a fragment from Claude

The simplest reliable approach is to ask for fragment **source text** and validate it.
The grammar is small, the model already knows the primitives from `orchid_schema`, and
validation catches anything unsafe before it renders.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { fragment, PRIMITIVES } from "@orchidery/core/browser";

const client = new Anthropic();

const primitives = Object.entries(PRIMITIVES)
  .map(([name, spec]) => `${name}(${spec.props.join(", ")}): ${spec.doc}`)
  .join("\n");

const response = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 16000,
  system: `You write Orchidery ui fragments. Reply with the fragment only, no prose, no code fence.
Allowed elements:\n${primitives}
Rules: read host data as data.<key>; use tokens like space.md and color.primary; the only code allowed
on event props is act("name", ...args); no ternaries, arithmetic or function calls. Use if/else and for.`,
  messages: [{ role: "user", content: `Data keys: order (title, total, open, id, lines[id,name]). Actions: close.\nShow the order and let the user close it.` }],
});

const source = response.content.find((b) => b.type === "text")?.text ?? "";
// Throws an OrchidError with the first O3xx diagnostic if the model produced anything unsafe.
const nodes = fragment(source, { data: ["order"], actions: ["close"] });
```

If you would rather have JSON, the AST has a schema: `fragmentJsonSchema()` from
`@orchidery/core` returns the JSON Schema of `UiNode[]`, and the same Zod schema is exported
as `UiNode` for use with the SDK's `zodOutputFormat(z.array(UiNode))`. Pass the result as
`nodes` to `<Orchid>`. Text output is usually shorter and easier for the model, so start
there.

Agents building this kind of feature can check a fragment with the `orchid_fragment_validate`
MCP tool before wiring it up.

## Why this is safe

A compiled page trusts its author: leaf expressions are TypeScript. A fragment does not:
the validator rejects every expression that is not a literal, a data path, a token or an
`act` call, and the interpreter has no `eval` path at all. The worst a hostile fragment can
do is render primitives with odd props, which the primitives themselves sanitise (they only
pass known props to the DOM).
