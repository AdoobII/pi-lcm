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
});
