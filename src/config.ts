import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_FOCUS } from "./compact/prompts.js";
import { parseTriggerInput, sanitizeTrigger, type CompactionTrigger, type ParseTriggerResult } from "./trigger.js";
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

// Returns null when PI_LCM_COMPACT_TRIGGER is unset.
export function parseCompactTriggerEnv(env: NodeJS.ProcessEnv): ParseTriggerResult | null {
  const raw = env.PI_LCM_COMPACT_TRIGGER;
  return raw === undefined ? null : parseTriggerInput(raw);
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
  const envTrigger = parseCompactTriggerEnv(env);
  if (envTrigger?.ok) config.compactionTrigger = envTrigger.trigger;
  
  return config as LcmConfig;
}

export type CompactionTriggerSource = "env" | "project" | "global";

// Follows the same precedence as loadConfig.
export function compactionTriggerSource(opts: { projectRoot: string; env: NodeJS.ProcessEnv; trusted: boolean }): CompactionTriggerSource | null {
  const { projectRoot, env, trusted } = opts;
  if (parseCompactTriggerEnv(env)?.ok) return "env";
  const paths = configPaths(projectRoot);
  if (trusted && readConfigFile(paths.project)?.compactionTrigger) return "project";
  if (readConfigFile(paths.global)?.compactionTrigger) return "global";
  return null;
}

type RawConfigRead = { exists: false } | { exists: true; unreadable: true } | { exists: true; unreadable?: false; file: Record<string, unknown> | null };

// Reads the file unsanitised so a save keeps every key. The file field is null when the content is not a JSON object.
// A file that exists but cannot be read (permissions, a directory) is reported as unreadable, not as bad JSON.
function readRawConfigFile(path: string): RawConfigRead {
  if (!existsSync(path)) return { exists: false };
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { exists: true, unreadable: true };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { exists: true, file: null };
    return { exists: true, file: parsed as Record<string, unknown> };
  } catch {
    return { exists: true, file: null };
  }
}

export function globalConfigIsUnparseable(): boolean {
  const read = readRawConfigFile(configPaths("").global);
  return read.exists && !read.unreadable && read.file === null;
}

export function globalConfigIsUnreadable(): boolean {
  const read = readRawConfigFile(configPaths("").global);
  return read.exists && read.unreadable === true;
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
    if (read.exists && (read.unreadable || read.file === null)) return false;
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
