import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import { insertMemory } from "../../src/store/memories.js";
import { searchAll } from "../../src/recall/search.js";

let db: Db;
let projectId: string;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
  insertMessages(db, projectId, "s1", [
    { entryId: "e1", role: "user", content: "the auth token is in .env.local", createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  insertMemory(db, projectId, "auth token rotation uses the CLI", ["type:workflow"], "manual");
});

describe("searchAll", () => {
  it("merges messages and memories with type weights", () => {
    const hits = searchAll(db, projectId, "auth token", { limit: 10 });
    expect(hits.map((h) => h.type).sort()).toEqual(["memory", "message"]);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
  });

  it("filters by type and survives special characters", () => {
    expect(searchAll(db, projectId, "auth", { limit: 10, types: ["memory"] })).toHaveLength(1);
    expect(() => searchAll(db, projectId, 'auth" OR * : -', { limit: 10 })).not.toThrow();
  });

  it("returns nothing for an empty query", () => {
    expect(searchAll(db, projectId, "  ", { limit: 10 })).toEqual([]);
  });
});
