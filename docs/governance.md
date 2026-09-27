# Governance

Agents that change UI need the same things people do: a record of who changed what, limits
on where they may reach, and a way for a human to say yes before a change lands. Orchidery
builds these on the fact that every change is a graft.

## The graft log

Every graft the MCP server applies is appended to `.orchidery/grafts.jsonl`:

```json
{ "id": "mujv8k2x", "at": "2026-09-27T16:40:11.204Z", "agent": "claude-code",
  "file": "orchid/todos.orchid", "ops": [{ "op": "set_prop", "address": "page:/todos/[id] > #toggle", "name": "variant", "value": "\"secondary\"" }],
  "touched": ["page:/todos/[id] > #toggle"], "annotation": "mujt076w",
  "before": "9c1f0d3a4e7b2c15", "after": "51ab77e0d2f4c9a3" }
```

`agent` is the MCP client's name from its handshake (Claude Code, Cursor, a script you wrote).
`before` and `after` are hashes of the file so a log entry can be matched to a git commit.
Read it with `orchidery log`, the `orchid_history` tool, or by tailing the file.

Agents pass `annotation` on `orchid_graft` so every change is attributed to the note that
asked for it.

## Scopes

`orchidery.config.json` can limit what each agent may touch:

```json
{
  "agents": {
    "claude-code": { "allow": ["page:/settings*", "component:*", "tokens:*"] },
    "*": { "deny": ["layout:*", "page:/admin*"] }
  }
}
```

- Keys are MCP client names. `"*"` applies to any client without its own entry.
- Patterns are address globs. `*` matches any run of characters: `page:/settings*` covers
  the settings page and everything under it, `component:*` every component, `tokens:*`
  every token op.
- `deny` wins over `allow`. With an `allow` list, anything it does not match is denied.
- A graft with any op outside scope fails with `O205` before anything is applied.

## Budgets

```json
{ "budgets": { "opsPerGraft": 20, "nodesPerAnnotation": 12 } }
```

`opsPerGraft` caps a single graft (default 50). `nodesPerAnnotation` caps the distinct
addresses an agent may touch across all grafts for one annotation, using the log to count.
Either failure is `O206`, never a silent truncation.

## The review gate

```json
{ "review": "required" }
```

With review required, `orchid_graft` validates and computes the change as usual but writes it
to `.orchidery/pending/<id>.json` instead of the source. The agent gets back the pending id
and the diff. The human then:

- in edit mode, presses **Review** in the toolbar, reads the diff, and clicks **Accept** or
  **Revert**;
- or runs `orchidery review`, then `--accept <id>`, `--reject <id>`, or `--accept-all`.

Accepting writes the file and logs the graft as `<agent> (accepted by <who>)`. If the file
changed since the graft was proposed, accepting is refused and the agent is asked to redo it,
so a stale proposal never overwrites newer work. `orchid_pending` lets an agent see what is
waiting, but only a human can accept.

## What this gives you

- **Attribution.** `orchidery log --address "page:/checkout"` answers "who touched checkout?"
- **Blast radius.** A new agent gets `allow: ["page:/experiments*"]` until it earns more.
- **A human in the loop where it matters.** Turn on review for production branches and leave
  it off for a scratch app, with no change to the agent's workflow.
