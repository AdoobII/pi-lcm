import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../../src/index.js";
import { DEFAULT_COMPACTION_FOCUS } from "../../src/compact/prompts.js";
import { createFakePi } from "../helpers/fake-pi.js";

type CompactOptions = { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void };

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

interface BootOptions {
  trigger?: string;
  model?: string | null;
  hasUI?: boolean;
  tokens?: () => number | null;
  contextWindow?: number;
  settings?: unknown;
  usageThrows?: boolean;
  compactThrows?: boolean;
}

async function boot(options: BootOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-trigger-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const saved = {
    HOME: process.env.HOME,
    PI_LCM_MODEL: process.env.PI_LCM_MODEL,
    PI_LCM_DB_PATH: process.env.PI_LCM_DB_PATH,
    PI_LCM_COMPACT_TRIGGER: process.env.PI_LCM_COMPACT_TRIGGER,
  };
  process.env.HOME = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  process.env.PI_LCM_DB_PATH = ":memory:";
  if (options.model === null) delete process.env.PI_LCM_MODEL;
  else process.env.PI_LCM_MODEL = options.model ?? "test/test-model";
  if (options.trigger) process.env.PI_LCM_COMPACT_TRIGGER = options.trigger;
  else delete process.env.PI_LCM_COMPACT_TRIGGER;
  cleanup = () => {
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
    settle: () => fake.emit("agent_settled", { type: "agent_settled" }),
    settleStrict: () => fake.emitStrict("agent_settled", { type: "agent_settled" }),
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
    expect(compactCalls).toHaveLength(2);
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
    expect(compactCalls).toHaveLength(3);
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
});
