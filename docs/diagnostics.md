# Diagnostics

Every diagnostic Orchidery emits has a stable code, a severity, a message, and where possible a
file, a range and a suggested fix. The CLI prints them; the MCP server returns them as JSON.
Ask `orchid_explain` for any code.

```json
{ "code": "O104", "severity": "error", "message": "Unknown prop `colour` on Text",
  "file": "orchid/todos.orchid", "range": { "start": { "line": 22, "col": 14 }, "end": { "line": 22, "col": 20 } },
  "fix": { "description": "Did you mean `color`?", "replacement": "color" } }
```

| Code | Title | Explanation |
| --- | --- | --- |
| **Syntax** | | |
| `O001` | Unexpected token | The parser found something it did not expect at this position. Check for a missing brace, parenthesis or quote. |
| `O002` | Unterminated string | A string literal was opened but never closed on the same line. |
| `O003` | Unterminated block | A `{` was opened but the file ended before its matching `}`. |
| `O004` | Expected identifier | A name was expected here, such as a component, page or prop name. |
| `O005` | Unknown top-level declaration | Only `tokens`, `import`, `component`, `layout` and `page` may appear at the top level of a .orchid file. |
| `O006` | Unknown page block | Inside a `page` only `load`, `action`, `meta` and `ui` blocks are allowed. |
| `O007` | Invalid route | Routes must start with `/` and use Next.js segment syntax such as `/todos/[id]`. |
| `O008` | Invalid token path | Token paths are dotted identifiers such as `color.primary`. |
| **Semantics** | | |
| `O101` | Duplicate route | Two pages or two layouts declare the same route. Each route may be declared once across the project. |
| `O102` | Unknown component | An element name starting with a capital letter is neither a built-in primitive, a declared component nor an imported name. |
| `O103` | Unknown token | A dotted reference looks like a token path but no token with that path is declared. |
| `O104` | Unknown prop | The prop is not accepted by this built-in primitive. The fix suggests the closest valid prop name. |
| `O105` | Missing required prop | A built-in primitive or declared component requires a prop that was not given. |
| `O106` | Duplicate id | Two nodes in the same page, layout or component share a `#id`. Ids must be unique within their root so addresses stay unambiguous. |
| `O107` | Event prop outside a page | Event handlers such as `onClick` can only reference actions declared in the enclosing page. |
| `O108` | Unknown action | An event handler calls an action that is not declared in this page. |
| `O109` | Action arity mismatch | The action is called with a different number of arguments than it declares. |
| `O110` | Missing children slot | A layout must render `children` somewhere in its `ui` block so pages have a place to go. |
| `O111` | Duplicate declaration | Two components or two load bindings share a name. |
| `O112` | Unknown prop on component | The prop is not one of the component's declared parameters. |
| `O113` | Duplicate prop | The same prop is given twice on one element. |
| `O114` | Slot outside component or layout | `children` can only be rendered inside a `component` or `layout` body. |
| `O115` | Invalid island block | An `island` body holds an optional `state { name: initial }` block and a `ui` block, nothing else. Islands cannot declare `load` or `action`; pass data in as params and call page actions through props. |
| `O116` | Invalid scenario step | Scenario steps are `visit`, `click`, `fill`, `submit`, `press`, `expect`, `wait` and `screenshot`, each with quoted string arguments and numbers where required. |
| `O117` | Duplicate scenario | Two scenarios share a name. Names are how scenarios are addressed and run, so they must be unique across the project. |
| `O118` | Scenario target not found | A step names an address that no page, layout or component declares. `#id` targets must exist in some page; full addresses must resolve. |
| `O119` | Scenario must start with visit | The first step of a scenario has to be `visit` with a path so later steps have a page to act on. |
| `O120` | Invalid resource | A `resource` needs a `fields { name: type }` block (types: string, number, boolean, Date, with optional `?` and `= default`), a `source` expression naming an object with list/find/create/update/remove, and `routes "/base"`. |
| `O121` | Duplicate resource or field | Two resources share a name, or a resource declares the same field twice. |
| `O122` | Binding shadows import | A load binding has the same name as an import it reads from, so the generated `const x = await x.list()` refers to itself. Rename the binding. |
| **Grafts and governance** | | |
| `O201` | Address not found | No node matches the given address in this document. |
| `O202` | Invalid graft op | The graft operation is malformed or targets a node kind it cannot apply to. |
| `O203` | Graft would produce invalid document | Applying the ops produced a document that fails validation, so nothing was written. |
| `O204` | Invalid address syntax | Addresses look like `page:/todos/[id] > ui > Card[0] > #done`. |
| `O205` | Address outside agent scope | The project's config limits this agent to certain addresses (`agents.<name>.allow` / `deny` globs such as `page:/settings*`). Nothing was applied. Ask a human to widen the scope or make the change elsewhere. |
| `O206` | Graft budget exceeded | The graft has more ops, or would touch more nodes for this annotation, than the project's `budgets` allow. Split the work into smaller grafts or ask a human to raise the budget. |
| **Fragments** | | |
| `O301` | Unknown element in fragment | Fragments may use the built-in primitives and the components the host registered. Anything else is rejected before rendering. |
| `O302` | Unsafe expression in fragment | Fragment expressions are limited to literals, `data.*` paths, loop variables, tokens, template literals over those, and `act("name", ...)` calls on event props. No other code runs at runtime. |
| `O303` | Unknown fragment action | An event prop calls `act("name")` but the host did not register that action name. |
| `O304` | Unknown fragment data path | A `data.*` path or bare name does not match the data the host provides. Read host data as `data.<key>`. |

Ranges are 1-based lines and columns. `fix.replacement` is the text to put in place of the range.
