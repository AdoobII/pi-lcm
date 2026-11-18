import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_FOCUS } from "./compact/prompts.js";
import { parseTriggerInput, sanitizeTrigger, type CompactionTrigger } from "./trigger.js";
import type { LcmConfig } from "./types.js";

export const DEFAULT_CONFIG: LcmConfig = {
  dbPath: null,
  model: null,
  leafSummaryBudget: 1200,
  condensedSummaryBudget: 2000,
  condenseThreshold: 4,
  maxDepth: 5,
  maxChunks: 20,
  renderBudget: 6000,
  expandBudget: 20000,
  restoreMemories: 20,
  recallLimit: 5,
  recallThreshold: 0.35,
  autoMemories: true,
  storeThinking: false,
  compactionFocus: DEFAULT_COMPACTION_FOCUS,
  compactionTrigger: null,
  debug: false,
} as const;

export function configPaths(projectRoot: string): { global: string; project: string } {
  return {
    global: join(homedir(), ".pi", "agent", "lcm.json"),
    project: join(projectRoot, CONFIG_DIR_NAME, "lcm.json"),
  };
}

// Invalid values are dropped so the lower layer or the default applies.
function sanitizeConfigFile(file: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...file };
  if ("compactionFocus" in clean && typeof clean.compactionFocus !== "string") delete clean.compactionFocus;
  if ("compactionTrigger" in clean) {
    const trigger = sanitizeTrigger(clean.compactionTrigger);
    if (trigger) clean.compactionTrigger = trigger;
    else delete clean.compactionTrigger;
  }
  return clean;
}

function readConfigFile(path: string): Partial<LcmConfig> | null {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return sanitizeConfigFile(parsed as Record<string, unknown>) as Partial<LcmConfig>;
  } catch {
    return null;
  }
}

export function loadConfig(opts: { projectRoot: string; env: NodeJS.ProcessEnv; trusted: boolean }): LcmConfig {
  const { projectRoot, env, trusted } = opts;
  const paths = configPaths(projectRoot);
  
  // Start with defaults
  const config: Partial<LcmConfig> = { ...DEFAULT_CONFIG };
  
  // Load global config
  const globalConfig = readConfigFile(paths.global);
  if (globalConfig) {
    Object.assign(config, globalConfig);
  }
  
  // Load project config if trusted
  if (trusted) {
    const projectConfig = readConfigFile(paths.project);
    if (projectConfig) {
      Object.assign(config, projectConfig);
    }
  }
  
  // Apply environment overrides
  if (env.PI_LCM_MODEL !== undefined) {
    config.model = env.PI_LCM_MODEL || null;
  }
  if (env.PI_LCM_DB_PATH !== undefined) {
    config.dbPath = env.PI_LCM_DB_PATH || null;
  }
  if (env.PI_LCM_DEBUG !== undefined) {
    config.debug = env.PI_LCM_DEBUG === "1";
  }
  if (env.PI_LCM_COMPACT_TRIGGER !== undefined) {
    const parsed = parseTriggerInput(env.PI_LCM_COMPACT_TRIGGER);
    if (parsed.ok) config.compactionTrigger = parsed.trigger;
  }
  
  return config as LcmConfig;
}

// Writes the global lcm.json through a temp file in the same directory so a crash or a full disk cannot leave a half-written file.
function updateGlobalConfig(changes: Partial<LcmConfig>): boolean {
  const path = configPaths("").global;
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    const existing = readConfigFile(path) ?? {};
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, JSON.stringify({ ...existing, ...changes }, null, 2));
    renameSync(tempPath, path);
    return true;
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignore cleanup failure.
    }
    return false;
  }
}

export function saveModelChoice(model: string): boolean {
  return updateGlobalConfig({ model });
}

export function saveTriggerChoice(trigger: CompactionTrigger): boolean {
  return updateGlobalConfig({ compactionTrigger: trigger });
}
