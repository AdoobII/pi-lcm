import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/util/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up at four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("scales to long text", () => {
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });
});