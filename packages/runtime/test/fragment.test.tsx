import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderFragmentToHtml } from "../src/fragment-server.js";
import { Orchid, evaluate } from "../src/fragment.js";

const SRC = `
Stack(gap: space.md) {
  Heading(level: 2) { data.order.title }
  Text(size: "sm", muted) { \`Total: \${data.order.total}\` }
  for line, i in data.order.lines key line.id {
    Text { \`\${i}: \${line.name}\` }
  }
  if data.order.open {
    Button#close(onClick: act("close", data.order.id), variant: "danger") { "Close" }
  } else {
    Text { "Closed" }
  }
}`;
const data = { order: { title: "Order 7", total: 42, open: true, id: "o7", lines: [{ id: "a", name: "Matcha" }, { id: "b", name: "Latte" }] } };

describe("fragment runtime", () => {
  it("renders data, tokens, loops and conditionals to HTML", () => {
    const { html, diagnostics } = renderFragmentToHtml({ source: SRC }, { data });
    expect(diagnostics).toEqual([]);
    expect(html).toContain("Order 7");
    expect(html).toContain("Total: 42");
    expect(html).toContain("gap:var(--space-md)");
    expect(html).toContain("Matcha");
    expect(html).toContain("Latte");
    expect(html).toContain("o-btn-danger");
    expect(html).toContain('data-orchid-id="close"');
    expect(html).not.toContain("Closed");
  });

  it("refuses invalid fragments and reports diagnostics", () => {
    const r = renderFragmentToHtml({ source: `Text { fetch("/x") }` });
    expect(r.html).toBe("");
    expect(r.diagnostics[0]?.code).toBe("O302");
    const html = renderToStaticMarkup(<Orchid source={`Buton { "x" }`} fallback={(d) => <i>{d[0]!.code}</i>} />);
    expect(html).toBe("<i>O301</i>");
  });

  it("uses host components and never evaluates code", () => {
    const Chart = (p: Record<string, unknown>) => <svg data-points={String((p.points as number[]).length)} />;
    const { html } = renderFragmentToHtml({ source: `Chart(points: data.series)` }, { data: { series: [1, 2, 3] }, componentMap: { Chart } });
    expect(html).toBe('<svg data-points="3"></svg>');
    expect(evaluate({ kind: "code", code: "process.exit(1)" }, {})).toBeUndefined();
    expect(evaluate({ kind: "ref", path: "data.missing.deep" }, { data: {} })).toBeUndefined();
    expect(evaluate({ kind: "ref", path: "color.primary" }, {})).toBe("var(--color-primary)");
  });

  it("rejects arithmetic inside templates rather than evaluating it", () => {
    const r = renderFragmentToHtml({ source: "Text { `${data.n + 1}` }" }, { data: { n: 1 } });
    expect(r.diagnostics[0]?.code).toBe("O302");
  });
});
