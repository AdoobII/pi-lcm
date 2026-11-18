import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension, { setTriggerSettleDelayMs } from "../../src/index.js";
import { DEFAULT_COMPACTION_FOCUS } from "../../src/compact/prompts.js";
import { createFakePi } from "../helpers/fake-pi.js";

type CompactOptions = { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void };

let cleanup: (() => void) | undefined;

const SETTLE_DELAY_MS = 40;

afterEach(() => {
  vi.restoreAllMocks();
  cleanup?.();
  cleanup = undefined;
});

interface BootOptions {
  trigger?: string;
  model?: string | null;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  isIdle?: () => boolean;
  hasPendingMessages?: () => boolean;
  tokens?: () => number | null;
  contextWindow?: number;
  settings?: unknown;
  usageThrows?: boolean;
  compactThrows?: boolean;
  triggerInRpc?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits past the settle delay so the scheduled trigger check has run.
function deferredTick(): Promise<void> {
  return sleep(SETTLE_DELAY_MS + 40);
}

async function boot(options: BootOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-trigger-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const saved = {
    HOME: process.env.HOME,
    PI_LCM_MODEL: process.env.PI_LCM_MODEL,
    PI_LCM_DB_PATH: process.env.PI_LCM_DB_PATH,
    PI_LCM_COMPACT_TRIGGER: process.env.PI_LCM_COMPACT_TRIGGER,
    PI_LCM_TRIGGER_IN_RPC: process.env.PI_LCM_TRIGGER_IN_RPC,
  };
  setTriggerSettleDelayMs(SETTLE_DELAY_MS);
  process.env.HOME = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  process.env.PI_LCM_DB_PATH = ":memory:";
  if (options.model === null) delete process.env.PI_LCM_MODEL;
  else process.env.PI_LCM_MODEL = options.model ?? "test/test-model";
  if (options.trigger) process.env.PI_LCM_COMPACT_TRIGGER = options.trigger;
  else delete process.env.PI_LCM_COMPACT_TRIGGER;
  if (options.triggerInRpc) process.env.PI_LCM_TRIGGER_IN_RPC = "1";
  else delete process.env.PI_LCM_TRIGGER_IN_RPC;
  cleanup = () => {
    setTriggerSettleDelayMs(1000);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const compactCalls: CompactOptions[] = [];
  const notifications: string[] = [];
  const fake = createFakePi({
    cwd,
    hasUI: options.hasUI ?? false,
    mode: options.mode,
    isIdle: options.isIdle,
    hasPendingMessages: options.hasPendingMessages,
    settings: options.settings,
    notify: (message) => notifications.push(message),
    getContextUsage: () => {
      if (options.usageThrows) throw new Error("usage boom");
      return { tokens: (options.tokens ?? (() => 0))(), contextWindow: options.contextWindow ?? 1_000_000, percent: null };
    },
    compact: (compactOptions) => {
      compactCalls.push(compactOptions);
      if (options.compactThrows) throw new Error("compact boom");
    },
  });
  await extension(fake.api);
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  return {
    fake,
    compactCalls,
    notifications,
    settle: async () => {
      await fake.emit("agent_settled", { type: "agent_settled" });
      await deferredTick();
    },
    settleStrict: async () => {
      await fake.emitStrict("agent_settled", { type: "agent_settled" });
      await deferredTick();
    },
    emitSettledOnly: () => fake.emit("agent_settled", { type: "agent_settled" }),
    deferredTick,
  };
}

describe("agent_settled trigger", () => {
  it("integration_agent_settled_calls_compact_once_with_focus", async () => {
    const { compactCalls, settle } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await settle();
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]!.customInstructions).toBe(DEFAULT_COMPACTION_FOCUS);
    await settle();
    expect(compactCalls).toHaveLength(1);
    compactCalls[0]!.onComplete!({});
    await settle();
    expect(compactCalls).toHaveLength(1);
  });

  it("does_not_compact_without_trigger_below_threshold_or_model", async () => {
    const noTrigger = await boot({ tokens: () => 900_000 });
    await noTrigger.settle();
    expect(noTrigger.compactCalls).toHaveLength(0);

    const below = await boot({ trigger: "40%", tokens: () => 399_999 });
    await below.settle();
    expect(below.compactCalls).toHaveLength(0);

    const noModel = await boot({ trigger: "40%", model: null, tokens: () => 900_000 });
    await noModel.settle();
    expect(noModel.compactCalls).toHaveLength(0);

    const nullTokens = await boot({ trigger: "40%", tokens: () => null });
    await nullTokens.settle();
    expect(nullTokens.compactCalls).toHaveLength(0);
  });

  it("error_backs_off_until_ten_percent_more_then_success_clears", async () => {
    let tokens = 450_000;
    const { compactCalls, settle } = await boot({ trigger: "40%", tokens: () => tokens });
    await settle();
    compactCalls[0]!.onError!(new Error("fail"));
    await settle();
    expect(compactCalls).toHaveLength(1);
    tokens = 549_999;
    await settle();
    expect(compactCalls).toHaveLength(1);
    tokens = 550_000;
    await settle();
    expect(compactCalls).toHaveLength(2);
    compactCalls[1]!.onComplete!({});
    tokens = 450_000;
    await settle();
    expect(compactCalls).toHaveLength(2);
  });

  it("reads_keep_recent_tokens_from_settings", async () => {
    const floored = await boot({ trigger: "20k", tokens: () => 50_000, settings: { compaction: { keepRecentTokens: 30000 } } });
    await floored.settle();
    expect(floored.compactCalls).toHaveLength(0);
    const defaulted = await boot({ trigger: "20k", tokens: () => 50_000 });
    await defaulted.settle();
    expect(defaulted.compactCalls).toHaveLength(1);
  });

  it("notifies_only_when_ui_exists", async () => {
    const ui = await boot({ trigger: "40%", hasUI: true, tokens: () => 450_000, model: "test/test-model" });
    await ui.settle();
    expect(ui.notifications).toContain("pi-lcm: compacting at 450000 of 1000000 tokens (threshold 400000)");
    const headless = await boot({ trigger: "40%", tokens: () => 450_000 });
    await headless.settle();
    expect(headless.notifications).toHaveLength(0);
    expect(headless.compactCalls).toHaveLength(1);
  });

  it("throwing_usage_or_compact_does_not_break_agent_settled", async () => {
    const usage = await boot({ trigger: "40%", usageThrows: true, tokens: () => 450_000 });
    await expect(usage.settleStrict()).resolves.toBeUndefined();
    expect(usage.compactCalls).toHaveLength(0);

    const compact = await boot({ trigger: "40%", compactThrows: true, tokens: () => 450_000 });
    await expect(compact.settleStrict()).resolves.toBeUndefined();
    expect(compact.compactCalls).toHaveLength(1);
    await expect(compact.settleStrict()).resolves.toBeUndefined();
    expect(compact.compactCalls).toHaveLength(1);
  });

  it("session_start_resets_pending_request_and_failure", async () => {
    const { fake, compactCalls, settle } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await settle();
    expect(compactCalls).toHaveLength(1);
    await fake.emit("session_start", { type: "session_start", reason: "new" });
    await settle();
    expect(compactCalls).toHaveLength(2);
    compactCalls[1]!.onError!(new Error("fail"));
    await fake.emit("session_start", { type: "session_start", reason: "new" });
    await settle();
    expect(compactCalls).toHaveLength(3);
  });

  it("success_below_threshold_allows_next_trigger_later", async () => {
    let tokens = 450_000;
    const { compactCalls, notifications, settle } = await boot({ trigger: "40%", hasUI: true, tokens: () => tokens });
    await settle();
    compactCalls[0]!.onComplete!({});
    tokens = 100_000;
    await settle();
    expect(compactCalls).toHaveLength(1);
    tokens = 450_000;
    await settle();
    expect(compactCalls).toHaveLength(2);
    expect(notifications.filter((message) => message.includes("above the trigger"))).toHaveLength(0);
  });

  it("success_still_above_threshold_backs_off_once_and_notifies", async () => {
    let tokens = 450_000;
    const { compactCalls, notifications, settle } = await boot({ trigger: "40%", hasUI: true, tokens: () => tokens });
    await settle();
    compactCalls[0]!.onComplete!({});
    tokens = 450_000;
    await settle();
    await settle();
    expect(compactCalls).toHaveLength(1);
    const warning = "pi-lcm: compaction left usage above the trigger; waiting for 10% more growth";
    expect(notifications.filter((message) => message === warning)).toHaveLength(1);
    tokens = 549_999;
    await settle();
    expect(compactCalls).toHaveLength(1);
    tokens = 550_000;
    await settle();
    expect(compactCalls).toHaveLength(2);
  });

  it("null_usage_after_success_keeps_post_compaction_check_pending", async () => {
    let tokens: number | null = 450_000;
    const { compactCalls, settle } = await boot({ trigger: "40%", tokens: () => tokens });
    await settle();
    compactCalls[0]!.onComplete!({});
    tokens = null;
    await settle();
    tokens = 450_000;
    await settle();
    expect(compactCalls).toHaveLength(1);
  });

  it("deferred_prompt_queued_at_settle_prevents_compaction", async () => {
    let pending = true;
    const { compactCalls, emitSettledOnly, deferredTick } = await boot({
      trigger: "40%",
      tokens: () => 450_000,
      hasPendingMessages: () => pending,
    });
    await emitSettledOnly();
    await deferredTick();
    expect(compactCalls).toHaveLength(0);
    pending = false;
    await emitSettledOnly();
    await deferredTick();
    expect(compactCalls).toHaveLength(1);
  });

  it("not_idle_at_deferred_check_skips_this_settle", async () => {
    let idle = false;
    const { compactCalls, settle } = await boot({ trigger: "40%", tokens: () => 450_000, isIdle: () => idle });
    await settle();
    expect(compactCalls).toHaveLength(0);
    idle = true;
    await settle();
    expect(compactCalls).toHaveLength(1);
  });

  it("print_json_and_rpc_modes_are_skipped_by_default", async () => {
    for (const mode of ["print", "json", "rpc"] as const) {
      const run = await boot({ trigger: "40%", mode, tokens: () => 900_000 });
      await run.settle();
      expect(run.compactCalls).toHaveLength(0);
    }
  });

  it("rpc_mode_compacts_only_with_trigger_in_rpc_env", async () => {
    const run = await boot({ trigger: "40%", mode: "rpc", triggerInRpc: true, tokens: () => 900_000 });
    await run.settle();
    expect(run.compactCalls).toHaveLength(1);
  });

  it("print_and_json_modes_never_compact_even_with_trigger_in_rpc_env", async () => {
    for (const mode of ["print", "json"] as const) {
      const run = await boot({ trigger: "40%", mode, triggerInRpc: true, tokens: () => 900_000 });
      await run.settle();
      expect(run.compactCalls).toHaveLength(0);
    }
  });

  it("later_settled_handler_that_awaits_then_becomes_busy_prevents_compaction", async () => {
    let idle = true;
    const { fake, compactCalls, emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000, isIdle: () => idle });
    fake.api.on("agent_settled", async () => {
      await sleep(SETTLE_DELAY_MS / 4);
      idle = false;
    });
    await emitSettledOnly();
    await deferredTick();
    expect(compactCalls).toHaveLength(0);
  });

