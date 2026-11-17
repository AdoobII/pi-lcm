import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMemory } from "../../src/store/memories.js";
import { buildPromptBlock, createRecallState } from "../../src/recall/inject.js";
import { ageDays, decayedScore } from "../../src/recall/age.js";
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
});

describe("ageDays", () => {
  it("counts whole days elapsed", () => {
    const now = new Date("2026-01-10T12:00:00.000Z");
    expect(ageDays("2026-01-01T13:00:00.000Z", now)).toBe(8);
    expect(ageDays("2026-01-10T00:00:00.000Z", now)).toBe(0);
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
});
