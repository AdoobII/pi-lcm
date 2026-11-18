import { describe, expect, it } from "vitest";
import { askTrigger } from "../../src/trigger-prompt.js";

const model = (id: string, contextWindow: number) => ({ id, contextWindow });

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
    await askTrigger({ ui }, [model("p/big", 1_000_000)]);
    expect(calls.selectOptions[0]).toEqual([PERCENT_OPTION, TOKENS_OPTION, OFF_OPTION]);
  });

  it("percent_choice_returns_the_parsed_percent", async () => {
    const { ui } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "percent", value: 40 });
  });

  it("tokens_choice_returns_the_parsed_token_count", async () => {
    const { ui } = scriptedUi({ select: [TOKENS_OPTION], input: ["400k"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "tokens", value: 400_000 });
  });

  it("off_choice_returns_off_without_asking_for_a_value", async () => {
    const { ui, calls } = scriptedUi({ select: [OFF_OPTION] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "off", value: 0 });
    expect(calls.inputTitles).toEqual([]);
    expect(calls.notifications).toEqual([]);
  });

  it("cancel_at_the_mode_step_returns_undefined", async () => {
    const { ui, calls } = scriptedUi({ select: [undefined] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toBeUndefined();
    expect(calls.notifications).toEqual([]);
  });

  it("cancel_at_the_value_step_returns_undefined", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: [undefined] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toBeUndefined();
    expect(calls.notifications).toEqual([]);
  });

  it("unrecognised_mode_choice_returns_undefined", async () => {
    const { ui } = scriptedUi({ select: ["test/test-model"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toBeUndefined();
  });

  it("invalid_input_loops_with_the_reason_until_valid", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["abc", "-5%", "0", "95", "40"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "percent", value: 40 });
    expect(calls.inputTitles).toHaveLength(5);
    expect(calls.inputTitles[1]).toContain("enter a percent between 5 and 90, for example 40 or 40%");
    expect(calls.inputTitles[1]).not.toContain("token count");
    expect(calls.inputTitles[4]).toContain("percent must be between");
  });

  it("non_numeric_input_at_the_token_step_says_what_the_step_accepts", async () => {
    const { ui, calls } = scriptedUi({ select: [TOKENS_OPTION], input: ["abc", "400k"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "tokens", value: 400_000 });
    expect(calls.inputTitles[1]).toContain("enter a token count of at least 20000 and below the window, for example 400k");
    expect(calls.inputTitles[1]).not.toContain("percent");
  });

  it("input_in_the_wrong_mode_is_rejected", async () => {
    const tokens = scriptedUi({ select: [TOKENS_OPTION], input: ["40%", "off", "300k"] });
    expect(await askTrigger({ ui: tokens.ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "tokens", value: 300_000 });
    expect(tokens.calls.inputTitles).toHaveLength(3);
    const percent = scriptedUi({ select: [PERCENT_OPTION], input: ["400k", "off", "25%"] });
    expect(await askTrigger({ ui: percent.ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "percent", value: 25 });
    expect(percent.calls.inputTitles).toHaveLength(3);
  });

  it("hint_gives_the_value_per_model_for_modelOverrides_and_the_smallest_window_for_a_global_value", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    await askTrigger({ ui }, [model("p/big", 1_000_000), model("p/small", 200_000), model("p/big-twin", 1_000_000), model("p/big", 1_000_000)]);
    expect(calls.notifications).toEqual([
      'pi-lcm: to also set Pi\'s own threshold, use compaction.modelOverrides["<model>"].reserveTokens in settings.json: '
        + '["p/big"] = 600000 (1000000-token window); ["p/big-twin"] = 600000 (1000000-token window); ["p/small"] = 120000 (200000-token window). '
        + 'A single global compaction.reserveTokens is safe only at 120000, the value for your smallest known window (200000 tokens); a larger global value can make Pi compact after every turn on a smaller model.',
    ]);
  });

  it("hint_skips_models_the_token_trigger_cannot_fit_but_explains_the_global_value", async () => {
    const { ui, calls } = scriptedUi({ select: [TOKENS_OPTION], input: ["400k"] });
    await askTrigger({ ui }, [model("p/big", 1_000_000), model("p/small", 200_000)]);
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications[0]).toContain('["p/big"] = 600000 (1000000-token window)');
    expect(calls.notifications[0]).not.toContain('["p/small"]');
    expect(calls.notifications[0]).toContain("A single global compaction.reserveTokens is not safe, because the trigger does not fit your smallest known window (200000 tokens)");
  });

  it("hint_uses_the_keep_recent_floor", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["5"] });
    await askTrigger({ ui }, [model("p/m", 200_000)], 20_000);
    expect(calls.notifications[0]).toContain('["p/m"] = 160000 (200000-token window)');
    expect(calls.notifications[0]).toContain("safe only at 160000");
  });

  it("hint_explains_when_no_window_fits_the_token_trigger", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["90"] });
    await askTrigger({ ui }, [model("p/a", 40_000)], 20_000);
    expect(calls.notifications).toEqual([
      "pi-lcm: compaction.reserveTokens could not be computed because no known context window fits the trigger",
    ]);
  });

  it("hint_collapses_to_the_three_largest_models_plus_a_count_and_keeps_the_smallest_global_value", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    await askTrigger({ ui }, [model("p/128", 128_000), model("p/2m", 2_000_000), model("p/200", 200_000), model("p/1m", 1_000_000), model("p/400", 400_000)]);
    const hint = calls.notifications[0]!;
    expect(hint).toContain('["p/2m"] = 1200000');
    expect(hint).toContain('["p/1m"] = 600000');
    expect(hint).toContain('["p/400"] = 240000');
    expect(hint).not.toContain('["p/200"]');
    expect(hint).not.toContain('["p/128"]');
    expect(hint).toContain("and 2 more");
    expect(hint).toContain("safe only at 76800, the value for your smallest known window (128000 tokens)");
  });

  it("hint_lists_exactly_three_models_without_a_count", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    await askTrigger({ ui }, [model("p/a", 2_000_000), model("p/b", 1_000_000), model("p/c", 400_000)]);
    expect(calls.notifications[0]).not.toContain("more");
  });

  it("no_hint_when_no_window_is_known", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["40"] });
    expect(await askTrigger({ ui }, [])).toEqual({ mode: "percent", value: 40 });
    expect(calls.notifications).toEqual([]);
  });

  it("stops_after_five_invalid_answers_and_notifies", async () => {
    const { ui, calls } = scriptedUi({ select: [PERCENT_OPTION], input: ["a", "b", "c", "d", "e", "40"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toBeUndefined();
    expect(calls.inputTitles).toHaveLength(5);
    expect(calls.notifications).toEqual(["pi-lcm: too many invalid answers; compaction trigger unchanged"]);
  });

  it("a_valid_answer_on_the_fifth_try_is_accepted", async () => {
    const { ui } = scriptedUi({ select: [PERCENT_OPTION], input: ["a", "b", "c", "d", "40"] });
    expect(await askTrigger({ ui }, [model("p/big", 1_000_000)])).toEqual({ mode: "percent", value: 40 });
  });

  it("rejects_a_token_trigger_at_or_above_every_known_window_and_asks_again", async () => {
    const { ui, calls } = scriptedUi({ select: [TOKENS_OPTION], input: ["900k", "1m", "300k"] });
    const trigger = await askTrigger({ ui }, [model("p/a", 200_000), model("p/b", 900_000)]);
    expect(trigger).toEqual({ mode: "tokens", value: 300_000 });
    expect(calls.inputTitles).toHaveLength(3);
    expect(calls.inputTitles[1]).toContain("900000 tokens is not below your largest known context window (900000 tokens), so it could never fire");
    expect(calls.inputTitles[2]).toContain("1000000 tokens is not below your largest known context window (900000 tokens), so it could never fire");
  });

  it("accepts_a_token_trigger_below_the_largest_window", async () => {
    const { ui } = scriptedUi({ select: [TOKENS_OPTION], input: ["400k"] });
    expect(await askTrigger({ ui }, [model("p/a", 200_000), model("p/b", 900_000)])).toEqual({ mode: "tokens", value: 400_000 });
  });

  it("accepts_any_token_trigger_when_no_window_is_known", async () => {
    const { ui } = scriptedUi({ select: [TOKENS_OPTION], input: ["900k"] });
    expect(await askTrigger({ ui }, [])).toEqual({ mode: "tokens", value: 900_000 });
  });
});
