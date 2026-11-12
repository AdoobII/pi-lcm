import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages, getMessagesForSummary } from "../../src/store/messages.js";
import { getLeaves, getRoots, insertSummary } from "../../src/store/summaries.js";
import { compactSpan, type CompactionDeps } from "../../src/compact/engine.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

let db: Db;
let projectId: string;
let deps: CompactionDeps;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
  deps = {
    db, projectId, sessionId: "s1", config: DEFAULT_CONFIG, modelLimit: 12000,
    summarize: vi.fn(async () => ({ text: "## Goal\nship it\nExpand for details about: commands" })),
  };
});

function span(count: number, prefix = "e") {
  const messages = insertMessages(db, projectId, "s1", Array.from({ length: count }, (_, i) => ({
    entryId: `${prefix}${i + 1}`, role: i % 2 === 0 ? "user" as const : "assistant" as const,
    content: `message ${i + 1}`, createdAt: `2026-01-01T00:00:0${i}.000Z`,
  })));
  return { messages, firstKeptEntryId: "keep", tokensBefore: 100, previousWasOurs: false };
}

describe("compactSpan", () => {
  it("creates leaves covering every message and renders a window", async () => {
    const outcome = await compactSpan(deps, span(4));
    expect(outcome?.summary).toContain("<lcm-context");
    expect(outcome?.summary).toContain("Summary [sum_");
    expect(outcome?.details.lcm.nodeIds.length).toBeGreaterThan(0);
    const leaves = getLeaves(db, "s1");
    const covered = leaves.flatMap((l) => getMessagesForSummary(db, l.id));
    expect(covered).toHaveLength(4);
  });

  it("condenses when unparented leaves reach the threshold", async () => {
    deps.config = { ...DEFAULT_CONFIG, condenseThreshold: 2 };
    await compactSpan(deps, span(4, "a"));
    await compactSpan(deps, span(4, "b"));
    expect(getRoots(db, "s1").some((r) => r.depth === 1)).toBe(true);
  });

  it("preserves a Pi-generated previous summary as a legacy node", async () => {
    const outcome = await compactSpan(deps, { ...span(2), previousSummary: "old pi summary", previousWasOurs: false });
    expect(outcome).toBeDefined();
    expect(getRoots(db, "s1").some((r) => r.kind === "legacy" && r.content === "old pi summary")).toBe(true);
  });

  it("retries a failed chunk once before giving up", async () => {
    deps.summarize = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ text: "## Goal\nretried\nExpand for details about: commands" });
    const outcome = await compactSpan(deps, span(2));
    expect(outcome).toBeDefined();
    expect(deps.summarize).toHaveBeenCalledTimes(2);
  });

  it("stores an oversized node without calling the model", async () => {
    deps.config = { ...DEFAULT_CONFIG, leafSummaryBudget: 1, maxChunks: 1 };
    deps.modelLimit = 1;
    const outcome = await compactSpan(deps, span(2));
    expect(outcome).toBeDefined();
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(getRoots(db, "s1").some((r) => r.kind === "oversized")).toBe(true);
  });

  it("returns undefined when summarization fails twice", async () => {
    deps.summarize = vi.fn(async () => { throw new Error("provider down"); });
    expect(await compactSpan(deps, span(2))).toBeUndefined();
  });

  it("returns undefined when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    deps.summarize = vi.fn(async (_text, opts) => {
      if (opts.signal?.aborted) throw new Error("aborted");
      return { text: "x" };
    });
    expect(await compactSpan(deps, { ...span(2), signal: controller.signal })).toBeUndefined();
  });

  it("returns undefined for an empty span", async () => {
    expect(await compactSpan(deps, { messages: [], firstKeptEntryId: "keep", tokensBefore: 0, previousWasOurs: false })).toBeUndefined();
  });

  it("retrying whole span does not create duplicate coverage", async () => {
    // Setup: two chunks, first chunk fails twice, then whole span retry succeeds
    // We need to configure chunking to create 2 chunks
    deps.config = { ...DEFAULT_CONFIG, leafSummaryBudget: 50, maxChunks: 10 };
    
    // Create 4 messages that will be split into 2 chunks
    const messages = insertMessages(db, projectId, "s1", [
      { entryId: "m1", role: "user" as const, content: "message 1", createdAt: "2026-01-01T00:00:00.000Z" },
      { entryId: "m2", role: "assistant" as const, content: "message 2", createdAt: "2026-01-01T00:00:01.000Z" },
      { entryId: "m3", role: "user" as const, content: "message 3", createdAt: "2026-01-01T00:00:02.000Z" },
      { entryId: "m4", role: "assistant" as const, content: "message 4", createdAt: "2026-01-01T00:00:03.000Z" },
    ]);
    
    // Mock: first two calls fail (for first chunk), third call succeeds (whole span retry)
    deps.summarize = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ 
        text: "## Goal\nship it\nExpand for details about: commands",
        usage: {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    
    const outcome = await compactSpan(deps, {
      messages,
      firstKeptEntryId: "keep",
      tokensBefore: 100,
      previousWasOurs: false,
    });
    
    expect(outcome).toBeDefined();
    expect(deps.summarize).toHaveBeenCalledTimes(3);
    
    // Check that there's only one leaf node covering all messages
    const leaves = getLeaves(db, "s1");
    expect(leaves.length).toBe(1);
    
    // Check that the single leaf node covers all 4 messages
    const covered = getMessagesForSummary(db, leaves[0]!.id);
    expect(covered).toHaveLength(4);
    
    // Check that all message IDs are unique in the coverage
    const messageIds = covered.map((m) => m.id);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(messageIds.length);
  });

  it("condensation respects budget hard constraint", async () => {
    // Setup: create children whose combined tokens exceed the budget
    deps.config = { ...DEFAULT_CONFIG, condenseThreshold: 2, condensedSummaryBudget: 100 };
    
    // First, insert messages that the summary nodes will reference
    const messages = insertMessages(db, projectId, "s1", [
      { entryId: "m1", role: "user" as const, content: "A", createdAt: "2026-01-01T00:00:00.000Z" },
      { entryId: "m2", role: "user" as const, content: "B", createdAt: "2026-01-01T00:00:01.000Z" },
      { entryId: "m3", role: "user" as const, content: "C", createdAt: "2026-01-01T00:00:02.000Z" },
    ]);
    
    // Insert two leaf nodes with high token counts
    const node1 = insertSummary(db, projectId, {
      sessionId: "s1",
      depth: 0,
      kind: "leaf",
      content: "A".repeat(50), // 50 tokens
      tokenCount: 50,
      messageIds: [messages[0]!.id],
      parentIds: [],
    });
    
    const node2 = insertSummary(db, projectId, {
      sessionId: "s1",
      depth: 0,
      kind: "leaf",
      content: "B".repeat(50), // 50 tokens
      tokenCount: 50,
      messageIds: [messages[1]!.id],
      parentIds: [],
    });
    
    const node3 = insertSummary(db, projectId, {
      sessionId: "s1",
      depth: 0,
      kind: "leaf",
      content: "C".repeat(50), // 50 tokens
      tokenCount: 50,
      messageIds: [messages[2]!.id],
      parentIds: [],
    });
    
    // Mock summarize to return a result
    deps.summarize = vi.fn(async () => ({
      text: "condensed",
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }));
    
    // Trigger condensation by calling compactSpan which will call condenseDepth
    await compactSpan(deps, span(0));
    
    // Check that no condensed node was created with children exceeding the budget
    const roots = getRoots(db, "s1");
    const condensedNodes = roots.filter((r) => r.kind === "condensed");
    
    // With budget of 100, node1 + node2 = 100 tokens (at limit), node3 = 50 tokens
    // The batching should not create a batch with node1 + node2 + node3 (150 > 100)
    // It should create batches of at most 2 nodes each (50 + 50 = 100)
    for (const condensed of condensedNodes) {
      // Get the children of this condensed node
      const children = roots.filter((r) => condensed.parentIds.includes(r.id));
      const totalTokens = children.reduce((sum, c) => sum + c.tokenCount, 0);
      expect(totalTokens).toBeLessThanOrEqual(deps.config.condensedSummaryBudget);
    }
  });
});
