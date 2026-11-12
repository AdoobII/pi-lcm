import { describe, expect, it } from "vitest";
import { condensedPrompt, leafPrompt, parseMemories } from "../../src/compact/prompts.js";

describe("prompts", () => {
  it("leaf prompt carries the structured format and memory block", () => {
    const prompt = leafPrompt(0, false, "focus on auth");
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Critical Context");
    expect(prompt).toContain("Expand for details about:");
    expect(prompt).toContain("<memories>");
    expect(prompt).toContain("focus on auth");
  });

  it("condensed prompt asks for abstraction", () => {
    const prompt = condensedPrompt(2);
    expect(prompt).toContain("condense");
    expect(prompt).toContain("Expand for details about:");
  });
});

describe("parseMemories", () => {
  it("parses a valid block", () => {
    const text = 'Summary\n<memories>[{"content":"use pnpm","tags":["type:preference"]}]</memories>';
    expect(parseMemories(text)).toEqual([{ content: "use pnpm", tags: ["type:preference"] }]);
  });

  it("ignores malformed or missing blocks", () => {
    expect(parseMemories("no block")).toEqual([]);
    expect(parseMemories("<memories>not json</memories>")).toEqual([]);
    expect(parseMemories('<memories>[{"tags":[]}]</memories>')).toEqual([]);
  });
});
