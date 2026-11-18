import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, saveModelChoice, saveTriggerChoice } from "../../src/config.js";
import { DEFAULT_COMPACTION_FOCUS } from "../../src/compact/prompts.js";

let home: string;
let projectRoot: string;
let previousHome: string | undefined;

function globalFile(): string {
  return join(home, ".pi", "agent", "lcm.json");
}

function writeGlobal(value: unknown): void {
  writeFileSync(globalFile(), typeof value === "string" ? value : JSON.stringify(value));
}

function writeProject(value: unknown): void {
  mkdirSync(join(projectRoot, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(join(projectRoot, CONFIG_DIR_NAME, "lcm.json"), JSON.stringify(value));
}

function load(env: NodeJS.ProcessEnv = {}) {
  return loadConfig({ projectRoot, env, trusted: false });
}

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "pi-lcm-cfg-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "pi-lcm-cfg-proj-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe("compactionTrigger config", () => {
  it("trigger_defaults_to_null", () => {
    expect(DEFAULT_CONFIG.compactionTrigger).toBeNull();
    expect(load().compactionTrigger).toBeNull();
  });

  it("trigger_reads_valid_file_values", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    expect(load().compactionTrigger).toEqual({ mode: "percent", value: 40 });
    writeGlobal({ compactionTrigger: { mode: "tokens", value: 400000 } });
    expect(load().compactionTrigger).toEqual({ mode: "tokens", value: 400000 });
    writeGlobal({ compactionTrigger: { mode: "off", value: 0 } });
    expect(load().compactionTrigger).toEqual({ mode: "off", value: 0 });
  });

  it("trigger_invalid_file_values_fall_back_to_null", () => {
    const bad: unknown[] = [
      "40%", 40, [], { mode: "percent" }, { mode: "percent", value: "40" }, { mode: "weird", value: 40 },
      { mode: "percent", value: 4 }, { mode: "percent", value: 95 }, { mode: "tokens", value: 10000 },
      { mode: "tokens", value: null }, { mode: "percent", value: Number.MAX_VALUE * 10 },
    ];
    for (const value of bad) {
      writeGlobal({ compactionTrigger: value, model: "m" });
      const config = load();
      expect(config.compactionTrigger, JSON.stringify(value)).toBeNull();
      expect(config.model).toBe("m");
    }
  });

  it("trigger_env_override_beats_file", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    expect(load({ PI_LCM_COMPACT_TRIGGER: "400k" }).compactionTrigger).toEqual({ mode: "tokens", value: 400000 });
    expect(load({ PI_LCM_COMPACT_TRIGGER: "55%" }).compactionTrigger).toEqual({ mode: "percent", value: 55 });
    expect(load({ PI_LCM_COMPACT_TRIGGER: "400000" }).compactionTrigger).toEqual({ mode: "tokens", value: 400000 });
  });

  it("trigger_env_off_gives_mode_off", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    expect(load({ PI_LCM_COMPACT_TRIGGER: "OFF" }).compactionTrigger).toEqual({ mode: "off", value: 0 });
  });

  it("trigger_invalid_env_is_ignored", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    for (const env of ["abc", "-5%", "0", "4%", "10k", "1e999", "", "40"]) {
      expect(load({ PI_LCM_COMPACT_TRIGGER: env }).compactionTrigger, env).toEqual({ mode: "percent", value: 40 });
    }
    writeGlobal({});
    expect(load({ PI_LCM_COMPACT_TRIGGER: "abc" }).compactionTrigger).toBeNull();
  });

  it("trigger_trusted_project_overrides_global", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    writeProject({ compactionTrigger: { mode: "tokens", value: 300000 } });
    expect(loadConfig({ projectRoot, env: {}, trusted: true }).compactionTrigger).toEqual({ mode: "tokens", value: 300000 });
    expect(loadConfig({ projectRoot, env: {}, trusted: false }).compactionTrigger).toEqual({ mode: "percent", value: 40 });
  });

  it("trigger_bad_project_value_falls_back_to_global", () => {
    writeGlobal({ compactionTrigger: { mode: "percent", value: 40 } });
    writeProject({ compactionTrigger: { mode: "percent", value: 4 } });
    expect(loadConfig({ projectRoot, env: {}, trusted: true }).compactionTrigger).toEqual({ mode: "percent", value: 40 });
  });

  it("trigger_save_keeps_other_keys", () => {
    saveModelChoice("test/model");
    saveTriggerChoice({ mode: "percent", value: 40 });
    const saved = JSON.parse(readFileSync(globalFile(), "utf-8"));
    expect(saved.model).toBe("test/model");
    expect(saved.compactionTrigger).toEqual({ mode: "percent", value: 40 });
    expect(load().compactionTrigger).toEqual({ mode: "percent", value: 40 });
    saveModelChoice("other/model");
    expect(load().compactionTrigger).toEqual({ mode: "percent", value: 40 });
  });

  it("trigger_save_swallows_write_errors_and_returns_false", () => {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    writeFileSync(join(home, ".pi"), "not a directory");
    let saved: boolean | undefined;
    expect(() => { saved = saveTriggerChoice({ mode: "off", value: 0 }); }).not.toThrow();
    expect(saved).toBe(false);
    expect(saveModelChoice("a/b")).toBe(false);
  });

  it("save_creates_missing_directory_and_returns_true", () => {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    expect(saveTriggerChoice({ mode: "percent", value: 40 })).toBe(true);
    expect(load().compactionTrigger).toEqual({ mode: "percent", value: 40 });
    expect(saveModelChoice("a/b")).toBe(true);
  });

  it("atomic_write_leaves_no_temp_file_and_keeps_other_keys", () => {
    writeGlobal({ model: "keep/me", futureKey: { nested: [1, 2] } });
    expect(saveTriggerChoice({ mode: "tokens", value: 400000 })).toBe(true);
    expect(saveModelChoice("new/model")).toBe(true);
    const saved = JSON.parse(readFileSync(globalFile(), "utf-8"));
    expect(saved).toEqual({ model: "new/model", futureKey: { nested: [1, 2] }, compactionTrigger: { mode: "tokens", value: 400000 } });
    expect(readdirSync(join(home, ".pi", "agent"))).toEqual(["lcm.json"]);
  });
});

describe("compactionFocus config", () => {
  it("focus_non_string_file_value_falls_back_to_default", () => {
    for (const value of [42, null, ["a"], { a: 1 }, true]) {
      writeGlobal({ compactionFocus: value });
      expect(load().compactionFocus, JSON.stringify(value)).toBe(DEFAULT_COMPACTION_FOCUS);
    }
    writeGlobal({ compactionFocus: "" });
    expect(load().compactionFocus).toBe("");
    writeGlobal({ compactionFocus: "keep x" });
    expect(load().compactionFocus).toBe("keep x");
  });
});
