import type { Usage } from "@earendil-works/pi-ai";

export type { Usage };
export type MessageRole = "user" | "assistant" | "toolResult" | "custom" | "bashExecution";
export type SummaryKind = "leaf" | "condensed" | "legacy" | "oversized";
export type SearchType = "message" | "summary" | "memory";

export interface MessageInput {
  entryId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  eventAt?: string;
}

export interface StoredMessage extends MessageInput {
  id: number;
  projectId: string;
  sessionId: string;
  seq: number;
  tokenCount: number;
}

export interface SummaryInput {
  sessionId: string;
  depth: number;
  kind: SummaryKind;
  content: string;
  tokenCount: number;
  messageIds: number[];
  parentIds: string[];
  createdAt?: string;
  earliestAt?: string | null;
  latestAt?: string | null;
}

export interface SummaryNode {
  id: string;
  projectId: string;
  sessionId: string;
  depth: number;
  kind: SummaryKind;
  content: string;
  tokenCount: number;
  startSeq: number | null;
  endSeq: number | null;
  messageCount: number;
  createdAt: string;
  earliestAt: string | null;
  latestAt: string | null;
  parentIds: string[];
  childIds: string[];
}

export interface Memory {
  id: string;
  projectId: string;
  content: string;
  tags: string[];
  source: "manual" | "auto";
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemoryDraft {
  content: string;
  tags?: string[];
  source?: "manual" | "auto";
}

export interface SearchHit {
  type: SearchType;
  id: string;
  score: number;
  snippet: string;
  createdAt: string;
  sessionId?: string;
  depth?: number;
}

export interface LcmConfig {
  dbPath: string | null;
  model: string | null;
  leafSummaryBudget: number;
  condensedSummaryBudget: number;
  condenseThreshold: number;
  maxDepth: number;
  maxChunks: number;
  renderBudget: number;
  expandBudget: number;
  restoreMemories: number;
  recallLimit: number;
  recallThreshold: number;
  autoMemories: boolean;
  storeThinking: boolean;
  compactionFocus: string;
  debug: boolean;
}

export interface SummarizeOptions {
  depth: number;
  aggressive: boolean;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  text: string;
  usage?: Usage;
}

export type Summarizer = (text: string, opts: SummarizeOptions) => Promise<SummarizeResult>;

export interface DbPathOptions {
  cwd: string;
  projectRoot: string;
  projectId: string;
  config: LcmConfig;
  trusted: boolean;
}