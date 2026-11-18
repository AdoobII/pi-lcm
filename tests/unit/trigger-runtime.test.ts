import { describe, expect, it } from "vitest";
import { shouldCompact } from "../../src/trigger-runtime.js";

type Input = Parameters<typeof shouldCompact>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    usage: { tokens: 500_000, contextWindow: 1_000_000 },
    trigger: { mode: "percent", value: 40 },
    keepRecentTokens: 20000,
    hasModel: true,
    isCompacting: false,
    lastFailure: null,
    ...overrides,
  };
}

describe("shouldCompact", () => {
  it("null_tokens_never_triggers", () => {
    const result = shouldCompact(input({ usage: { tokens: null, contextWindow: 1_000_000 } }));
    expect(result.compact).toBe(false);
    expect(shouldCompact(input({ usage: undefined })).compact).toBe(false);
  });

  it("below_threshold_does_nothing", () => {
    expect(shouldCompact(input({ usage: { tokens: 399_999, contextWindow: 1_000_000 } })).compact).toBe(false);
  });

  it("at_threshold_compacts", () => {
    expect(shouldCompact(input({ usage: { tokens: 400_000, contextWindow: 1_000_000 } }))).toEqual({
      compact: true,
      thresholdTokens: 400_000,
    });
    expect(shouldCompact(input({ usage: { tokens: 900_000, contextWindow: 1_000_000 } })).compact).toBe(true);
  });

  it("no_summarizer_model_skips", () => {
    expect(shouldCompact(input({ hasModel: false })).compact).toBe(false);
  });

  it("already_compacting_skips", () => {
    expect(shouldCompact(input({ isCompacting: true })).compact).toBe(false);
  });

  it("failure_backs_off_until_ten_percent_more", () => {
    const lastFailure = { tokens: 450_000 };
    expect(shouldCompact(input({ lastFailure, usage: { tokens: 450_000, contextWindow: 1_000_000 } })).compact).toBe(false);
    expect(shouldCompact(input({ lastFailure, usage: { tokens: 549_999, contextWindow: 1_000_000 } })).compact).toBe(false);
    expect(shouldCompact(input({ lastFailure, usage: { tokens: 550_000, contextWindow: 1_000_000 } })).compact).toBe(true);
  });

  it("percent_threshold_follows_the_active_model_window", () => {
    const trigger = { mode: "percent" as const, value: 40 };
    const small = shouldCompact(input({ trigger, usage: { tokens: 90_000, contextWindow: 200_000 } }));
    expect(small).toEqual({ compact: true, thresholdTokens: 80_000 });
    const large = shouldCompact(input({ trigger, usage: { tokens: 90_000, contextWindow: 1_000_000 } }));
    expect(large.compact).toBe(false);
  });

  it("no_trigger_or_off_never_compacts", () => {
    expect(shouldCompact(input({ trigger: null })).compact).toBe(false);
    expect(shouldCompact(input({ trigger: { mode: "off", value: 0 } })).compact).toBe(false);
  });

  it("unusable_threshold_never_compacts", () => {
    const result = shouldCompact(input({ trigger: { mode: "tokens", value: 400_000 }, usage: { tokens: 300_000, contextWindow: 200_000 } }));
    expect(result.compact).toBe(false);
    expect(shouldCompact(input({ usage: { tokens: 500_000, contextWindow: 0 } })).compact).toBe(false);
  });

  it("keep_recent_floor_raises_the_threshold", () => {
    const trigger = { mode: "tokens" as const, value: 20000 };
    const below = shouldCompact(input({ trigger, usage: { tokens: 39_999, contextWindow: 1_000_000 } }));
    expect(below.compact).toBe(false);
    const at = shouldCompact(input({ trigger, usage: { tokens: 40_000, contextWindow: 1_000_000 } }));
    expect(at).toEqual({ compact: true, thresholdTokens: 40_000 });
  });
});
