/**
 * Stands in for a model. A real assistant would ask Claude for a fragment,
 * constrained by fragmentJsonSchema() from @orchidery/core (see
 * docs/fragments.md). The output shape is the same: ui-block source that
 * <Orchid> validates and renders without evaluating any code.
 */
export function summaryFragment(): string {
  return `
Stack(gap: space.md) {
  Heading(level: 3) { "Where you're at" }
  if data.stats.allDone {
    Text { "Everything is done. Nice." }
  } else {
    Text { \`\${data.stats.open} still open, \${data.stats.done} done.\` }
  }
  for todo in data.todos key todo.id {
    Stack(direction: "row", gap: space.sm, align: "center") {
      if todo.done {
        Text(size: "sm", muted) { "done" }
      } else {
        Text(size: "sm", color: color.primary) { "open" }
      }
      Link(href: \`/todos/\${todo.id}\`) { todo.title }
    }
  }
}`;
}
