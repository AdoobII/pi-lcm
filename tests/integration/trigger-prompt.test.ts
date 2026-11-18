import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../../src/util/log.js", () => ({
  logError: vi.fn(),
  logWarn,
  logDebug: vi.fn(),
}));

import extension, { setTriggerSettleDelayMs } from "../../src/index.js";
import { createFakePi } from "../helpers/fake-pi.js";

const PERCENT_OPTION = "Percent of context window (suggested: 40%)";
const TOKENS_OPTION = "Number of tokens";
const OFF_OPTION = "Off (Pi's own threshold only)";
const MODEL_PICKER_TITLE = "pi-lcm summarizer model";

const SETTLE_DELAY_MS = 40;
const usageWindow = 200_000;

let cleanup: (() => void) | undefined;
const tempDirs: string[] = [];

afterEach(() => {
  logWarn.mockClear();
  cleanup?.();
  cleanup = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface BootOptions {
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  noModel?: boolean;
  env?: string;
  saved?: unknown;
  project?: unknown;
  usageTokens?: number;
  modes?: (string | undefined)[];
  values?: (string | undefined)[];
  extraModelWindows?: number[];
}

async function boot(options: BootOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-tp-"));
  tempDirs.push(cwd);
  setTriggerSettleDelayMs(SETTLE_DELAY_MS);
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const saved = { HOME: process.env.HOME, PI_LCM_MODEL: process.env.PI_LCM_MODEL, PI_LCM_DB_PATH: process.env.PI_LCM_DB_PATH, PI_LCM_COMPACT_TRIGGER: process.env.PI_LCM_COMPACT_TRIGGER };
  const home = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
  process.env.PI_LCM_DB_PATH = ":memory:";
  if (options.noModel) delete process.env.PI_LCM_MODEL;
  else process.env.PI_LCM_MODEL = "test/test-model";
  if (options.env !== undefined) process.env.PI_LCM_COMPACT_TRIGGER = options.env;
  else delete process.env.PI_LCM_COMPACT_TRIGGER;
  cleanup = () => {
    setTriggerSettleDelayMs(1000);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const lcmFile = join(home, ".pi", "agent", "lcm.json");
  if (options.saved !== undefined) {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(lcmFile, typeof options.saved === "string" ? options.saved : JSON.stringify(options.saved));
  }
  if (options.project !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "lcm.json"), JSON.stringify(options.project));
  }

  const modes = [...(options.modes ?? [])];
  const values = [...(options.values ?? [])];
  const asked = { selects: 0, inputs: 0, pickers: 0 };
  const notifications: string[] = [];
  const compactCalls: unknown[] = [];
  const fake = createFakePi({
    cwd,
    getContextUsage: () => ({ tokens: options.usageTokens ?? 0, contextWindow: usageWindow, percent: null }),
    compact: (compactOptions) => compactCalls.push(compactOptions),
    hasUI: options.hasUI ?? true,
    mode: options.mode,
    extraModelWindows: options.extraModelWindows,
    notify: (message) => notifications.push(message),
    select: async (title) => {
      if (title === MODEL_PICKER_TITLE) {
        asked.pickers++;
        return "test/test-model";
      }
      asked.selects++;
      return modes.shift();
    },
    input: async () => {
      asked.inputs++;
      return values.shift();
    },
  });
  await extension(fake.api);
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  const readSaved = () => (existsSync(lcmFile) ? JSON.parse(readFileSync(lcmFile, "utf-8")) : null);
  const compactsAtSettle = async () => {
    compactCalls.length = 0;
    await fake.emit("agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS + 40));
    return compactCalls.length > 0;
  };
  return { fake, asked, notifications, readSaved, lcmFile, home, compactsAtSettle };
}

describe("first-run trigger prompt", () => {
  it("first_run_asks_when_unset", async () => {
    const { asked, readSaved, notifications } = await boot({ modes: [PERCENT_OPTION], values: ["40"] });
    expect(asked.selects).toBe(1);
    expect(readSaved().compactionTrigger).toEqual({ mode: "percent", value: 40 });
    expect(notifications.some((m) => m.includes("reserveTokens"))).toBe(true);
  });

  it("does_not_ask_when_saved_or_off", async () => {
    for (const trigger of [{ mode: "percent", value: 30 }, { mode: "off", value: 0 }]) {
      const { asked } = await boot({ saved: { compactionTrigger: trigger } });
      expect(asked.selects, JSON.stringify(trigger)).toBe(0);
      cleanup?.();
    }
  });

  it("off_choice_is_saved_so_it_is_not_asked_again", async () => {
    const { readSaved, lcmFile } = await boot({ modes: [OFF_OPTION] });
    expect(readSaved().compactionTrigger).toEqual({ mode: "off", value: 0 });
    cleanup?.();
    const again = await boot({ saved: JSON.parse(readFileSync(lcmFile, "utf-8")) });
    expect(again.asked.selects).toBe(0);
  });

  it("does_not_ask_when_a_valid_env_override_is_set", async () => {
    for (const env of ["40%", "off"]) {
      const { asked, readSaved } = await boot({ env });
      expect(asked.selects, env).toBe(0);
      expect(readSaved()?.compactionTrigger).toBeUndefined();
      cleanup?.();
    }
  });

  it("cancel_saves_nothing", async () => {
    const atMode = await boot({ modes: [undefined] });
    expect(atMode.asked.selects).toBe(1);
    expect(atMode.readSaved()?.compactionTrigger).toBeUndefined();
    cleanup?.();
    const atValue = await boot({ modes: [PERCENT_OPTION], values: [undefined] });
    expect(atValue.asked.inputs).toBe(1);
    expect(atValue.readSaved()?.compactionTrigger).toBeUndefined();
  });

  it("invalid_then_valid_input_loops_and_saves_once", async () => {
    const { asked, readSaved } = await boot({ modes: [TOKENS_OPTION], values: ["abc", "1", "150k"] });
    expect(asked.inputs).toBe(3);
    expect(readSaved().compactionTrigger).toEqual({ mode: "tokens", value: 150_000 });
  });

  it("headless_never_prompts", async () => {
    const { asked, readSaved } = await boot({ hasUI: false });
    expect(asked).toEqual({ selects: 0, inputs: 0, pickers: 0 });
    expect(readSaved()?.compactionTrigger).toBeUndefined();
    const warnings = logWarn.mock.calls.filter(([message]) => String(message).includes("compaction trigger"));
    expect(warnings).toHaveLength(1);
  });

  it("headless_with_a_saved_choice_logs_no_trigger_warning", async () => {
    await boot({ hasUI: false, saved: { compactionTrigger: { mode: "off", value: 0 } } });
    expect(logWarn.mock.calls.filter(([message]) => String(message).includes("compaction trigger"))).toHaveLength(0);
  });

  it("reserve_tokens_hint_is_notified_per_model", async () => {
    const { notifications } = await boot({ modes: [PERCENT_OPTION], values: ["40"], extraModelWindows: [1_000_000] });
    const hint = notifications.find((m) => m.includes("reserveTokens"))!;
    expect(hint).toContain('["test/extra-0"] = 600000 (1000000-token window)');
    expect(hint).toContain('["test/test-model"] = 120000 (200000-token window)');
    expect(hint).toContain("A single global compaction.reserveTokens is safe only at 120000, the value for your smallest known window (200000 tokens)");
  });

  it("save_failure_notifies_and_applies_for_session", async () => {
    const { fake, notifications, home, compactsAtSettle } = await boot({ saved: { compactionTrigger: { mode: "off", value: 0 } }, usageTokens: 60_000 });
    expect(await compactsAtSettle()).toBe(false);
    // Replace the config directory with a file so the save fails.
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    writeFileSync(join(home, ".pi"), "blocked");
    const choices = { modes: [PERCENT_OPTION], values: ["25"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(notifications.some((m) => m.startsWith("pi-lcm: could not save the trigger choice to ") && m.endsWith("; it applies for this session only"))).toBe(true);
    expect(notifications.some((m) => m.includes("25%"))).toBe(true);
    // 25% of the 200000-token window is 50000, so 60000 tokens compacts only if the session took the trigger.
    expect(await compactsAtSettle()).toBe(true);
  });

  it("unparseable_lcm_json_is_not_overwritten_and_the_choice_applies_for_the_session", async () => {
    const { notifications, lcmFile, compactsAtSettle } = await boot({ saved: "{ not json", modes: [PERCENT_OPTION], values: ["25"], usageTokens: 60_000 });
    expect(notifications).toContain("pi-lcm: lcm.json is not valid JSON; fix or remove it, choice applies for this session only");
    expect(notifications.some((m) => m.startsWith("pi-lcm: could not save the trigger choice"))).toBe(false);
    expect(readFileSync(lcmFile, "utf-8")).toBe("{ not json");
    expect(await compactsAtSettle()).toBe(true);
  });
});

describe("dialogs outside the interactive terminal", () => {
  it("rpc_with_a_ui_never_asks_either_dialog_at_session_start_and_warns_once_per_gap", async () => {
    const { asked, notifications, readSaved } = await boot({ hasUI: true, mode: "rpc", noModel: true });
    expect(asked).toEqual({ selects: 0, inputs: 0, pickers: 0 });
    expect(notifications).toEqual([]);
    expect(readSaved()?.compactionTrigger).toBeUndefined();
    expect(logWarn.mock.calls.filter(([m]) => String(m).includes("compaction trigger"))).toHaveLength(1);
    expect(logWarn.mock.calls.filter(([m]) => String(m).includes("summarizer model"))).toHaveLength(1);
  });

  it("print_and_json_never_ask_either_dialog", async () => {
    for (const mode of ["print", "json"] as const) {
      for (const hasUI of [false, true]) {
        const { asked, notifications } = await boot({ hasUI, mode, noModel: true });
        expect(asked, `${mode} hasUI=${hasUI}`).toEqual({ selects: 0, inputs: 0, pickers: 0 });
        expect(notifications).toEqual([]);
        cleanup?.();
      }
    }
  });

  it("tui_still_asks_the_model_picker_and_the_trigger_prompt", async () => {
    const { asked, readSaved } = await boot({ hasUI: true, mode: "tui", noModel: true, modes: [PERCENT_OPTION], values: ["40"] });
    expect(asked.pickers).toBe(1);
    expect(asked.selects).toBe(1);
    expect(readSaved().model).toBe("test/test-model");
    expect(readSaved().compactionTrigger).toEqual({ mode: "percent", value: 40 });
  });

  it("rpc_commands_still_prompt_when_invoked", async () => {
    const { fake, readSaved, asked } = await boot({ hasUI: true, mode: "rpc", noModel: true });
    const choices = { modes: [TOKENS_OPTION], values: ["150k"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async (title: string) => (title === MODEL_PICKER_TITLE ? "test/test-model" : choices.modes.shift());
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    await fake.commands.get("lcm-model")!.handler("", fake.context);
    expect(readSaved().compactionTrigger).toEqual({ mode: "tokens", value: 150_000 });
    expect(readSaved().model).toBe("test/test-model");
    expect(asked.selects).toBe(0);
  });
});

describe("invalid PI_LCM_COMPACT_TRIGGER", () => {
  it("warns_once_logs_and_notifies_then_the_tui_prompt_runs_as_if_unset", async () => {
    const { asked, notifications, readSaved } = await boot({ env: "40", modes: [PERCENT_OPTION], values: ["30"] });
    expect(logWarn.mock.calls.filter(([m]) => String(m).includes("PI_LCM_COMPACT_TRIGGER"))).toHaveLength(1);
    expect(notifications.filter((m) => m.includes("PI_LCM_COMPACT_TRIGGER"))).toHaveLength(1);
    expect(asked.selects).toBe(1);
    expect(readSaved().compactionTrigger).toEqual({ mode: "percent", value: 30 });
  });

  it("falls_back_to_the_saved_layer_without_prompting", async () => {
    const { asked, compactsAtSettle } = await boot({ env: "garbage", saved: { compactionTrigger: { mode: "percent", value: 25 } }, usageTokens: 60_000 });
    expect(asked.selects).toBe(0);
    expect(await compactsAtSettle()).toBe(true);
  });

  it("headless_logs_the_warning_but_notifies_nothing", async () => {
    const { notifications, asked } = await boot({ hasUI: false, env: "", saved: { compactionTrigger: { mode: "off", value: 0 } } });
    expect(logWarn.mock.calls.filter(([m]) => String(m).includes("PI_LCM_COMPACT_TRIGGER"))).toHaveLength(1);
    expect(notifications).toEqual([]);
    expect(asked.selects).toBe(0);
  });

  it("a_valid_env_value_logs_no_env_warning", async () => {
    await boot({ env: "40%" });
    expect(logWarn.mock.calls.filter(([m]) => String(m).includes("PI_LCM_COMPACT_TRIGGER"))).toHaveLength(0);
  });

  it("lcm_trigger_does_not_claim_the_env_wins_and_applies_to_the_session", async () => {
    const { fake, notifications, compactsAtSettle } = await boot({ env: "garbage", hasUI: true, mode: "tui", modes: [undefined], usageTokens: 60_000 });
    expect(await compactsAtSettle()).toBe(false);
    notifications.length = 0;
    const choices = { modes: [PERCENT_OPTION], values: ["25"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(notifications.some((m) => m.includes("overrides"))).toBe(false);
    expect(notifications).toContain("pi-lcm: compaction trigger set to 25% of the context window");
    expect(await compactsAtSettle()).toBe(true);
  });
});

describe("save failures", () => {
  it("unreadable_lcm_json_gets_a_distinct_notice", async () => {
    const { fake, home, notifications } = await boot({ saved: { compactionTrigger: { mode: "off", value: 0 } } });
    rmSync(join(home, ".pi", "agent", "lcm.json"));
    mkdirSync(join(home, ".pi", "agent", "lcm.json"));
    const choices = { modes: [PERCENT_OPTION], values: ["25"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(notifications.some((m) => m.startsWith("pi-lcm: could not read lcm.json"))).toBe(true);
    expect(notifications.some((m) => m.includes("not valid JSON"))).toBe(false);
  });

  it("model_choice_save_failure_is_notified_at_session_start_and_by_the_command", async () => {
    const { notifications, fake, home } = await boot({ hasUI: true, noModel: true, saved: "{ not json", modes: [OFF_OPTION] });
    expect(notifications).toContain("pi-lcm: lcm.json is not valid JSON; fix or remove it, choice applies for this session only");
    notifications.length = 0;
    const ctx = fake.context as unknown as { ui: { select: unknown } };
    ctx.ui.select = async () => "test/test-model";
    await fake.commands.get("lcm-model")!.handler("", fake.context);
    expect(notifications.some((m) => m.includes("not valid JSON"))).toBe(true);
    expect(readFileSync(join(home, ".pi", "agent", "lcm.json"), "utf-8")).toBe("{ not json");
  });
});

describe("/lcm-trigger", () => {
  it("command_reruns_the_prompt_and_replaces_the_choice", async () => {
    const { fake, readSaved } = await boot({ saved: { compactionTrigger: { mode: "percent", value: 30 }, futureKey: 1 } });
    const choices = { modes: [TOKENS_OPTION], values: ["150k"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(readSaved().compactionTrigger).toEqual({ mode: "tokens", value: 150_000 });
    expect(readSaved().futureKey).toBe(1);
  });

  it("command_cancel_keeps_the_saved_choice", async () => {
    const { fake, readSaved } = await boot({ saved: { compactionTrigger: { mode: "percent", value: 30 } } });
    const ctx = fake.context as unknown as { ui: { select: unknown } };
    ctx.ui.select = async () => undefined;
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(readSaved().compactionTrigger).toEqual({ mode: "percent", value: 30 });
  });

  it("command_with_the_env_override_warns_that_it_wins", async () => {
    const { fake, notifications } = await boot({ env: "40%" });
    const choices = { modes: [OFF_OPTION] };
    const ctx = fake.context as unknown as { ui: { select: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(notifications.some((m) => m.includes("PI_LCM_COMPACT_TRIGGER") && m.includes("overrides"))).toBe(true);
  });

  it("command_with_a_project_trigger_saves_globally_keeps_the_session_and_warns", async () => {
    const { fake, notifications, readSaved, compactsAtSettle } = await boot({
      project: { compactionTrigger: { mode: "percent", value: 80 } },
      usageTokens: 60_000,
    });
    expect(await compactsAtSettle()).toBe(false);
    const choices = { modes: [PERCENT_OPTION], values: ["25"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(readSaved().compactionTrigger).toEqual({ mode: "percent", value: 25 });
    expect(notifications.some((m) => m.includes(".pi") && m.includes("lcm.json") && m.includes("overrides") && m.includes("25%"))).toBe(true);
    expect(notifications.some((m) => m === "pi-lcm: compaction trigger set to 25% of the context window")).toBe(false);
    expect(await compactsAtSettle()).toBe(false);
  });
});
