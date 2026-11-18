import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
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

export type CompactionTriggerSource = "env" | "project" | "global";

// Follows the same precedence as loadConfig.
export function compactionTriggerSource(opts: { projectRoot: string; env: NodeJS.ProcessEnv; trusted: boolean }): CompactionTriggerSource | null {
  const { projectRoot, env, trusted } = opts;
  if (env.PI_LCM_COMPACT_TRIGGER !== undefined) return "env";
  const paths = configPaths(projectRoot);
  if (trusted && readConfigFile(paths.project)?.compactionTrigger) return "project";
  if (readConfigFile(paths.global)?.compactionTrigger) return "global";
  return null;
}

type RawConfigRead = { exists: false } | { exists: true; file: Record<string, unknown> | null };

// Reads the file unsanitised so a save keeps every key. The file field is null when the content is not a JSON object.
function readRawConfigFile(path: string): RawConfigRead {
  if (!existsSync(path)) return { exists: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { exists: true, file: null };
    return { exists: true, file: parsed as Record<string, unknown> };
  } catch {
    return { exists: true, file: null };
  }
}

export function globalConfigIsUnparseable(): boolean {
  const read = readRawConfigFile(configPaths("").global);
  return read.exists && read.file === null;
}

// Writes go to the real target so a symlinked lcm.json stays a link.
function resolveWriteTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path;
  }
  try {
    return realpathSync(path);
  } catch {
    return resolve(dirname(path), readlinkSync(path));
  }
}

// Writes through a temp file so a crash or full disk cannot leave a half-written file.
// An existing file that is not a JSON object is left alone, because rewriting it would lose its contents.
function updateGlobalConfig(changes: Partial<LcmConfig>): boolean {
  let tempPath: string | null = null;
  try {
    const target = resolveWriteTarget(configPaths("").global);
    const read = readRawConfigFile(target);
    if (read.exists && read.file === null) return false;
    const existing = read.exists ? read.file : {};
    mkdirSync(dirname(target), { recursive: true });
    tempPath = `${target}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ ...existing, ...changes }, null, 2));
    if (read.exists) chmodSync(tempPath, statSync(target).mode & 0o777);
    renameSync(tempPath, target);
    return true;
  } catch {
    if (tempPath !== null) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
      }
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
