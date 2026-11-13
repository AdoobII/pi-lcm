import type { Db } from "../db/driver.js";
import { estimateTokens } from "../util/tokens.js";
import type { MessageInput, StoredMessage } from "../types.js";

const MESSAGE_COLUMNS = "id, project_id, session_id, entry_id, seq, role, content, token_count, created_at, event_at";

export function getMaxSeq(db: Db, sessionId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) as maxSeq FROM messages WHERE session_id = ?")
    .get<{ maxSeq: number | null }>(sessionId);
  return row?.maxSeq ?? 0;
}

export function insertMessages(
  db: Db,
  projectId: string,
  sessionId: string,
  inputs: MessageInput[],
): StoredMessage[] {
  if (inputs.length === 0) {
    return [];
  }
  
  // Start transaction
  db.exec("BEGIN TRANSACTION");

  try {
    // Get current max seq for this session
    const currentMaxSeq = getMaxSeq(db, sessionId);
    const nextSeq = currentMaxSeq + 1;

    // Get existing entry IDs for this session to filter out duplicates
    const existingEntries = db
      .prepare("SELECT entry_id FROM messages WHERE session_id = ?")
      .all<{ entry_id: string }>(sessionId);
    const existingEntryIds = new Set(existingEntries.map((e) => e.entry_id));

    // Filter inputs to only those not already in the database
    const newInputs = inputs.filter((input) => !existingEntryIds.has(input.entryId));

    // Insert new messages with sequential seq numbers
    let seq = nextSeq;
    for (const input of newInputs) {
      const tokenCount = estimateTokens(input.content);
      db.prepare(
        `INSERT INTO messages 
         (project_id, session_id, entry_id, seq, role, content, token_count, created_at, event_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        projectId,
        sessionId,
        input.entryId,
        seq,
        input.role,
        input.content,
        tokenCount,
        input.createdAt,
        input.eventAt ?? null,
      );
      seq++;
    }

    // Get all rows for the requested entry IDs ordered by seq
    const allEntryIds = inputs.map((input) => input.entryId);
    const placeholders = allEntryIds.map(() => "?").join(", ");
    const result = db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} 
         FROM messages 
         WHERE session_id = ? AND entry_id IN (${placeholders}) 
         ORDER BY seq`
      )
      .all<StoredMessage>(sessionId, ...allEntryIds);

    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getMessagesByEntryIds(
  db: Db,
  sessionId: string,
  entryIds: string[],
): StoredMessage[] {
  if (entryIds.length === 0) {
    return [];
  }

  const placeholders = entryIds.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} 
       FROM messages 
       WHERE session_id = ? AND entry_id IN (${placeholders}) 
       ORDER BY seq`
    )
    .all<StoredMessage>(sessionId, ...entryIds);
}

export function getMessagesBySeqRange(
  db: Db,
  sessionId: string,
  startSeq: number,
  endSeq: number,
): StoredMessage[] {
  return db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} 
       FROM messages 
       WHERE session_id = ? AND seq >= ? AND seq < ? 
       ORDER BY seq`
    )
    .all<StoredMessage>(sessionId, startSeq, endSeq);
}

export function getMessagesForSummary(
  db: Db,
  summaryId: string,
): StoredMessage[] {
  return db
    .prepare(
      `SELECT m.${MESSAGE_COLUMNS} 
       FROM messages m 
       JOIN summary_messages sm ON m.id = sm.message_id 
       WHERE sm.summary_id = ? 
       ORDER BY m.seq`
    )
    .all<StoredMessage>(summaryId);
}

export function countMessages(db: Db, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM messages WHERE project_id = ?")
    .get<{ count: number }>(projectId);
  return row?.count ?? 0;
}
