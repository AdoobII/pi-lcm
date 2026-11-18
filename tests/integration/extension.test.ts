import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../../src/index.js";
import { createFakePi } from "../helpers/fake-pi.js";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", content: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1 },
  } as SessionEntry;
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string, summary: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:05.000Z",
    summary,
    firstKeptEntryId,
    tokensBefore: 100,
  } as SessionEntry;
}

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function boot(options: { hasUI?: boolean; model?: string | null; branch?: SessionEntry[]; selectResult?: string; completeError?: Error } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-ext-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const previousHome = process.env.HOME;
  const previousModel = process.env.PI_LCM_MODEL;
  const previousDb = process.env.PI_LCM_DB_PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  process.env.PI_LCM_DB_PATH = ":memory:";
  if (options.model) process.env.PI_LCM_MODEL = options.model;
  else delete process.env.PI_LCM_MODEL;
  const fake = createFakePi({
    cwd, hasUI: options.hasUI ?? false, branch: options.branch ?? [],
    selectResult: options.selectResult, completeError: options.completeError,
  });
  await extension(fake.api);
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  const restore = () => {
    process.env.HOME = previousHome;
    if (previousModel === undefined) delete process.env.PI_LCM_MODEL;
    else process.env.PI_LCM_MODEL = previousModel;
    if (previousDb === undefined) delete process.env.PI_LCM_DB_PATH;
    else process.env.PI_LCM_DB_PATH = previousDb;
  };
  cleanup = restore;
  return fake;
}

describe("extension", () => {
  it("persists messages on turn_end", async () => {
    const branch = [messageEntry("e1", null, "user", "hello")];
    const fake = await boot({ branch });
    await fake.emit("turn_end", { type: "turn_end", turnIndex: 0, message: (branch[0] as SessionMessageEntry).message, toolResults: [], messageEntryId: "e1", toolResultEntryIds: [], entries: [], continue: false, context: [] });
    const stats = await fake.tools.get("lcm_stats")!.execute("c", {}, undefined, undefined, fake.context);
    expect(JSON.stringify((stats as { content: unknown }).content)).toContain("1");
  });

  it("returns a custom compaction when a model is configured", async () => {
    const branch = [
      messageEntry("e1", null, "user", "hello"),
      messageEntry("e2", "e1", "assistant", "hi"),
    ];
    const fake = await boot({ branch, model: "test/test-model" });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ compaction: { summary: expect.stringContaining("<lcm-context") } });
  });

  it("prompts once and uses the chosen model", async () => {
    const branch = [
      messageEntry("e1", null, "user", "hello"),
      messageEntry("e2", "e1", "assistant", "hi"),
    ];
    const fake = await boot({ branch, hasUI: true, selectResult: "test/test-model" });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ compaction: { summary: expect.stringContaining("<lcm-context") } });
  });

  it("hard-gates when no model is configured and there is no UI", async () => {
    const branch = [messageEntry("e1", null, "user", "hello")];
    const fake = await boot({ branch, hasUI: false });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toBeUndefined();
  });

  it("does not cover abandoned-branch messages after a tree switch", async () => {
    const abandoned = [messageEntry("a1", null, "user", "abandoned")];
    const fake = await boot({ branch: abandoned, model: "test/test-model" });
    await fake.emit("turn_end", { type: "turn_end", turnIndex: 0, message: (abandoned[0] as SessionMessageEntry).message, toolResults: [], messageEntryId: "a1", toolResultEntryIds: [], entries: [], continue: false, context: [] });
    const kept = [
      messageEntry("b1", null, "user", "kept"),
      messageEntry("b2", "b1", "assistant", "kept reply"),
    ];
    fake.setBranch(kept);
    await fake.emit("session_tree", { type: "session_tree", newLeafId: "b1", oldLeafId: "a1" });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "b2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: kept,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    const nodeId = (result as any).compaction.details.lcm.nodeIds[0];
    const expanded = await fake.tools.get("lcm_expand")!.execute("c", { target: nodeId }, undefined, undefined, fake.context);
    expect(JSON.stringify((expanded as { content: unknown }).content)).toContain("kept");
    expect(JSON.stringify((expanded as { content: unknown }).content)).not.toContain("abandoned");
  });

  it("starts a repeated compaction at the previous kept boundary", async () => {
    const branch = [
      messageEntry("e1", null, "user", "one"),
      messageEntry("e2", "e1", "assistant", "two"),
      compactionEntry("c1", "e2", "e2", "previous summary"),
      messageEntry("e3", "c1", "user", "three"),
      messageEntry("e4", "e3", "assistant", "four"),
    ];
    const fake = await boot({ branch, model: "test/test-model" });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e4", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    const nodeIds = (result as any).compaction.details.lcm.nodeIds as string[];
    const expanded = await Promise.all(nodeIds.map(async (id) => {
      const r = await fake.tools.get("lcm_expand")!.execute("c", { target: id }, undefined, undefined, fake.context);
      return JSON.stringify((r as { content: unknown }).content);
    }));
    const all = expanded.join("\n");
    expect(all).toContain("two");
    expect(all).toContain("three");
    expect(all).not.toContain("one");
    expect(all).not.toContain("four");
  });

  it("covers every dropped message", async () => {
    const branch = [
      messageEntry("e1", null, "user", "hello"),
      messageEntry("e2", "e1", "assistant", "hi"),
    ];
    const fake = await boot({ branch, model: "test/test-model" });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    const nodeId = (result as any).compaction.details.lcm.nodeIds[0];
    const expanded = await fake.tools.get("lcm_expand")!.execute("c", { target: nodeId }, undefined, undefined, fake.context);
    expect(JSON.stringify((expanded as { content: unknown }).content)).toContain("hello");
  });

  it("falls back when the summarizer fails", async () => {
    const branch = [
      messageEntry("e1", null, "user", "hello"),
      messageEntry("e2", "e1", "assistant", "hi"),
    ];
    const fake = await boot({ branch, model: "test/test-model", completeError: new Error("provider down") });
    const result = await fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    });
    expect(result).toBeUndefined();
  });

  it("injects restored memory at run start", async () => {
    const fake = await boot({ branch: [] });
    await fake.tools.get("lcm_store")!.execute("c", { content: "deploy key is in 1password", tags: ["type:gotcha"] }, undefined, undefined, fake.context);
    const result = await fake.emit("before_agent_start", {
      type: "before_agent_start", messageType: "user", prompt: "deploy key",
      systemPrompt: "", systemPromptOptions: {},
    });
    expect(JSON.stringify(result)).toContain("<memory-context>");
  });

  it("registers /lcm-model", async () => {
    const fake = await boot({ branch: [], hasUI: true, selectResult: "test/test-model" });
    const command = fake.commands.get("lcm-model");
    expect(command).toBeDefined();
    await command!.handler("", fake.context);
  });
});
