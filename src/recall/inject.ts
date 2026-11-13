import type { Db } from "../db/driver.js";
import type { LcmConfig, Memory, SearchHit, SummaryNode } from "../types.js";
import { recentMemories } from "../store/memories.js";
import { searchAll } from "./search.js";
import { estimateTokens } from "../util/tokens.js";

export interface RecallState {
  surfaced: Set<string>;
  restored: boolean;
}

export function createRecallState(): RecallState {
  return {
    surfaced: new Set<string>(),
    restored: false,
  };
}

/**
 * Get the newest summaries from other sessions (not the current sessionId).
 * Limited to 5, ordered by created_at DESC.
 */
function getNewestOtherSessionSummaries(
  db: Db,
  projectId: string,
  sessionId: string,
  limit: number = 5
): SummaryNode[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count,
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries
       WHERE project_id = ? AND session_id != ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(projectId, sessionId, limit);

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    depth: row.depth,
    kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
    content: row.content,
    tokenCount: row.token_count,
    startSeq: row.start_seq,
    endSeq: row.end_seq,
    messageCount: row.message_count,
    createdAt: row.created_at,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    parentIds: [],
    childIds: [],
  }));
}

/**
 * Format a memory for display in the restore block.
 */
function formatMemory(memory: Memory): string {
  const tagsStr = memory.tags.length > 0 ? ` (${memory.tags.join(", ")})` : "";
  return `- [${memory.id}] ${memory.content}${tagsStr}`;
}

/**
 * Format a summary for display in the restore block.
 */
function formatSummary(summary: SummaryNode): string {
  return `- [${summary.id}] ${summary.content}`;
}

/**
 * Build the restore block with project memories and recent session summaries.
 * Returns null when state.restored is true or when both lists are empty.
 */
export function buildRestoreBlock(
  db: Db,
  projectId: string,
  sessionId: string,
  config: LcmConfig,
  state: RecallState
): string | null {
  // Return null if already restored
  if (state.restored) {
    return null;
  }

  // Mark as restored
  state.restored = true;

  // Load recent memories
  const memories = recentMemories(db, projectId, config.restoreMemories);

  // Load newest summaries from other sessions
  const summaries = getNewestOtherSessionSummaries(db, projectId, sessionId, 5);

  // Check if both lists are empty
  if (memories.length === 0 && summaries.length === 0) {
    return null;
  }

  // Build the block
  const lines: string[] = ["<memory-context>"];

  // Add project memories section
  if (memories.length > 0) {
    lines.push("## Project memories");
    for (const memory of memories) {
      lines.push(formatMemory(memory));
      state.surfaced.add(memory.id);
    }
  }

  // Add recent sessions section
  if (summaries.length > 0) {
    lines.push("## Recent sessions");
    for (const summary of summaries) {
      lines.push(formatSummary(summary));
      state.surfaced.add(summary.id);
    }
  }

  // Add surfaced memory ids comment
  const surfacedIds = Array.from(state.surfaced).join(",");
  lines.push(`<!-- surfaced-memory-ids: ${surfacedIds} -->`);
  lines.push("</memory-context>");

  return lines.join("\n");
}

/**
 * Fetch the full content for a hit (memory or summary).
 */
function getHitContent(db: Db, hit: SearchHit): string {
  if (hit.type === "memory") {
    const row = db
      .prepare("SELECT content FROM memories WHERE id = ?")
      .get<{ content: string }>(hit.id);
    return row?.content ?? hit.snippet ?? "";
  } else if (hit.type === "summary") {
    const row = db
      .prepare("SELECT content FROM summaries WHERE id = ?")
      .get<{ content: string }>(hit.id);
    return row?.content ?? hit.snippet ?? "";
  }
  return hit.snippet ?? "";
}

/**
 * Build the prompt block with relevant memories and summaries matching the prompt.
 * Returns null for empty prompt or when nothing qualifies.
 */
