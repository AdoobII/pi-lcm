import type { Db } from "../db/driver.js";
import type { LcmConfig, StoredMessage, SummaryNode, Summarizer, SummarizeOptions, SummarizeResult, Usage, MemoryDraft } from "../types.js";
import { chunkMessages } from "./chunk.js";
import { parseMemories } from "./prompts.js";
import { renderContext } from "./render.js";
import { insertSummary, getUnparentedAtDepth } from "../store/summaries.js";
import { insertMemory } from "../store/memories.js";
import { estimateTokens } from "../util/tokens.js";

/**
 * Normalize a message from the database to ensure it has camelCase properties.
 * The database returns snake_case column names, but TypeScript expects camelCase.
 */
function normalizeMessage(msg: StoredMessage): StoredMessage {
  // If tokenCount is already defined (camelCase), use it
  if (msg.tokenCount !== undefined) {
    return msg;
  }
  // Otherwise, the database returned snake_case, so map it
  const tokenCount = (msg as unknown as { token_count?: number }).token_count ?? 0;
  return {
    ...msg,
    tokenCount,
  };
}

export interface CompactionDeps {
  db: Db;
  config: LcmConfig;
  projectId: string;
  sessionId: string;
  summarize: Summarizer;
  modelLimit: number;
}

export interface CompactionSpan {
  messages: StoredMessage[];
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
  previousWasOurs: boolean;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionOutcome {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details: { lcm: { version: 1; nodeIds: string[] } };
}

/**
 * Sum usage arrays element-wise. Returns undefined for empty input.
 */
export function sumUsage(usages: Usage[]): Usage | undefined {
  if (usages.length === 0) {
    return undefined;
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let totalTokens = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;

  for (const u of usages) {
    input += u.input ?? 0;
    output += u.output ?? 0;
    cacheRead += u.cacheRead ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    reasoning += u.reasoning ?? 0;
    totalTokens += u.totalTokens ?? 0;

    // Sum cost fields
    costInput += u.cost?.input ?? 0;
    costOutput += u.cost?.output ?? 0;
    costCacheRead += u.cost?.cacheRead ?? 0;
    costCacheWrite += u.cost?.cacheWrite ?? 0;
    costTotal += u.cost?.total ?? 0;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

/**
 * Serialize messages with role prefixes for summarization.
 */
function serializeMessages(messages: StoredMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const content = msg.role === "toolResult" 
      ? msg.content.slice(0, 2000) 
      : msg.content;
    const prefix = msg.role === "user" ? "[User]:" 
      : msg.role === "assistant" ? "[Assistant]:" 
      : msg.role === "toolResult" ? "[Tool result]:" 
      : `[${msg.role}]:`;
    parts.push(`${prefix} ${content}`);
  }
  return parts.join("\n");
}

/**
 * Process a single chunk: either oversized or summarize.
 */
async function processChunk(
  deps: CompactionDeps,
  chunk: { messages: StoredMessage[]; oversized: boolean },
  customInstructions: string | undefined,
  signal: AbortSignal | undefined,
  usages: Usage[]
): Promise<SummaryNode | null> {
  const { db, projectId, sessionId, config, modelLimit } = deps;

  if (chunk.oversized) {
    // Build deterministic content for oversized node
    const contentParts: string[] = ["## Oversized span"];
    const maxContentLength = config.condensedSummaryBudget * 4;
    let currentLength = 0;

    for (const msg of chunk.messages) {
      const prefix = msg.role === "user" ? "[User]" 
        : msg.role === "assistant" ? "[Assistant]" 
        : msg.role === "toolResult" ? "[Tool result]" 
        : `[${msg.role}]`;
      const contentPreview = msg.content.slice(0, 200);
      const line = `${prefix} ${contentPreview}`;

      if (currentLength + line.length <= maxContentLength) {
        contentParts.push(line);
        currentLength += line.length;
      } else {
        // Truncate the last line to fit
        const remaining = maxContentLength - currentLength;
        if (remaining > 0) {
          contentParts.push(line.slice(0, remaining));
        }
        break;
      }
    }

    contentParts.push("This span exceeded the summarizer window; expand the node for exact history.");
    const content = contentParts.join("\n");
    const tokenCount = estimateTokens(content);

    return insertSummary(db, projectId, {
      sessionId,
      depth: 0,
      kind: "oversized",
      content,
      tokenCount,
      messageIds: chunk.messages.map((m) => m.id),
      parentIds: [],
    });
  }

  // Normal chunk: serialize and summarize
  const text = serializeMessages(chunk.messages);
  const opts: SummarizeOptions = {
    depth: 0,
    aggressive: false,
    customInstructions,
    signal,
  };

  const result = await deps.summarize(text, opts);

  // Check for abort or empty result
  if (signal?.aborted) {
    throw new Error("Aborted");
  }
  if (result.text.trim() === "") {
    throw new Error("Empty summarization result");
  }

  // Track usage
  if (result.usage) {
    usages.push(result.usage);
  }

  const tokenCount = estimateTokens(result.text);

  // Insert leaf node
  const node = insertSummary(db, projectId, {
    sessionId,
    depth: 0,
    kind: "leaf",
    content: result.text,
    tokenCount,
    messageIds: chunk.messages.map((m) => m.id),
    parentIds: [],
  });

  // Parse and insert memories if autoMemories is enabled
  if (config.autoMemories) {
    const memories = parseMemories(result.text);
    for (const draft of memories) {
      insertMemory(db, projectId, draft.content, draft.tags ?? [], "auto");
    }
  }

  return node;
}

/**
 * Condense unparented nodes at a given depth.
 */
async function condenseDepth(
  deps: CompactionDeps,
  depth: number,
  usages: Usage[]
): Promise<void> {
  const { db, projectId, sessionId, config } = deps;

  while (true) {
    const unparented = getUnparentedAtDepth(db, sessionId, depth);
    if (unparented.length < config.condenseThreshold) {
      break;
    }

    // Batch children: each batch's joined content <= condensedSummaryBudget tokens
    // At least two children per batch
    const batches: SummaryNode[][] = [];
    let currentBatch: SummaryNode[] = [];
    let currentBatchTokens = 0;

    for (const node of unparented) {
      // Check if adding this node would exceed the budget
      // We need at least 2 nodes per batch, so we need to be careful
      if (currentBatch.length >= 2 && currentBatchTokens + node.tokenCount > config.condensedSummaryBudget) {
        // Close current batch and start a new one
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = [node];
        currentBatchTokens = node.tokenCount;
      } else {
        currentBatch.push(node);
        currentBatchTokens += node.tokenCount;
      }
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    // Process each batch
    for (const batch of batches) {
      // Skip batches with less than 2 nodes (shouldn't happen due to threshold)
      if (batch.length < 2) {
        continue;
      }

      // Build text for condensation
      const batchText = batch.map((n) => n.content).join("\n\n");

      // Summarize the batch
      const opts: SummarizeOptions = {
        depth: depth + 1,
        aggressive: false,
        customInstructions: undefined,
        signal: undefined,
      };

      const result = await deps.summarize(batchText, opts);

      if (result.text.trim() === "") {
        throw new Error("Empty condensation result");
      }

      // Track usage
      if (result.usage) {
        usages.push(result.usage);
      }

      const tokenCount = estimateTokens(result.text);

      // Insert condensed node
      insertSummary(db, projectId, {
        sessionId,
        depth: depth + 1,
        kind: "condensed",
        content: result.text,
        tokenCount,
        messageIds: [],
        parentIds: batch.map((n) => n.id),
      });
    }
  }
}

/**
 * Compact a span of messages into a summary DAG.
 */
export async function compactSpan(
  deps: CompactionDeps,
  span: CompactionSpan
): Promise<CompactionOutcome | undefined> {
  const { db, projectId, sessionId, config } = deps;
  const { messages, firstKeptEntryId, tokensBefore, previousSummary, previousWasOurs, customInstructions, signal } = span;

  try {
    // 1. Return undefined when span.messages is empty or span.signal?.aborted
    if (messages.length === 0 || signal?.aborted) {
      return undefined;
    }

    // Normalize messages to ensure they have camelCase properties
    const normalizedMessages = messages.map(normalizeMessage);

    const usages: Usage[] = [];

    // 2. When span.previousSummary && !span.previousWasOurs, insert a legacy node
    if (previousSummary && !previousWasOurs) {
      const tokenCount = estimateTokens(previousSummary);
      insertSummary(db, projectId, {
        sessionId,
        depth: 0,
        kind: "legacy",
        content: previousSummary,
        tokenCount,
        messageIds: [],
        parentIds: [],
      });
    }

    // 3. Chunk messages
    const chunks = chunkMessages(normalizedMessages, {
      budget: config.leafSummaryBudget,
      maxChunks: config.maxChunks,
      modelLimit: deps.modelLimit,
    });

    // 4. Process each chunk
    const chunkNodes: SummaryNode[] = [];

    for (const chunk of chunks) {
      let node: SummaryNode | null = null;
      let retries = 0;
      let shouldRetrySpan = false;

      while (retries <= 1) {
        try {
          node = await processChunk(deps, chunk, customInstructions, signal, usages);
          if (node) {
            chunkNodes.push(node);
            break;
          }
        } catch (error) {
          if (retries === 0) {
            // First retry: retry the same chunk
            retries++;
            continue;
          } else if (retries === 1 && !shouldRetrySpan) {
            // Second failure: retry the entire span as one chunk
            shouldRetrySpan = true;
            retries++;
            // Re-chunk as one chunk
            const allMessagesChunk = {
              messages: [...messages],
              oversized: false,
              tokenCount: messages.reduce((sum, m) => sum + m.tokenCount, 0),
            };
            try {
              node = await processChunk(deps, allMessagesChunk, customInstructions, signal, usages);
              if (node) {
                chunkNodes.push(node);
                break;
              }
            } catch {
              // Still failed
              return undefined;
            }
          } else {
            // All retries exhausted
            return undefined;
          }
        }
      }

      if (node === null) {
        return undefined;
      }
    }

    // 5. Condense
    for (let depth = 0; depth < config.maxDepth; depth++) {
      await condenseDepth(deps, depth, usages);
    }

    // 6. Render context
    const rendered = renderContext(db, sessionId, { renderBudget: config.renderBudget });

    // 7. Return outcome
    return {
      summary: rendered.text,
      firstKeptEntryId,
      tokensBefore,
      usage: sumUsage(usages),
      details: { lcm: { version: 1, nodeIds: rendered.nodeIds } },
    };
  } catch (error) {
    // 8. Wrap in try/catch; log and return undefined on any error
    console.error("Compaction error:", error);
    return undefined;
  }
}
