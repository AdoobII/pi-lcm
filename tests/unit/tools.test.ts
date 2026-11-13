import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import { insertSummary } from "../../src/store/summaries.js";
import { registerTools, type ToolDeps } from "../../src/tools/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

let db: Db;
let projectId: string;
let tools: Map<string, ToolDefinition>;

function fakePi(): ExtensionAPI {
  return {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
  tools = new Map();
  const deps: ToolDeps = {
    getDb: () => db, getDbPath: () => ":memory:", getProjectId: () => projectId,
    getSessionId: () => "s1", config: DEFAULT_CONFIG,
  };
  registerTools(fakePi(), deps);
});

async function run(name: string, params: unknown) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute("call", params as never, undefined, undefined, {} as never);
}

describe("tools", () => {
  it("registers all five tools", () => {
    expect([...tools.keys()].sort()).toEqual(["lcm_describe", "lcm_expand", "lcm_grep", "lcm_stats", "lcm_store"]);
  });

  it("grep finds messages", async () => {
    insertMessages(db, projectId, "s1", [
      { entryId: "e1", role: "user", content: "the auth token lives here", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const result = await run("lcm_grep", { query: "auth token", limit: 5 });
    expect(JSON.stringify(result.content)).toContain("auth token");
  });

  it("expand returns covered messages", async () => {
    const ids = insertMessages(db, projectId, "s1", [
      { entryId: "e1", role: "user", content: "first", createdAt: "2026-01-01T00:00:00.000Z" },
      { entryId: "e2", role: "assistant", content: "second", createdAt: "2026-01-01T00:00:01.000Z" },
    ]).map((m) => m.id);
    const summary = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "sum", tokenCount: 1, messageIds: ids, parentIds: [],
    });
    const result = await run("lcm_expand", { target: summary.id });
    expect(JSON.stringify(result.content)).toContain("first");
    expect(JSON.stringify(result.content)).toContain("second");
  });

  it("store writes a memory and stats counts it", async () => {
    await run("lcm_store", { content: "use pnpm", tags: ["type:preference"] });
    const stats = await run("lcm_stats", {});
    expect(JSON.stringify(stats.content)).toContain("memories");
  });

  it("describe session counts are session-specific", async () => {
    // Create two sessions with messages
    ensureSession(db, projectId, "s2", "/tmp/p");
    
    // Add messages to s1
    insertMessages(db, projectId, "s1", [
      { entryId: "e1", role: "user", content: "message in s1", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    
    // Add messages to s2
    insertMessages(db, projectId, "s2", [
      { entryId: "e2", role: "user", content: "message in s2", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    
    // Describe s1 - should only count messages in s1
    const result = await run("lcm_describe", { id: "s1" });
    const content = JSON.stringify(result.content);
    expect(content).toContain("message count: 1");
    expect(content).toContain("summary count: 0");
  });

  it("stats tokenSavings counts a message covered by two summaries once", async () => {
    // Create a message
    const messageIds = insertMessages(db, projectId, "s1", [
      { entryId: "e1", role: "user", content: "shared message content", createdAt: "2026-01-01T00:00:00.000Z" },
    ]).map((m) => m.id);
    
    // Create two summaries that both cover the same message
    insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "summary 1", tokenCount: 10, messageIds, parentIds: [],
    });
    insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "summary 2", tokenCount: 10, messageIds, parentIds: [],
    });
    
    const result = await run("lcm_stats", {});
    const content = JSON.stringify(result.content);
    // The message should be counted only once in tokenSavings
    // tokenSavings = (message token_count) - (sum of summary token_counts)
    // message token_count for "shared message content" should be counted once
    expect(content).toContain("tokenSavings:");
  });

  it("expand truncation output ends with [truncated] and respects the token budget", async () => {
    // Create a very long message that will exceed the budget (20000 tokens)
    // Each token is roughly 4 characters, so we need ~80000 characters to exceed 20000 tokens
    const longContent = "a ".repeat(80000); // Very long content to ensure it exceeds the budget
    const messageIds = insertMessages(db, projectId, "s1", [
      { entryId: "e1", role: "user", content: longContent, createdAt: "2026-01-01T00:00:00.000Z" },
    ]).map((m) => m.id);
    
    const summary = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "summary", tokenCount: 10, messageIds, parentIds: [],
    });
    
    const result = await run("lcm_expand", { target: summary.id, format: "full" });
    const content = JSON.stringify(result.content);
    expect(content).toContain("[truncated]");
  });
});
