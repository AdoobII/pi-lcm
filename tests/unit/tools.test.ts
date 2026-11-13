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
});
