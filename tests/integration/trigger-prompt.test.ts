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

import extension from "../../src/index.js";
import { createFakePi } from "../helpers/fake-pi.js";

const PERCENT_OPTION = "Percent of context window (suggested: 40%)";
const TOKENS_OPTION = "Number of tokens";
const OFF_OPTION = "Off (Pi's own threshold only)";
const MODEL_PICKER_TITLE = "pi-lcm summarizer model";

let cleanup: (() => void) | undefined;

afterEach(() => {
  logWarn.mockClear();
  cleanup?.();
  cleanup = undefined;
});

interface BootOptions {
  hasUI?: boolean;
  env?: string;
  saved?: unknown;
  modes?: (string | undefined)[];
  values?: (string | undefined)[];
  extraModelWindows?: number[];
}

async function boot(options: BootOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-tp-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const saved = { HOME: process.env.HOME, PI_LCM_MODEL: process.env.PI_LCM_MODEL, PI_LCM_DB_PATH: process.env.PI_LCM_DB_PATH, PI_LCM_COMPACT_TRIGGER: process.env.PI_LCM_COMPACT_TRIGGER };
  const home = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  process.env.HOME = home;
  process.env.PI_LCM_DB_PATH = ":memory:";
  process.env.PI_LCM_MODEL = "test/test-model";
  if (options.env !== undefined) process.env.PI_LCM_COMPACT_TRIGGER = options.env;
  else delete process.env.PI_LCM_COMPACT_TRIGGER;
  cleanup = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const lcmFile = join(home, ".pi", "agent", "lcm.json");
  if (options.saved !== undefined) {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(lcmFile, JSON.stringify(options.saved));
  }

  const modes = [...(options.modes ?? [])];
  const values = [...(options.values ?? [])];
  const asked = { selects: 0, inputs: 0 };
  const notifications: string[] = [];
  const fake = createFakePi({
    cwd,
    hasUI: options.hasUI ?? true,
    extraModelWindows: options.extraModelWindows,
    notify: (message) => notifications.push(message),
    select: async (title) => {
      if (title === MODEL_PICKER_TITLE) return "test/test-model";
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
  return { fake, asked, notifications, readSaved, lcmFile, home };
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

  it("does_not_ask_when_the_env_override_is_set", async () => {
    for (const env of ["40%", "garbage"]) {
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
    const { asked, readSaved } = await boot({ modes: [TOKENS_OPTION], values: ["abc", "1", "400k"] });
    expect(asked.inputs).toBe(3);
    expect(readSaved().compactionTrigger).toEqual({ mode: "tokens", value: 400_000 });
  });

  it("headless_never_prompts", async () => {
    const { asked, readSaved } = await boot({ hasUI: false });
    expect(asked).toEqual({ selects: 0, inputs: 0 });
    expect(readSaved()?.compactionTrigger).toBeUndefined();
    const warnings = logWarn.mock.calls.filter(([message]) => String(message).includes("compaction trigger"));
    expect(warnings).toHaveLength(1);
  });

  it("headless_with_a_saved_choice_logs_no_trigger_warning", async () => {
    await boot({ hasUI: false, saved: { compactionTrigger: { mode: "off", value: 0 } } });
    expect(logWarn.mock.calls.filter(([message]) => String(message).includes("compaction trigger"))).toHaveLength(0);
  });

  it("reserve_tokens_hint_is_notified", async () => {
    const { notifications } = await boot({ modes: [PERCENT_OPTION], values: ["40"], extraModelWindows: [1_000_000] });
    expect(notifications).toContain(
      "For Pi's own settings.json: reserveTokens 600000 for a 1000000-token window; reserveTokens 120000 for a 200000-token window",
    );
  });

  it("save_failure_notifies_and_applies_for_session", async () => {
    const { fake, notifications, home } = await boot({ saved: { compactionTrigger: { mode: "off", value: 0 } } });
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
  });
});

describe("/lcm-trigger", () => {
  it("command_reruns_the_prompt_and_replaces_the_choice", async () => {
    const { fake, readSaved } = await boot({ saved: { compactionTrigger: { mode: "percent", value: 30 }, futureKey: 1 } });
    const choices = { modes: [TOKENS_OPTION], values: ["300k"] };
    const ctx = fake.context as unknown as { ui: { select: unknown; input: unknown } };
    ctx.ui.select = async () => choices.modes.shift();
    ctx.ui.input = async () => choices.values.shift();
    await fake.commands.get("lcm-trigger")!.handler("", fake.context);
    expect(readSaved().compactionTrigger).toEqual({ mode: "tokens", value: 300_000 });
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
});