  it("later_settled_handler_that_awaits_then_starts_activity_prevents_compaction", async () => {
    for (const activity of ["input", "before_agent_start", "agent_start"]) {
      const { fake, compactCalls, emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000 });
      fake.api.on("agent_settled", async () => {
        await sleep(SETTLE_DELAY_MS / 4);
        await fake.emit(activity, { type: activity, messageType: "user", prompt: "next", text: "next" });
      });
      await emitSettledOnly();
      await deferredTick();
      expect(compactCalls, activity).toHaveLength(0);
    }
  });

  it("activity_before_delay_elapses_skips_and_next_settle_reevaluates", async () => {
    const { fake, compactCalls, emitSettledOnly, deferredTick, settle } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    await fake.emit("agent_start", { type: "agent_start" });
    await deferredTick();
    expect(compactCalls).toHaveLength(0);
    await settle();
    expect(compactCalls).toHaveLength(1);
  });

  it("activity_handlers_do_not_alter_pi_behaviour", async () => {
    const { fake } = await boot({ trigger: "40%" });
    expect(await fake.emit("input", { type: "input", text: "hi", source: "interactive" })).toBeUndefined();
    expect(await fake.emit("agent_start", { type: "agent_start" })).toBeUndefined();
  });

  it("session_shutdown_clears_timer_and_bumps_epoch", async () => {
    const { fake, compactCalls, emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(clear).toHaveBeenCalled();
    await deferredTick();
    expect(compactCalls).toHaveLength(0);
  });

  it("session_start_clears_pending_timer", async () => {
    const { fake, emitSettledOnly } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await fake.emit("session_start", { type: "session_start", reason: "new" });
    expect(clear).toHaveBeenCalled();
  });

  it("trigger_timer_is_unreffed", async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      const original = timer.unref.bind(timer);
      timer.unref = () => { unref(); return original(); };
      return timer;
    }) as unknown as typeof setTimeout);
    const { emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    spy.mockRestore();
    await deferredTick();
    expect(unref).toHaveBeenCalled();
  });

  it("compaction_starts_after_the_settle_emission_returns", async () => {
    const { compactCalls, emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    expect(compactCalls).toHaveLength(0);
    await deferredTick();
    expect(compactCalls).toHaveLength(1);
  });

  it("session_start_between_settle_and_deferred_check_cancels_compaction", async () => {
    const { fake, compactCalls, emitSettledOnly, deferredTick } = await boot({ trigger: "40%", tokens: () => 450_000 });
    await emitSettledOnly();
    await fake.emit("session_start", { type: "session_start", reason: "new" });
    await deferredTick();
    expect(compactCalls).toHaveLength(0);
  });
});
