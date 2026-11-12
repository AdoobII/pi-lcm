import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import {
  countMemories, insertMemory, markMemoryUsed, recentMemories, searchMemories,
} from "../../src/store/memories.js";
import { quoteFtsQuery } from "../../src/util/fts.js";

let db: Db;
let projectId: string;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
});

describe("quoteFtsQuery", () => {
  it("quotes terms and strips operators", () => {
    expect(quoteFtsQuery('auth "token" OR *')).toBe('"auth" AND "token" AND "OR" AND "*"');
    expect(quoteFtsQuery("   ")).toBe("");
  });
});

describe("memories", () => {
  it("dedupes normalized content per project", () => {
    const a = insertMemory(db, projectId, "Use pnpm, not npm.", ["type:preference"], "manual");
    const b = insertMemory(db, projectId, "  use   PNPM, not npm.  ", ["type:preference"], "manual");
    expect(b.id).toBe(a.id);
    expect(countMemories(db, projectId)).toBe(1);
    expect(a.tags).toEqual(["type:preference"]);
  });

  it("finds memories with FTS and marks use", () => {
    const memory = insertMemory(db, projectId, "The auth token lives in .env.local", ["type:gotcha"], "auto");
    const hits = searchMemories(db, projectId, "auth token", 5);
    expect(hits[0]?.id).toBe(memory.id);
    markMemoryUsed(db, memory.id);
    const recent = recentMemories(db, projectId, 5);
    expect(recent[0]?.useCount).toBe(1);
  });

  it("orders recent memories by use then recency", () => {
    const a = insertMemory(db, projectId, "alpha", [], "manual");
    const b = insertMemory(db, projectId, "beta", [], "manual");
    markMemoryUsed(db, a.id);
    expect(recentMemories(db, projectId, 2).map((m) => m.id)).toEqual([a.id, b.id]);
  });
});