export function buildPromptBlock(
  db: Db,
  projectId: string,
  sessionId: string,
  prompt: string,
  config: LcmConfig,
  state: RecallState
): string | null {
  // Return null for empty prompt
  if (prompt.trim().length === 0) {
    return null;
  }

  // Search for relevant items
  const hits = searchAll(db, projectId, prompt, {
    limit: config.recallLimit * 2,
    types: ["memory", "summary"],
  });

  // Filter by score threshold and exclude already surfaced ids
  const filtered = hits.filter(
    (hit) =>
      hit.score >= config.recallThreshold &&
      !state.surfaced.has(hit.id)
  );

  // Take up to recallLimit items
  const selected = filtered.slice(0, config.recallLimit);

  // Check if we have anything to include
  if (selected.length === 0) {
    return null;
  }

  const MAX_TOKENS = 2000;

  // Build the block incrementally, counting the full text that will be emitted
  // We need to include: envelope, each full line, the comment, and the closing tag
  const openingLines = ["<memory-context>", "## Relevant memory"];
  const openingText = openingLines.join("\n");
  const openingTokens = estimateTokens(openingText);

  // Track items we can include and their full line text
  const items: { id: string; line: string; lineTokens: number }[] = [];
  
  for (const hit of selected) {
    const content = getHitContent(db, hit);
    const line = `- [${hit.id}] ${content}`;
    const lineTokens = estimateTokens(line);
    items.push({ id: hit.id, line, lineTokens });
  }

  // Now try to build the block, checking the full token count including closing parts
  // We'll add items one by one and check if the complete block (with closing) fits
  const includedIds: string[] = [];
  const includedLines: string[] = [...openingLines];
  let currentTokens = openingTokens;

  for (const item of items) {
    // Calculate what the closing parts would look like if we include this item
    const tempSurfaced = new Set(state.surfaced);
    tempSurfaced.add(item.id);
    for (const id of includedIds) {
      tempSurfaced.add(id);
    }
    const surfacedIdsStr = Array.from(tempSurfaced).join(",");
    const closingComment = `<!-- surfaced-memory-ids: ${surfacedIdsStr} -->`;
    const closingText = [closingComment, "</memory-context>"].join("\n");
    const closingTokens = estimateTokens(closingText);

    // Calculate the new line with newline
    const newLineWithNewline = includedLines.length > 0 ? "\n" + item.line : item.line;
    const newLineTokens = estimateTokens(newLineWithNewline);

    // Total would be: current + new line + closing
    const totalWithThis = currentTokens + newLineTokens + closingTokens;

    if (totalWithThis > MAX_TOKENS) {
      // Can't include this item
      break;
    }

    includedLines.push(item.line);
    includedIds.push(item.id);
    currentTokens += newLineTokens;
  }

  // If we didn't include any items, return null
  if (includedIds.length === 0) {
    return null;
  }

  // Add all included ids to state.surfaced
  for (const id of includedIds) {
    state.surfaced.add(id);
  }

  // Build the final block with closing parts
  const allSurfacedIds = Array.from(state.surfaced).join(",");
  const closingComment = `<!-- surfaced-memory-ids: ${allSurfacedIds} -->`;
  const finalLines = [...includedLines, closingComment, "</memory-context>"];
  const finalBlock = finalLines.join("\n");

  // Final validation: ensure the complete block is within the token limit
  const finalTokenCount = estimateTokens(finalBlock);
  if (finalTokenCount > MAX_TOKENS) {
    // Remove items from the end until it fits or we have none
    while (includedIds.length > 0) {
      const removedId = includedIds.pop()!;
      includedLines.pop();
      state.surfaced.delete(removedId);

      const updatedSurfacedIds = Array.from(state.surfaced).join(",");
      const updatedClosingComment = `<!-- surfaced-memory-ids: ${updatedSurfacedIds} -->`;
      const updatedFinalLines = [...includedLines, updatedClosingComment, "</memory-context>"];
      const updatedFinalBlock = updatedFinalLines.join("\n");
      const updatedTokenCount = estimateTokens(updatedFinalBlock);

      if (updatedTokenCount <= MAX_TOKENS || includedIds.length === 0) {
        if (includedIds.length === 0) {
          return null;
        }
        return updatedFinalBlock;
      }
    }
    return null;
  }

  return finalBlock;
}
