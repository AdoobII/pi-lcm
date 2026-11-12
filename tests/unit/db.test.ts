import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, type Db } from "../../src/db/driver.js";
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

  it("migrates from v1 to v2 by adding event_at column and unique index", async () => {
    const db = await openDatabase(":memory:");
    
    // Create a v1 database manually (without event_at column and without unique index)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session_file TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    
    // Create messages table WITHOUT event_at column (v1 state)
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','toolResult','custom','bashExecution')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    `);
    
    // Verify v1 state: no event_at column
    const columnsBefore = db
      .prepare("PRAGMA table_info(messages)")
      .all<{ name: string }>();
    const hasEventAtBefore = columnsBefore.some((col) => col.name === "event_at");
    expect(hasEventAtBefore).toBe(false);
    
    // Verify no unique index exists (only the non-unique idx_messages_session_seq should exist)
    const indexesBefore = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_session_entry'")
      .all<{ name: string }>();
    expect(indexesBefore).toHaveLength(0);
    
    // Run migration
    migrate(db);
    
    // Verify v2 state: event_at column exists
    const columnsAfter = db
      .prepare("PRAGMA table_info(messages)")
      .all<{ name: string }>();
    const hasEventAtAfter = columnsAfter.some((col) => col.name === "event_at");
    expect(hasEventAtAfter).toBe(true);
    
    // Verify unique index exists
    const indexesAfter = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_session_entry'")
      .all<{ name: string }>();
    expect(indexesAfter).toHaveLength(1);
    
    // Verify schema version is 2
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>();
    expect(version?.value).toBe("2");
    
    db.close();
  });

  it("migration v2 is idempotent when event_at already exists", async () => {
    const db = await openDatabase(":memory:");
    
    // Create a v2 database manually (with event_at column)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session_file TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    
    // Create messages table WITH event_at column (already has it)
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','toolResult','custom','bashExecution')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        event_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    `);
    
    // Run migration - should not fail even though event_at already exists
    migrate(db);
    
    // Verify schema version is 2
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>();
    expect(version?.value).toBe("2");
    
    db.close();
  });

  it("rejects duplicate (session_id, entry_id) on fresh database", async () => {
    const db = await openDatabase(":memory:");
    migrate(db);
    
    db.prepare("INSERT INTO projects (id, root) VALUES (?, ?)").run("p1", "/tmp/p1");
    db.prepare("INSERT INTO sessions (id, project_id, cwd) VALUES (?, ?, ?)").run("s1", "p1", "/tmp/p1");
    
    // Insert first message
    db.prepare(
      "INSERT INTO messages (project_id, session_id, entry_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "s1", "e1", 1, "user", "hello", 5, new Date().toISOString());
    
    // Try to insert duplicate (session_id, entry_id) - should fail
    expect(() => {
      db.prepare(
        "INSERT INTO messages (project_id, session_id, entry_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("p1", "s1", "e1", 2, "assistant", "world", 5, new Date().toISOString());
    }).toThrow();
    
    db.close();
  });

  it("rejects duplicate (session_id, entry_id) on upgraded v1 database", async () => {
    const db = await openDatabase(":memory:");
    
    // Create a v1 database manually (without event_at column and with non-unique index)
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        session_file TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id)
      );
    `);
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','toolResult','custom','bashExecution')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
    
    // Create the non-unique index (as migration 1 does)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_entry ON messages(session_id, entry_id);
    `);
    
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    `);
    
    // Insert a project and session
    db.prepare("INSERT INTO projects (id, root) VALUES (?, ?)").run("p1", "/tmp/p1");
    db.prepare("INSERT INTO sessions (id, project_id, cwd) VALUES (?, ?, ?)").run("s1", "p1", "/tmp/p1");
    
    // Insert first message
    db.prepare(
      "INSERT INTO messages (project_id, session_id, entry_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "s1", "e1", 1, "user", "hello", 5, new Date().toISOString());
    
    // Run migration to v2
    migrate(db);
    
    // Try to insert duplicate (session_id, entry_id) - should fail due to unique index
    expect(() => {
      db.prepare(
        "INSERT INTO messages (project_id, session_id, entry_id, seq, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("p1", "s1", "e1", 2, "assistant", "world", 5, new Date().toISOString());
    }).toThrow();
    
    db.close();
  });
});
