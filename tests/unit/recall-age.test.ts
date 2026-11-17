import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMemory } from "../../src/store/memories.js";
import { insertSummary } from "../../src/store/summaries.js";
import { buildPromptBlock, createRecallState } from "../../src/recall/inject.js";
import { ageDays, decayedScore } from "../../src/recall/age.js";
import { searchAll } from "../../src/recall/search.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let projectId: string;

function backdateMemory(id: string, days: number): void {
  const createdAt = new Date(Date.now() - days * DAY_MS).toISOString();
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(createdAt, id);
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
});

describe("decayedScore", () => {
  it("decay_is_one_for_fresh", () => {
    expect(decayedScore(0.8, 0)).toBe(0.8);
  });

  it("decay_floors_at_half", () => {
    expect(decayedScore(0.8, 400)).toBe(0.4);
  });

  it("decay_linear_between", () => {
    expect(decayedScore(1, 45)).toBe(0.75);
  });

  it("decay_is_never_nan", () => {
    expect(decayedScore(0.8, Number.NaN)).toBe(0.8);
  });
});

describe("ageDays", () => {
  it("counts whole days elapsed", () => {
    const now = new Date("2026-01-10T12:00:00.000Z");
    expect(ageDays("2026-01-01T13:00:00.000Z", now)).toBe(8);
    expect(ageDays("2026-01-10T00:00:00.000Z", now)).toBe(0);
  });

  it("returns 0 for an unparseable date", () => {
    expect(ageDays("not a date", new Date("2026-01-10T12:00:00.000Z"))).toBe(0);
  });
});

describe("prompt recall age handling", () => {
  it("finding_older_than_one_day_is_annotated", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:finding"], "manual");
    backdateMemory(memory.id, 9);
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, createRecallState());
    expect(block).toContain(
      `- [${memory.id}] [finding, 9d old, may predate current plan: treat as a hint] the rollout plan uses blue green`
    );
  });

  it("fresh_finding_is_not_annotated", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:finding"], "manual");
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, createRecallState());
    expect(block).toContain(`- [${memory.id}] the rollout plan uses blue green`);
    expect(block).not.toContain("may predate");
  });

  it("non_finding_memory_is_not_annotated", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:gotcha"], "manual");
    backdateMemory(memory.id, 9);
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, createRecallState());
    expect(block).toContain(`- [${memory.id}] the rollout plan uses blue green`);
    expect(block).not.toContain("may predate");
  });

  it("old_finding_decay_applies_before_threshold", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:finding"], "manual");
    backdateMemory(memory.id, 400);
    const config = { ...DEFAULT_CONFIG, recallThreshold: 0.6 };
    expect(buildPromptBlock(db, projectId, "s1", "rollout plan blue green", config, createRecallState())).toBeNull();
  });

  it("old_non_finding_is_not_decayed", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:gotcha"], "manual");
    backdateMemory(memory.id, 400);
    const config = { ...DEFAULT_CONFIG, recallThreshold: 0.6 };
    expect(buildPromptBlock(db, projectId, "s1", "rollout plan blue green", config, createRecallState())).toContain(memory.id);
  });

  it("bad_created_at_does_not_nan_the_score", () => {
    const memory = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:finding"], "manual");
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run("garbage", memory.id);
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, createRecallState());
    expect(block).toContain(`- [${memory.id}] the rollout plan uses blue green`);
    expect(block).not.toContain("may predate");
  });

  it("decay_reorders_hits", () => {
    // The old memory has the best raw score, and 400 days of age halves it below the fresh one.
    const old = insertMemory(db, projectId, "rollout plan blue green", ["type:finding"], "manual");
    const fresh = insertMemory(db, projectId, "rollout plan blue green with one more word", ["type:finding"], "manual");
    insertMemory(db, projectId, `rollout plan blue green ${"padding ".repeat(12)}`, ["type:finding"], "manual");
    backdateMemory(old.id, 400);
    // Control: without decay the old memory ranks first.
    const rawHits = searchAll(db, projectId, "rollout plan blue green", { limit: 10, types: ["memory"] });
    expect(rawHits[0]?.id).toBe(old.id);
    expect(rawHits.findIndex((hit) => hit.id === old.id)).toBeLessThan(rawHits.findIndex((hit) => hit.id === fresh.id));
    // With decay the fresh memory ranks first.
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, createRecallState())!;
    expect(block.indexOf(fresh.id)).toBeGreaterThan(-1);
    expect(block.indexOf(old.id)).toBeGreaterThan(-1);
    expect(block.indexOf(fresh.id)).toBeLessThan(block.indexOf(old.id));
  });

  it("finding_with_tag_filter_and_annotation_together", () => {
    const planFinding = insertMemory(db, projectId, "the rollout plan uses blue green", ["type:finding", "mode:plan"], "manual");
    const otherFinding = insertMemory(db, projectId, "the rollout plan uses blue green too", ["type:finding", "mode:build"], "manual");
    backdateMemory(planFinding.id, 9);
    backdateMemory(otherFinding.id, 9);
    const state = createRecallState();
    state.override = { tags: ["mode:plan"] };
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, state)!;
    expect(block).toContain(
      `- [${planFinding.id}] [finding, 9d old, may predate current plan: treat as a hint] the rollout plan uses blue green`
    );
    expect(block).not.toContain(otherFinding.id);
  });

  it("empty_tags_array_means_no_filter", () => {
    ensureSession(db, projectId, "s2", "/tmp/p");
    const summary = insertSummary(db, projectId, {
      sessionId: "s2", depth: 0, kind: "leaf", content: "rollout plan blue green summary", tokenCount: 5, messageIds: [], parentIds: [],
    });
    const state = createRecallState();
    state.override = { tags: [] };
    const block = buildPromptBlock(db, projectId, "s1", "rollout plan blue green", DEFAULT_CONFIG, state);
    expect(block).toContain(summary.id);
  });

  it("reads_each_hits_tags_once", () => {
    for (const label of ["one", "two", "three"]) {
      insertMemory(db, projectId, `the rollout plan uses blue green ${label}`, ["type:finding", "mode:plan"], "manual");
    }
    const tagQueries: string[] = [];
    const spyDb: Db = {
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      prepare: (sql) => {
        if (/SELECT tags FROM memories/.test(sql)) tagQueries.push(sql);
        return db.prepare(sql);
      },
    };
    const state = createRecallState();
    state.override = { tags: ["mode:plan"] };
    const config = { ...DEFAULT_CONFIG, recallThreshold: 0 };
    const block = buildPromptBlock(spyDb, projectId, "s1", "rollout plan blue green", config, state)!;
    expect(block.match(/^- \[/gm)).toHaveLength(3);
    expect(tagQueries).toHaveLength(3);
  });
});
