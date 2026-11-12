import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { entryToMessage } from "../../src/store/entries.js";
import { countMessages, getMaxSeq, getMessagesByEntryIds, insertMessages } from "../../src/store/messages.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let db: Db;
let projectId: string;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  migrate(db);
  projectId = ensureProject(db, "/tmp/p");
  ensureSession(db, projectId, "s1", "/tmp/p");
});

describe("entryToMessage", () => {
  it("extracts user text", () => {
    const entry = {
      type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    } as SessionEntry;
    expect(entryToMessage(entry, { storeThinking: false })).toMatchObject({
      entryId: "e1", role: "user", content: "hello",
    });
  });

  it("renders assistant text and tool calls", () => {
    const entry = {
      type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant", timestamp: 2,
        content: [
          { type: "text", text: "running" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    } as SessionEntry;
    const out = entryToMessage(entry, { storeThinking: false });
    expect(out?.content).toContain("running");
    expect(out?.content).toContain("[Tool bash]");
  });

  it("skips system messages and pi-lcm injections", () => {
    const system = {
      type: "message", id: "e3", parentId: null, timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "system", content: "prompt", timestamp: 3 },
    } as SessionEntry;
    const injected = {
      type: "message", id: "e4", parentId: null, timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "custom", customType: "pi-lcm:recall", content: "x", display: false, timestamp: 4 },
    } as SessionEntry;
    expect(entryToMessage(system, { storeThinking: false })).toBeNull();
    expect(entryToMessage(injected, { storeThinking: false })).toBeNull();
  });
});

describe("insertMessages", () => {
  it("assigns increasing seq and is idempotent", () => {
    const inputs = [
      { entryId: "e1", role: "user" as const, content: "one", createdAt: "2026-01-01T00:00:00.000Z" },
      { entryId: "e2", role: "assistant" as const, content: "two", createdAt: "2026-01-01T00:00:01.000Z" },
    ];
    const first = insertMessages(db, projectId, "s1", inputs);
    expect(first.map((m) => m.seq)).toEqual([1, 2]);
    const second = insertMessages(db, projectId, "s1", inputs);
    expect(second).toHaveLength(2);
    expect(getMaxSeq(db, "s1")).toBe(2);
    expect(countMessages(db, projectId)).toBe(2);
    expect(getMessagesByEntryIds(db, "s1", ["e2"])[0]?.content).toBe("two");
  });
});
