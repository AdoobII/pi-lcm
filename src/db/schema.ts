import type { Db } from "./driver.js";

export const SCHEMA_VERSION = 5;

export class SchemaTooNewError extends Error {
  constructor(public readonly current: number, public readonly expected: number) {
    super(`Schema version ${current} is newer than expected ${expected}`);
    this.name = "SchemaTooNewError";
  }
}

function getCurrentVersion(db: Db): number | null {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get<{ value: string }>();
    if (row && row.value) {
      return parseInt(row.value, 10);
    }
  } catch {
    // Table may not exist yet
  }
  return null;
}

function ensureMetaTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

function inTransaction(db: Db, migration: () => void): void {
  db.exec("BEGIN TRANSACTION");
  try {
    migration();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw error;
  }
}

function runMigration1(db: Db): void {
  inTransaction(db, () => db.exec(`
    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      session_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    -- Messages table
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

    -- Summaries table
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      depth INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      start_seq INTEGER NULL,
      end_seq INTEGER NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      earliest_at TEXT NULL,
      latest_at TEXT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Summary to message mapping (many-to-many)
    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id),
      FOREIGN KEY (summary_id) REFERENCES summaries(id),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    -- Summary parent relationships
    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (summary_id, parent_id),
      FOREIGN KEY (summary_id) REFERENCES summaries(id),
      FOREIGN KEY (parent_id) REFERENCES summaries(id)
    );

    -- Memories table
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_session_entry ON messages(session_id, entry_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_session_depth ON summaries(session_id, depth);
    CREATE INDEX IF NOT EXISTS idx_summary_messages_message_id ON summary_messages(message_id);
    CREATE INDEX IF NOT EXISTS idx_summary_parents_parent_id ON summary_parents(parent_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);

    -- FTS5 virtual tables
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
      content,
      content='summaries',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, tags,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- Triggers for messages_fts (ai = after insert, ad = after delete, au = after update)
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid) VALUES ('delete', old.id);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- Triggers for summaries_fts
    CREATE TRIGGER IF NOT EXISTS summaries_fts_ai AFTER INSERT ON summaries BEGIN
      INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS summaries_fts_ad AFTER DELETE ON summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid) VALUES ('delete', old.rowid);
    END;

    CREATE TRIGGER IF NOT EXISTS summaries_fts_au AFTER UPDATE ON summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO summaries_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    -- Triggers for memories_fts
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid) VALUES ('delete', old.rowid);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;

    -- Record schema version
    INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
  `));
}

function runMigration2(db: Db): void {
  inTransaction(db, () => {
    // Check if event_at column exists and add it if not
    const columns = db
      .prepare("PRAGMA table_info(messages)")
      .all<{ name: string }>();
    const hasEventAt = columns.some((col) => col.name === "event_at");

    if (!hasEventAt) {
      db.exec(`ALTER TABLE messages ADD COLUMN event_at TEXT;`);
    }

    // Drop the non-unique index if it exists (from migration 1)
    // and create a unique index with the same name
    db.exec(`DROP INDEX IF EXISTS idx_messages_session_entry;`);
    db.exec(`CREATE UNIQUE INDEX idx_messages_session_entry ON messages(session_id, entry_id);`);

    // Update schema version
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
  });
}

function runMigration3(db: Db): void {
  inTransaction(db, () => {
    // Add content_hash column to memories table if it doesn't exist
    const columns = db
      .prepare("PRAGMA table_info(memories)")
      .all<{ name: string }>();
    const hasContentHash = columns.some((col) => col.name === "content_hash");

    if (!hasContentHash) {
      db.exec(`ALTER TABLE memories ADD COLUMN content_hash TEXT;`);
    }

    // Add a unique index on (project_id, content_hash) for deduplication
    // This must run unconditionally after the column is ensured
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_project_content_hash ON memories(project_id, content_hash)`);

    // Update schema version
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')");
  });
}

function runMigration4(db: Db): void {
  inTransaction(db, () => {
    // An external-content FTS5 table needs the old column values to remove a row from the index.
    db.exec(`
      DROP TRIGGER IF EXISTS memories_fts_ad;
      CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      END;
    `);

    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4')");
  });
}

function runMigration5(db: Db): void {
  inTransaction(db, () => {
    // An external-content FTS5 table needs the old column values to remove a row from the index.
    db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ad;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      DROP TRIGGER IF EXISTS summaries_fts_ad;
      CREATE TRIGGER summaries_fts_ad AFTER DELETE ON summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    `);

    // Deletes that ran through the old triggers left stale index entries; rebuild repairs them.
    db.exec(`
      INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
      INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild');
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);

    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')");
  });
}

/**
 * Run migrations on the database. Idempotent and synchronous.
 * Throws SchemaTooNewError if the stored version is newer than SCHEMA_VERSION.
 */
export function migrate(db: Db): void {
  // Set pragmas - ignore WAL failure on :memory:
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // WAL mode fails on :memory:, that's fine
  }
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  ensureMetaTable(db);

  const currentVersion = getCurrentVersion(db);

  if (currentVersion !== null && currentVersion > SCHEMA_VERSION) {
    throw new SchemaTooNewError(currentVersion, SCHEMA_VERSION);
  }

  if (currentVersion === null || currentVersion < SCHEMA_VERSION) {
    // Run all migrations from current version + 1 up to SCHEMA_VERSION
    if (currentVersion === null || currentVersion < 1) {
      runMigration1(db);
    }
    if (currentVersion === null || currentVersion < 2) {
      runMigration2(db);
    }
    if (currentVersion === null || currentVersion < 3) {
      runMigration3(db);
    }
    if (currentVersion === null || currentVersion < 4) {
      runMigration4(db);
    }
    if (currentVersion === null || currentVersion < 5) {
      runMigration5(db);
    }
  }
}
