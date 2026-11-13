import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
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
  debug: false,
} as const;

export function configPaths(projectRoot: string): { global: string; project: string } {
  return {
    global: join(homedir(), ".pi", "agent", "lcm.json"),
    project: join(projectRoot, CONFIG_DIR_NAME, "lcm.json"),
  };
}

function readConfigFile(path: string): Partial<LcmConfig> | null {
  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as Partial<LcmConfig>;
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
  
  return config as LcmConfig;
}

export function saveModelChoice(model: string): void {
  const paths = configPaths("");
  try {
    const existing = readConfigFile(paths.global) ?? {};
    const updated = { ...existing, model };
    writeFileSync(paths.global, JSON.stringify(updated, null, 2));
  } catch {
    // Swallow errors
  }
}
