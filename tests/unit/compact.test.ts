import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages, getMessagesForSummary } from "../../src/store/messages.js";
import { getLeaves, getRoots, insertSummary, getSummaryParents } from "../../src/store/summaries.js";
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
    // Setup: leafSummaryBudget: 1 with 4 messages produces 2 chunks/leaves via crossing rule
    // condensedSummaryBudget: 1 means two leaf summaries (each 1 token) cannot fit in one batch (1+1=2>1)
    deps.config = { ...DEFAULT_CONFIG, leafSummaryBudget: 1, condenseThreshold: 2, condensedSummaryBudget: 1 };
    deps.modelLimit = 12000;
    
    // Mock summarize to return a minimal 1-token summary
    deps.summarize = vi.fn(async () => ({
      text: "x",
      usage: {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }));
    
    // Call compactSpan with 4 messages to create 2 leaf nodes, then trigger condensation
    await compactSpan(deps, span(4));
    
    // Get all roots and check condensation results
    const roots = getRoots(db, "s1");
    const leaves = roots.filter((r) => r.kind === "leaf");
    const condensedNodes = roots.filter((r) => r.kind === "condensed");
    
    // With budget of 1, two leaves of 1 token each cannot fit in one batch (1+1=2>1)
    // So no condensed node should be created
    expect(condensedNodes).toHaveLength(0);
    
    // Both leaves should remain unparented (no summary_parents rows)
    expect(leaves).toHaveLength(2);
    for (const leaf of leaves) {
      const parents = getSummaryParents(db, leaf.id);
      expect(parents).toHaveLength(0);
    }
    
    // Vacuously: every condensed parent's children joined tokenCount is at most budget
    // (no condensed parents exist, so this holds)
  });
});
