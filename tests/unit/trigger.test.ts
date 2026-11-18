import { describe, expect, it } from "vitest";
import { parseTriggerInput, reserveTokensFor, resolveThresholdTokens } from "../../src/trigger.js";

describe("parseTriggerInput", () => {
  it("parse_percent_with_and_without_space", () => {
    expect(parseTriggerInput("40%")).toEqual({ ok: true, trigger: { mode: "percent", value: 40 } });
    expect(parseTriggerInput("40 %")).toEqual({ ok: true, trigger: { mode: "percent", value: 40 } });
    expect(parseTriggerInput("  5%  ")).toEqual({ ok: true, trigger: { mode: "percent", value: 5 } });
    expect(parseTriggerInput("90%")).toEqual({ ok: true, trigger: { mode: "percent", value: 90 } });
  });

  it("parse_token_counts", () => {
    expect(parseTriggerInput("400k")).toEqual({ ok: true, trigger: { mode: "tokens", value: 400000 } });
    expect(parseTriggerInput("400K")).toEqual({ ok: true, trigger: { mode: "tokens", value: 400000 } });
    expect(parseTriggerInput("400000")).toEqual({ ok: true, trigger: { mode: "tokens", value: 400000 } });
    expect(parseTriggerInput("1.5m")).toEqual({ ok: true, trigger: { mode: "tokens", value: 1500000 } });
    expect(parseTriggerInput("20k")).toEqual({ ok: true, trigger: { mode: "tokens", value: 20000 } });
  });

  it("parse_off_is_case_insensitive_and_trimmed", () => {
    for (const text of ["off", "OFF", " Off \n"]) {
      expect(parseTriggerInput(text)).toEqual({ ok: true, trigger: { mode: "off", value: 0 } });
    }
  });

  it("parse_bare_number_uses_default_mode", () => {
    expect(parseTriggerInput("40", "percent")).toEqual({ ok: true, trigger: { mode: "percent", value: 40 } });
    expect(parseTriggerInput("400000", "percent")).toEqual({ ok: true, trigger: { mode: "tokens", value: 400000 } });
    expect(parseTriggerInput("40").ok).toBe(false);
    expect(parseTriggerInput("40", "tokens").ok).toBe(false);
  });

  it("parse_rejects_leading_zero_fraction_and_sign_edge_cases", () => {
    expect(parseTriggerInput("040%")).toEqual({ ok: true, trigger: { mode: "percent", value: 40 } });
    expect(parseTriggerInput("40.5%")).toEqual({ ok: true, trigger: { mode: "percent", value: 40.5 } });
    expect(parseTriggerInput("+40%").ok).toBe(false);
    expect(parseTriggerInput("40", "percent")).toEqual({ ok: true, trigger: { mode: "percent", value: 40 } });
    const tooSmall = parseTriggerInput("100", "tokens");
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.reason).toContain("20000");
  });

  it("parse_rejects_garbage", () => {
    const inputs = [
      "abc", "-5%", "0", "4%", "95%", "10k", "1e999", "4o0k", "", "   ", "NaN", "Infinity", "-Infinity",
      "NaN%", "Infinity%", "40%%", "1,5m", "%", "k", "40 k k", "0%", "0k", "-400k", "9".repeat(400), "9".repeat(400) + "%",
    ];
    for (const input of inputs) {
      const result = parseTriggerInput(input, "percent");
      expect(result.ok, `input ${JSON.stringify(input)}`).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
    for (const input of ["abc", "0", "40"]) {
      expect(parseTriggerInput(input).ok, input).toBe(false);
    }
  });
});

describe("resolveThresholdTokens", () => {
  it("resolve_percent_of_window", () => {
    expect(resolveThresholdTokens({ mode: "percent", value: 40 }, 1_000_000, 20000)).toEqual({ tokens: 400000 });
  });

  it("resolve_percent_floors", () => {
    expect(resolveThresholdTokens({ mode: "percent", value: 33 }, 100_001, 1000)).toEqual({ tokens: 33000 });
  });

  it("resolve_tokens_at_or_above_window_is_unusable", () => {
    const over = resolveThresholdTokens({ mode: "tokens", value: 400000 }, 200_000, 20000);
    expect(over.tokens).toBeNull();
    expect("reason" in over && over.reason.length > 0).toBe(true);
    expect(resolveThresholdTokens({ mode: "tokens", value: 200000 }, 200_000, 20000).tokens).toBeNull();
  });

  it("resolve_raises_to_twice_keep_recent", () => {
    expect(resolveThresholdTokens({ mode: "tokens", value: 25000 }, 1_000_000, 20000)).toEqual({ tokens: 40000 });
  });

  it("resolve_null_and_off_have_no_threshold", () => {
    expect(resolveThresholdTokens(null, 1_000_000, 20000).tokens).toBeNull();
    expect(resolveThresholdTokens({ mode: "off", value: 0 }, 1_000_000, 20000).tokens).toBeNull();
  });

  it("resolve_rejects_bad_window_and_unreachable_floor", () => {
    expect(resolveThresholdTokens({ mode: "percent", value: 40 }, 0, 20000).tokens).toBeNull();
    expect(resolveThresholdTokens({ mode: "percent", value: 40 }, Number.NaN, 20000).tokens).toBeNull();
    const tooSmall = resolveThresholdTokens({ mode: "percent", value: 40 }, 30_000, 20000);
    expect(tooSmall.tokens).toBeNull();
  });
});

describe("reserveTokensFor", () => {
  it("reserve_is_window_minus_threshold", () => {
    expect(reserveTokensFor(400000, 1_000_000)).toBe(600000);
  });
});
