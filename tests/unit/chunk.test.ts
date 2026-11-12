import { describe, expect, it } from "vitest";
import { chunkMessages } from "../../src/compact/chunk.js";
import type { StoredMessage } from "../../src/types.js";

function message(seq: number, role: StoredMessage["role"], tokens: number): StoredMessage {
  return {
    id: seq, projectId: "p", sessionId: "s", entryId: `e${seq}`, seq, role,
    content: "x".repeat(tokens * 4), tokenCount: tokens, createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("chunkMessages", () => {
  it("closes a chunk after the message that crosses the budget", () => {
    const chunks = chunkMessages(
      [message(1, "user", 60), message(2, "assistant", 60), message(3, "user", 60)],
      { budget: 100, maxChunks: 20, modelLimit: 1000 },
    );
    expect(chunks.map((c) => c.messages.map((m) => m.seq))).toEqual([[1, 2], [3]]);
    expect(chunks.every((c) => !c.oversized)).toBe(true);
  });

  it("keeps tool results with the preceding chunk", () => {
    const chunks = chunkMessages(
      [message(1, "user", 60), message(2, "assistant", 60), message(3, "toolResult", 60)],
      { budget: 100, maxChunks: 20, modelLimit: 1000 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("widens chunks instead of exceeding maxChunks", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(i + 1, "user", 50));
    const chunks = chunkMessages(messages, { budget: 50, maxChunks: 3, modelLimit: 1000 });
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.flatMap((c) => c.messages)).toHaveLength(10);
    expect(chunks.every((c) => !c.oversized)).toBe(true);
  });

  it("returns one oversized chunk when the span exceeds maxChunks * modelLimit", () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(i + 1, "user", 500));
    const chunks = chunkMessages(messages, { budget: 50, maxChunks: 2, modelLimit: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.oversized).toBe(true);
    expect(chunks[0]?.tokenCount).toBe(5000);
  });

  it("returns one oversized chunk when a packed chunk exceeds modelLimit", () => {
    const chunks = chunkMessages(
      [message(1, "user", 600), message(2, "assistant", 600)],
      { budget: 1000, maxChunks: 2, modelLimit: 1000 },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.oversized).toBe(true);
  });
});
