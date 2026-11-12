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
