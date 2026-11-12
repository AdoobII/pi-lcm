import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import { insertMemory } from "../../src/store/memories.js";
import { insertSummary } from "../../src/store/summaries.js";
import { buildPromptBlock, buildRestoreBlock, createRecallState } from "../../src/recall/inject.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

let db: Db;
let projectId: string;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
  ensureSession(db, projectId, "s2", "/tmp/p");
  insertMemory(db, projectId, "the deploy key is in 1password", ["type:gotcha"], "manual");
});

describe("recall injection", () => {
  it("restores once and marks surfaced ids", () => {
    const state = createRecallState();
    const first = buildRestoreBlock(db, projectId, "s1", DEFAULT_CONFIG, state);
    expect(first).toContain("<memory-context>");
    expect(first).toContain("surfaced-memory-ids");
    expect(buildRestoreBlock(db, projectId, "s1", DEFAULT_CONFIG, state)).toBeNull();
  });

  it("does not repeat a surfaced memory in prompt recall", () => {
    const state = createRecallState();
    buildRestoreBlock(db, projectId, "s1", DEFAULT_CONFIG, state);
    expect(buildPromptBlock(db, projectId, "s1", "deploy key", DEFAULT_CONFIG, state)).toBeNull();
  });

  it("injects relevant summaries and memories", () => {
    const state = createRecallState();
    const ids = insertMessages(db, projectId, "s2", [
      { entryId: "e1", role: "user", content: "deploy key rotation", createdAt: "2026-01-01T00:00:00.000Z" },
    ]).map((m) => m.id);
    insertSummary(db, projectId, {
      sessionId: "s2", depth: 0, kind: "leaf", content: "deploy key rotation procedure", tokenCount: 5, messageIds: ids, parentIds: [],
    });
    const block = buildPromptBlock(db, projectId, "s1", "deploy key rotation", DEFAULT_CONFIG, state);
    expect(block).toContain("<memory-context>");
    expect(block).toContain("surfaced-memory-ids");
  });
});
