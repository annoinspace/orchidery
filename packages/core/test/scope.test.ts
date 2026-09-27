import { describe, expect, it } from "vitest";
import { addressMatches, graft, inScope, opTargets, parse, scopeFor } from "../src/index.js";

const SRC = `tokens { space.md: 16 }
page "/settings" { ui { Box#panel { Text { "s" } } } }
page "/admin" { ui { Box#danger { Text { "a" } } } }
layout "/" { ui { Box { children } } }
`;

describe("scopes and budgets", () => {
  it("matches address globs", () => {
    expect(addressMatches("page:/settings*", "page:/settings > #panel")).toBe(true);
    expect(addressMatches("page:/settings*", "page:/admin > #danger")).toBe(false);
    expect(addressMatches("component:*", "component:Card > Box[0]")).toBe(true);
    expect(addressMatches("*", "layout:/ > Box[0]")).toBe(true);
    expect(addressMatches("page:/todos/[id]*", "page:/todos/[id] > #done")).toBe(true);
  });

  it("applies deny over allow and allow-lists strictly", () => {
    expect(inScope("page:/settings > #panel", { allow: ["page:/settings*"] })).toBe(true);
    expect(inScope("page:/admin > #danger", { allow: ["page:/settings*"] })).toBe(false);
    expect(inScope("layout:/ > Box[0]", { deny: ["layout:*"] })).toBe(false);
    expect(inScope("layout:/ > Box[0]", { allow: ["*"], deny: ["layout:*"] })).toBe(false);
    expect(inScope("anything", {})).toBe(true);
  });

  it("derives targets for every op kind", () => {
    expect(opTargets({ op: "set_prop", address: "page:/a > Box[0]", name: "x", value: "1" })).toEqual(["page:/a > Box[0]"]);
    expect(opTargets({ op: "move_node", address: "page:/a > Box[0]", to: "page:/b" })).toEqual(["page:/a > Box[0]", "page:/b"]);
    expect(opTargets({ op: "add_token", path: "space.lg", value: 1 })).toEqual(["tokens:space.lg"]);
    expect(opTargets({ op: "add_component", source: "component Card() { Box }" })).toEqual(["component:Card"]);
    expect(opTargets({ op: "add_scenario", source: 'scenario "go home" { visit "/" }' })).toEqual(["scenario:go home"]);
    expect(opTargets({ op: "set_step", scenario: "go home", index: 0, step: 'visit "/"' })).toEqual(["scenario:go home"]);
    expect(opTargets({ op: "set_state", island: "island:X", name: "a", initial: "1" })).toEqual(["island:X"]);
  });

  it("refuses out-of-scope grafts before applying anything", () => {
    const doc = parse(SRC);
    const scope = { allow: ["page:/settings*", "tokens:*"], deny: ["page:/admin*"] };
    expect(() => graft(doc, [{ op: "set_text", address: "page:/admin > #danger", value: "x" }], { scope })).toThrowError(/O205/);
    expect(() => graft(doc, [{ op: "set_text", address: "layout:/ > Box[0]", value: "x" }], { scope })).toThrowError(/O205/);
    expect(() => graft(doc, [{ op: "set_text", address: "page:/settings > #panel", value: "x" }, { op: "prune", address: "page:/admin > #danger" }], { scope })).toThrowError(/O205/);
    const ok = graft(doc, [{ op: "set_text", address: "page:/settings > #panel", value: "fine" }, { op: "add_token", path: "space.lg", value: 24 }], { scope });
    expect(ok.text).toContain('"fine"');
  });

  it("enforces op and node budgets", () => {
    const doc = parse(SRC);
    const ops = [
      { op: "set_text" as const, address: "page:/settings > #panel", value: "a" },
      { op: "set_text" as const, address: "page:/admin > #danger", value: "b" },
    ];
    expect(() => graft(doc, ops, { maxOps: 1 })).toThrowError(/O206.*budget is 1 per graft/);
    expect(() => graft(doc, ops, { maxTouched: 2, alreadyTouched: ["layout:/ > Box[0]"] })).toThrowError(/O206.*touch 3 nodes/);
    expect(graft(doc, ops, { maxTouched: 3, alreadyTouched: ["layout:/ > Box[0]"] }).touched).toHaveLength(2);
  });

  it("resolves an agent's scope from config", () => {
    const cfg = { src: "orchid", out: "app", devtoolsPort: 1, stamps: "dev" as const, agents: { "claude-code": { allow: ["page:*"] }, "*": { deny: ["layout:*"] } } };
    expect(scopeFor(cfg, "claude-code")).toEqual({ allow: ["page:*"] });
    expect(scopeFor(cfg, "cursor")).toEqual({ deny: ["layout:*"] });
    expect(scopeFor({ ...cfg, agents: undefined }, "cursor")).toBeUndefined();
  });
});
