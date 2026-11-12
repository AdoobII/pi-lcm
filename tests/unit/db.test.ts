import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/driver.js";
import { migrate, SCHEMA_VERSION } from "../../src/db/schema.js";

describe("schema", () => {
  it("creates every table and records the version", async () => {
    const db = await openDatabase(":memory:");
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "projects", "sessions", "messages", "summaries", "summary_messages",
      "summary_parents", "memories", "meta",
    ]));
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>();
    expect(version?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("indexes messages with FTS5", async () => {
    const db = await openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, root) VALUES (?, ?)").run("p1", "/tmp/p1");
    db.prepare("INSERT INTO sessions (id, project_id, cwd) VALUES (?, ?, ?)").run("s1", "p1", "/tmp/p1");
    db.prepare(
      "INSERT INTO messages (project_id, session_id, entry_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "s1", "e1", 1, "user", "the quick brown fox", 5, new Date().toISOString());
    const hits = db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all<{ rowid: number }>("quick");
    expect(hits).toHaveLength(1);
    db.close();
  });

  it("is idempotent and rejects a newer schema", async () => {
    const db = await openDatabase(":memory:");
    migrate(db);
    migrate(db);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("999");
    expect(() => migrate(db)).toThrow(/newer/i);
    db.close();
  });
});
