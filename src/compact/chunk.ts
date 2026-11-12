import type { StoredMessage } from "../types.js";

export interface Chunk {
  messages: StoredMessage[];
  tokenCount: number;
  oversized: boolean;
}

export interface ChunkOptions {
  budget: number;
  maxChunks: number;
  modelLimit: number;
}

/**
 * Pack messages into chunks according to token budget rules.
 * 
 * Rules:
 * 1. Add messages one at a time. If adding the next would make tokenCount > budget 
 *    and the chunk already has at least one message, add that crossing message anyway, 
 *    then close the chunk.
 * 2. Before closing a chunk, add every following toolResult message so a tool call 
 *    and its results never split.
 * 3. If the number of chunks exceeds maxChunks, recompute budget and repack.
 * 4. If repacked count still exceeds maxChunks (totalTokens > maxChunks * modelLimit), 
 *    return one oversized chunk.
 * 5. If any packed chunk's tokenCount > modelLimit, return one oversized chunk.
 * 6. A single message larger than budget forms its own chunk; if larger than modelLimit, 
 *    the result is one oversized chunk.
 */
export function chunkMessages(messages: StoredMessage[], opts: ChunkOptions): Chunk[] {
  const { budget, maxChunks, modelLimit } = opts;
  
  // If there are no messages, return empty array
  if (messages.length === 0) {
    return [];
  }

  // Calculate total tokens
  const totalTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // Check if total tokens exceed maxChunks * modelLimit
  if (totalTokens > maxChunks * modelLimit) {
    return [{
      messages: [...messages],
      tokenCount: totalTokens,
      oversized: true,
    }];
  }

  // Try to pack with the given budget
  let chunks = packMessages(messages, budget, modelLimit);

  // Check if any chunk exceeds modelLimit
  if (chunks.some((c) => c.tokenCount > modelLimit)) {
    return [{
      messages: [...messages],
      tokenCount: totalTokens,
      oversized: true,
    }];
  }

  // If we have too many chunks, try with a larger budget
  if (chunks.length > maxChunks) {
    // Recompute budget: min(max(budget, ceil(totalTokens / maxChunks)), modelLimit)
    const newBudget = Math.min(
      Math.max(budget, Math.ceil(totalTokens / maxChunks)),
      modelLimit
    );
    chunks = packMessages(messages, newBudget, modelLimit);

    // Check again if any chunk exceeds modelLimit
    if (chunks.some((c) => c.tokenCount > modelLimit)) {
      return [{
        messages: [...messages],
        tokenCount: totalTokens,
        oversized: true,
      }];
    }

    // If we still have too many chunks, it means totalTokens > maxChunks * modelLimit
    // But we already checked this above, so this shouldn't happen
    // However, let's be defensive
    if (chunks.length > maxChunks) {
      return [{
        messages: [...messages],
        tokenCount: totalTokens,
        oversized: true,
      }];
    }
  }

  return chunks;
}

/**
 * Pack messages into chunks using the given budget.
 * Does not check maxChunks or modelLimit - just applies the packing rules.
 */
function packMessages(messages: readonly StoredMessage[], budget: number, modelLimit: number): Chunk[] {
  const chunks: Chunk[] = [];
  let currentChunk: StoredMessage[] = [];
  let currentTokenCount = 0;
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    // Check if this single message is larger than modelLimit
    if (msg.tokenCount > modelLimit) {
      // This message alone exceeds modelLimit
      if (currentChunk.length > 0) {
        chunks.push({
          messages: [...currentChunk],
          tokenCount: currentTokenCount,
          oversized: false,
        });
        currentChunk = [];
        currentTokenCount = 0;
      }
      chunks.push({
        messages: [msg],
        tokenCount: msg.tokenCount,
        oversized: true,
      });
      i++;
      continue;
    }

    // Check if adding this message would exceed budget
    const wouldExceed = currentTokenCount + msg.tokenCount > budget;

    if (wouldExceed && currentChunk.length > 0) {
      // Adding this message would cross the budget and we have at least one message
      // Add the crossing message anyway, then close the chunk
      currentChunk.push(msg);
      currentTokenCount += msg.tokenCount;
      i++;

      // Before closing, add every following toolResult message
      while (i < messages.length && messages[i]!.role === "toolResult") {
        const toolMsg = messages[i]!;
        currentChunk.push(toolMsg);
        currentTokenCount += toolMsg.tokenCount;
        i++;
      }

      chunks.push({
        messages: [...currentChunk],
        tokenCount: currentTokenCount,
        oversized: false,
      });
      currentChunk = [];
      currentTokenCount = 0;
    } else {
      // Add the message to the current chunk
      currentChunk.push(msg);
      currentTokenCount += msg.tokenCount;
      i++;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: [...currentChunk],
      tokenCount: currentTokenCount,
      oversized: false,
    });
  }

  return chunks;
}
