import { describe, expect, it } from "vitest";
import { askTrigger } from "../../src/trigger-prompt.js";

const PERCENT_OPTION = "Percent of context window (suggested: 40%)";
const TOKENS_OPTION = "Number of tokens";
const OFF_OPTION = "Off (Pi's own threshold only)";

function scriptedUi(script: { select: (string | undefined)[]; input?: (string | undefined)[] }) {
  const selects = [...script.select];
  const inputs = [...(script.input ?? [])];
  const calls = { selectOptions: [] as string[][], inputTitles: [] as string[], notifications: [] as string[] };
  const ui = {
    select: async (_title: string, options: string[]) => {
      calls.selectOptions.push(options);
      return selects.shift();
    },
    input: async (title: string, _placeholder?: string) => {
      calls.inputTitles.push(title);
      return inputs.shift();
    },
    notify: (message: string) => {
      calls.notifications.push(message);
    },
  };
  return { ui, calls };
}

describe("askTrigger", () => {
  it("offers percent, tokens and off in that order", async () => {
    const { ui, calls } = scriptedUi({ select: [undefined] });
    await askTrigger({ ui }, [1_000_000]);
    expect(calls.selectOptions[0]).toEqual([PERCENT_OPTION, TOKENS_OPTION, OFF_OPTION]);
  });

  it("percent_choice_returns_the_parsed_percent", async () => {
    const { ui } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    expect(await askTrigger({ ui }, [1_000_000])).toEqual({ mode: "percent", value: 40 });
  });

  it("tokens_choice_returns_the_parsed_token_count", async () => {
    const { ui } = scriptedUi({ select: [TOKENS_OPTION], input: ["400k"] });
    expect(await askTrigger({ ui }, [1_000_000])).toEqual({ mode: "tokens", value: 400_000 });
  });

  it("off_choice_returns_off_without_asking_for_a_value", async () => {
    const { ui, calls } = scriptedUi({ select: [OFF_OPTION] });
    expect(await askTrigger({ ui }, [1_000_000])).toEqual({ mode: "off", value: 0 });
    expect(calls.inputTitles).toEqual([]);
    expect(calls.notifications).toEqual([]);
  });

  it("cancel_at_the_mode_step_returns_undefined", async () => {
    const { ui, calls } = scriptedUi({ select: [undefined] });
    expect(await askTrigger({ ui }, [1_000_000])).toBeUndefined();
    expect(calls.notifications).toEqual([]);
  });

  it("cancel_at_the_value_step_returns_undefined", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: [undefined] });
    expect(await askTrigger({ ui }, [1_000_000])).toBeUndefined();
    expect(calls.notifications).toEqual([]);
  });

  it("unrecognised_mode_choice_returns_undefined", async () => {
    const { ui } = scriptedUi({ select: ["test/test-model"] });
    expect(await askTrigger({ ui }, [1_000_000])).toBeUndefined();
  });

  it("invalid_input_loops_with_the_reason_until_valid", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["abc", "-5%", "0", "95", "40"] });
    expect(await askTrigger({ ui }, [1_000_000])).toEqual({ mode: "percent", value: 40 });
    expect(calls.inputTitles).toHaveLength(5);
    expect(calls.inputTitles[1]).toContain("use a percent");
    expect(calls.inputTitles[4]).toContain("percent must be between");
  });

  it("input_in_the_wrong_mode_is_rejected", async () => {
    const tokens = scriptedUi({ select: [TOKENS_OPTION], input: ["40%", "off", "300k"] });
    expect(await askTrigger({ ui: tokens.ui }, [1_000_000])).toEqual({ mode: "tokens", value: 300_000 });
    expect(tokens.calls.inputTitles).toHaveLength(3);
    const percent = scriptedUi({ select: [PERCENT_OPTION], input: ["400k", "off", "25%"] });
    expect(await askTrigger({ ui: percent.ui }, [1_000_000])).toEqual({ mode: "percent", value: 25 });
    expect(percent.calls.inputTitles).toHaveLength(3);
  });

  it("reserve_tokens_hint_is_notified_per_distinct_window", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    await askTrigger({ ui }, [1_000_000, 200_000, 1_000_000]);
    expect(calls.notifications).toEqual([
      "For Pi's own settings.json: reserveTokens 600000 for a 1000000-token window; reserveTokens 120000 for a 200000-token window",
    ]);
  });

  it("reserve_tokens_hint_skips_windows_the_trigger_cannot_fit", async () => {
    const { ui, calls } = scriptedUi({ select: [TOKENS_OPTION], input: ["400k"] });
    await askTrigger({ ui }, [1_000_000, 200_000]);
    expect(calls.notifications).toEqual(["For Pi's own settings.json: reserveTokens 600000 for a 1000000-token window"]);
  });

  it("reserve_tokens_hint_uses_the_keep_recent_floor", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["5"] });
    await askTrigger({ ui }, [200_000], 20_000);
    expect(calls.notifications).toEqual(["For Pi's own settings.json: reserveTokens 160000 for a 200000-token window"]);
  });

  it("no_hint_when_no_window_is_known", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    expect(await askTrigger({ ui }, [])).toEqual({ mode: "percent", value: 40 });
    expect(calls.notifications).toEqual([]);
  });
});
