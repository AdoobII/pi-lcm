import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import { insertSummary } from "../../src/store/summaries.js";
import { renderContext } from "../../src/compact/render.js";

let db: Db;
let projectId: string;
let messageIds: number[];

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
  messageIds = insertMessages(db, projectId, "s1", [
    { entryId: "e1", role: "user", content: "one", createdAt: "2026-01-01T00:00:00.000Z" },
    { entryId: "e2", role: "assistant", content: "two", createdAt: "2026-01-01T00:00:01.000Z" },
  ]).map((m) => m.id);
});

describe("renderContext", () => {
  it("renders roots before leaves and includes ids", () => {
    const leaf = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "leaf text", tokenCount: 2, messageIds: [messageIds[0]!], parentIds: [],
    });
    const parent = insertSummary(db, projectId, {
      sessionId: "s1", depth: 1, kind: "condensed", content: "root text", tokenCount: 2, messageIds: [], parentIds: [leaf.id],
    });
    const out = renderContext(db, "s1", { renderBudget: 1000 });
    expect(out.text).toContain(`Summary [${parent.id}]`);
    expect(out.text).not.toContain(`Summary [${leaf.id}]`);
    expect(out.text).toContain("Expand for details about:");
    expect(out.nodeIds).toContain(parent.id);
  });

  it("drops the oldest leaves when over budget", () => {
    const oldLeaf = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "x".repeat(4000), tokenCount: 1000, messageIds: [messageIds[0]!], parentIds: [], createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newLeaf = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "y".repeat(4000), tokenCount: 1000, messageIds: [messageIds[1]!], parentIds: [], createdAt: "2026-01-02T00:00:00.000Z",
    });
    const out = renderContext(db, "s1", { renderBudget: 1100 });
    expect(out.nodeIds).toEqual([newLeaf.id]);
    expect(out.nodeIds).not.toContain(oldLeaf.id);
  });

  it("puts legacy nodes first", () => {
    const legacy = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "legacy", content: "old summary", tokenCount: 2, messageIds: [], parentIds: [],
    });
    const out = renderContext(db, "s1", { renderBudget: 1000 });
    expect(out.nodeIds[0]).toBe(legacy.id);
    expect(out.text).toContain("old summary");
  });
});
