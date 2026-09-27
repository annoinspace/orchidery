# Working an Orchidery project as an agent

This is the guide to hand an agent. It assumes the `@orchidery/mcp` server is connected.

```sh
claude mcp add orchidery -- npx orchidery mcp
```

## Rules

1. **Edit `.orchid` sources through `orchid_graft`.** Never edit files under the app
   directory. They are generated and will be overwritten.
2. **Address nodes, don't describe them.** `page:/todos/[id] > #done` is exact. "The button
   on the todo page" is not.
3. **Pin what you will touch again.** `set_id` gives a node a `#id` so its address survives
   reordering.
4. **Prefer semantic props and tokens over raw CSS.** `size: "lg"` and `gap: space.md`
   compile to something the design system understands. `style: { ... }` is a last resort.
5. **A failed graft changed nothing.** The error carries the diagnostics. Fix and retry.
6. **Mark annotations as you go.** `in_progress` when you start, `done` with a one-line
   summary when finished, `rejected` with a reason if you won't do it.

## Orientation

- `orchid_project` lists files, pages, layouts, components, their top-level children,
  actions, load bindings and tokens. Start here.
- `orchid_read` returns a file with every address in it.
- `orchid_get_node` returns one node: source excerpt, canonical snippet, AST and children.
- `orchid_schema` returns the JSON Schema for documents and graft ops, the primitives with
  their props, and every diagnostic code.

## The tend loop

```
orchid_annotations                      -> pick the oldest pending one
orchid_annotation { id }                -> note, targets with source, common ancestor, screenshot
orchid_annotation_update { id, status: "in_progress" }
orchid_get_node ...                     -> look around if the targets are not enough
orchid_graft { ops: [...] }             -> make the change
orchid_preview { route }                -> look at the result before claiming it is done
orchid_scenario_run { name? }           -> check nothing else broke
orchid_annotation_update { id, status: "done", summary: "..." }
```

## Look before you mark done

Never close an annotation on the strength of a graft alone. `orchid_preview` renders the
route in a headless browser (the dev server must be running) and returns:

- a screenshot, as an image you can read
- `boxes`: the viewport rectangle of every addressable node, so you can check the thing you
  changed is where the human pointed
- `errors`: console errors and failed requests
- `a11y`: axe-core violations, each with the address of the offending node

Pass `source` instead of `route` to preview a document you have not written yet: it is
compiled under a temporary route and removed afterwards. Use that to try two options and
show the human the better one.

`orchid_scenario_run` runs the project's scenarios (tests written with addresses). Run the
ones that touch the page you changed. If there is no scenario for the behaviour you just
built, add one with `add_scenario` so the next agent has it. A scenario that fails after
your graft is your regression to fix, not a flake.

The screenshot shows what the human circled. Their targets are the outermost stamped
elements mostly inside the region; the common ancestor is the deepest node above all of
them. If they drew around a whole card and said "tighten this up", the ancestor is the
card and the targets are its rows.

## Graft ops

| Op | Use |
| --- | --- |
| `set_prop { address, name, value }` | Change or add a prop. `value` is raw source: `"\"primary\""`, `"space.md"`, `"todo.title"`. |
| `remove_prop { address, name }` | |
| `set_text { address, value }` | Replace a text node, or an element's children with one text node. |
| `set_id { address, id }` | Pin a node. `null` unpins. |
| `insert_child { address, index?, node }` | `node` is a `.orchid` snippet such as `Text(muted) { "hi" }`. Address may be a root (`page:/`) or an `if` branch (`... > if[0] > else`). |
| `prune { address }` | Remove a node. |
| `replace_node { address, node }` | |
| `move_node { address, to, index? }` | |
| `wrap_node { address, name, id?, props? }` | Wrap in a new element, e.g. a `Stack`. |
| `add_token` / `set_token` / `remove_token` | Design tokens. |
| `add_component { source }` | A whole `component Name(...) { ... }` declaration. |
| `add_island { source }` | A whole `island Name(...) { state { ... } ui { ... } }` declaration. Use this when a change needs client state. |
| `set_state` / `remove_state { island, name, initial? }` | Add, change or remove a state entry on an island. |
| `add_scenario { source }` | A whole `scenario "name" { ... }` declaration. |
| `set_step` / `insert_step` / `remove_step { scenario, index, step? }` | Edit one line of a scenario. `step` is a line like `click "#toggle"`. |
| `remove_scenario { scenario }` | |

Ops apply in order, each seeing the result of the previous one. Everything is validated at
the end and nothing is written unless the whole batch is valid.

## Example

Annotation: targets `["page:/todos/[id] > #toggle"]`, note "this should look less loud and
sit under the text, not next to it".

```json
{ "ops": [
  { "op": "set_prop", "address": "page:/todos/[id] > #toggle", "name": "variant", "value": "\"secondary\"" },
  { "op": "set_prop", "address": "page:/todos/[id] > Card[0] > Stack[0]", "name": "direction", "value": "\"column\"" }
] }
```

Then `orchid_annotation_update { id, status: "done", summary: "Secondary variant, actions stacked below the text" }`.

## Reading diagnostics

Every error has a code (`docs/diagnostics.md`, or `orchid_explain`). The ones you will see most:

- `O104` unknown prop on a primitive, with the closest valid name as a fix
- `O102` unknown component: declare it, import it, or use a primitive
- `O103` unknown token: `orchid_project` lists the ones that exist
- `O108` an event handler calls something that is not an action in this page
- `O203` a graft would leave the file invalid; the message lists why
