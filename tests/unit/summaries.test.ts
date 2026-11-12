import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import {
  countSummaries, getLeaves, getRoots, getSummary, getSummaryMessageIds, getUnparentedAtDepth, insertSummary,
} from "../../src/store/summaries.js";

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

describe("summary DAG", () => {
  it("inserts a leaf with message coverage", () => {
    const leaf = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "summary text",
      tokenCount: 3, messageIds, parentIds: [],
    });
    expect(leaf.id).toMatch(/^sum_[0-9a-f]{16}$/);
    expect(getSummaryMessageIds(db, leaf.id)).toEqual(messageIds);
    expect(getLeaves(db, "s1")).toHaveLength(1);
    expect(getRoots(db, "s1")).toHaveLength(1);
  });

  it("links children to a condensed parent", () => {
    const a = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "a", tokenCount: 1, messageIds: [messageIds[0]!], parentIds: [],
    });
    const b = insertSummary(db, projectId, {
      sessionId: "s1", depth: 0, kind: "leaf", content: "b", tokenCount: 1, messageIds: [messageIds[1]!], parentIds: [],
    });
    const parent = insertSummary(db, projectId, {
      sessionId: "s1", depth: 1, kind: "condensed", content: "ab", tokenCount: 2,
      messageIds: [], parentIds: [a.id, b.id],
    });
    expect(getRoots(db, "s1").map((s) => s.id)).toEqual([parent.id]);
    expect(getLeaves(db, "s1")).toHaveLength(2);
    expect(getUnparentedAtDepth(db, "s1", 0)).toHaveLength(0);
    expect(getSummary(db, parent.id)?.childIds.sort()).toEqual([a.id, b.id].sort());
    expect(countSummaries(db, projectId)).toBe(3);
  });
});
