import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Db } from "../db/driver.js";
import type { SummaryInput, SummaryNode } from "../types.js";

export function insertSummary(db: Db, projectId: string, input: SummaryInput): SummaryNode {
  const createdAt = input.createdAt ?? new Date().toISOString();
  
  // Generate summary ID: sum_ + first 16 hex chars of SHA-256(content + createdAt + randomUUID())
  const hashInput = input.content + createdAt + randomUUID();
  const hash = createHash("sha256").update(hashInput).digest("hex");
  const id = `sum_${hash.slice(0, 16)}`;

  // Compute startSeq, endSeq, messageCount, earliestAt, latestAt
  let startSeq: number | null = null;
  let endSeq: number | null = null;
  let messageCount = 0;
  let earliestAt: string | null = null;
  let latestAt: string | null = null;

  if (input.messageIds.length > 0) {
    // Derive from covered messages
    const msgRows = db
      .prepare(
        `SELECT seq, created_at FROM messages WHERE id IN (${input.messageIds.map(() => "?").join(", ")})`
      )
      .all<{ seq: number; created_at: string }>(...input.messageIds);

    if (msgRows.length > 0) {
      startSeq = Math.min(...msgRows.map((r) => r.seq));
      endSeq = Math.max(...msgRows.map((r) => r.seq));
      messageCount = msgRows.length;
      earliestAt = msgRows.reduce((min, r) => (min === null || r.created_at < min ? r.created_at : min), null as string | null);
      latestAt = msgRows.reduce((max, r) => (max === null || r.created_at > max ? r.created_at : max), null as string | null);
    }
  } else if (input.parentIds.length > 0) {
    // Derive from parent summaries (condensed node)
    const parentRows = db
      .prepare(
        `SELECT start_seq, end_seq, message_count, earliest_at, latest_at FROM summaries WHERE id IN (${input.parentIds.map(() => "?").join(", ")})`
      )
      .all<{
        start_seq: number | null;
        end_seq: number | null;
        message_count: number;
        earliest_at: string | null;
        latest_at: string | null;
      }>(...input.parentIds);

    if (parentRows.length > 0) {
      const validStartSeqs = parentRows.map((r) => r.start_seq).filter((s) => s !== null) as number[];
      const validEndSeqs = parentRows.map((r) => r.end_seq).filter((e) => e !== null) as number[];
      const validEarliest = parentRows.map((r) => r.earliest_at).filter((e) => e !== null) as string[];
      const validLatest = parentRows.map((r) => r.latest_at).filter((l) => l !== null) as string[];

      startSeq = validStartSeqs.length > 0 ? Math.min(...validStartSeqs) : null;
      endSeq = validEndSeqs.length > 0 ? Math.max(...validEndSeqs) : null;
      messageCount = parentRows.reduce((sum, r) => sum + r.message_count, 0);
      earliestAt = validEarliest.length > 0 ? validEarliest.reduce((min, e) => (e < min ? e : min)) : null;
      latestAt = validLatest.length > 0 ? validLatest.reduce((max, l) => (l > max ? l : max)) : null;
    }
  }

  // Begin transaction
  db.exec("BEGIN TRANSACTION");

  try {
    // Insert the summary row
    db.prepare(
      `INSERT INTO summaries 
       (id, project_id, session_id, depth, kind, content, token_count, start_seq, end_seq, message_count, created_at, earliest_at, latest_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      input.sessionId,
      input.depth,
      input.kind,
      input.content,
      input.tokenCount,
      startSeq,
      endSeq,
      messageCount,
      createdAt,
      earliestAt,
      latestAt
    );

    // Insert summary_messages rows
    for (const messageId of input.messageIds) {
      db.prepare(
        `INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)`
      ).run(id, messageId);
    }

    // Insert summary_parents rows
    // For a condensed node, parentIds are the child summaries being condensed
    // So we insert: summary_id = child, parent_id = this summary
    for (const childId of input.parentIds) {
      db.prepare(
        `INSERT INTO summary_parents (summary_id, parent_id) VALUES (?, ?)`
      ).run(childId, id);
    }

    // Load parentIds and childIds for the returned node
    const parentIds = input.parentIds.slice();

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(id)
      .map((r) => r.summary_id);

    // Commit transaction
    db.exec("COMMIT");

    return {
      id,
      projectId,
      sessionId: input.sessionId,
      depth: input.depth,
      kind: input.kind,
      content: input.content,
      tokenCount: input.tokenCount,
      startSeq,
      endSeq,
      messageCount,
      createdAt,
      earliestAt,
      latestAt,
      parentIds,
      childIds,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getSummary(db: Db, id: string): SummaryNode | undefined {
  const row = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count, 
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries WHERE id = ?`
    )
    .get<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(id);

  if (!row) {
    return undefined;
  }

  // Load parent IDs
  const parentIds = db
    .prepare(
      `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
    )
    .all<{ parent_id: string }>(id)
    .map((r) => r.parent_id);

  // Load child IDs
  const childIds = db
    .prepare(
      `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
    )
    .all<{ summary_id: string }>(id)
    .map((r) => r.summary_id);

  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    depth: row.depth,
    kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
    content: row.content,
    tokenCount: row.token_count,
    startSeq: row.start_seq,
    endSeq: row.end_seq,
    messageCount: row.message_count,
    createdAt: row.created_at,
    earliestAt: row.earliest_at,
    latestAt: row.latest_at,
    parentIds,
    childIds,
  };
}

export function getSummaries(db: Db, sessionId: string): SummaryNode[] {
  const rows = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count,
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries WHERE session_id = ? ORDER BY created_at ASC`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(sessionId);

  return rows.map((row) => {
    const parentIds = db
      .prepare(
        `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
      )
      .all<{ parent_id: string }>(row.id)
      .map((r) => r.parent_id);

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds,
      childIds,
    };
  });
}

export function getRoots(db: Db, sessionId: string): SummaryNode[] {
  // Get summaries that have no parents (no entry in summary_parents as summary_id)
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.session_id, s.depth, s.kind, s.content, s.token_count,
              s.start_seq, s.end_seq, s.message_count, s.created_at, s.earliest_at, s.latest_at
       FROM summaries s
       LEFT JOIN summary_parents sp ON s.id = sp.summary_id
       WHERE s.session_id = ? AND sp.summary_id IS NULL
       ORDER BY s.depth DESC, s.created_at ASC`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(sessionId);

  return rows.map((row) => {
    const parentIds: string[] = [];

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds,
      childIds,
    };
  });
}

export function getLeaves(db: Db, sessionId: string): SummaryNode[] {
  // Get summaries with depth = 0, ordered by created_at ASC
  const rows = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count,
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries 
       WHERE session_id = ? AND depth = 0
       ORDER BY created_at ASC`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(sessionId);

  return rows.map((row) => {
    const parentIds = db
      .prepare(
        `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
      )
      .all<{ parent_id: string }>(row.id)
      .map((r) => r.parent_id);

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds,
      childIds,
    };
  });
}

export function getUnparentedAtDepth(db: Db, sessionId: string, depth: number): SummaryNode[] {
  // Get summaries with the given depth that have no parents
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.session_id, s.depth, s.kind, s.content, s.token_count,
              s.start_seq, s.end_seq, s.message_count, s.created_at, s.earliest_at, s.latest_at
       FROM summaries s
       LEFT JOIN summary_parents sp ON s.id = sp.summary_id
       WHERE s.session_id = ? AND s.depth = ? AND sp.summary_id IS NULL
       ORDER BY s.created_at ASC`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(sessionId, depth);

  return rows.map((row) => {
    const parentIds: string[] = [];

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds,
      childIds,
    };
  });
}

export function getSummaryMessageIds(db: Db, summaryId: string): number[] {
  const rows = db
    .prepare(
      `SELECT message_id FROM summary_messages WHERE summary_id = ? ORDER BY message_id`
    )
    .all<{ message_id: number }>(summaryId);

  return rows.map((r) => r.message_id);
}

export function getSummaryChildren(db: Db, summaryId: string): SummaryNode[] {
  const childRows = db
    .prepare(
      `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
    )
    .all<{ summary_id: string }>(summaryId);

  const childIds = childRows.map((r) => r.summary_id);

  if (childIds.length === 0) {
    return [];
  }

  const placeholders = childIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count,
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries WHERE id IN (${placeholders})`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(...childIds);

  return rows.map((row) => {
    const parentIds = db
      .prepare(
        `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
      )
      .all<{ parent_id: string }>(row.id)
      .map((r) => r.parent_id);

    const childIdsForRow = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds,
      childIds: childIdsForRow,
    };
  });
}

export function getSummaryParents(db: Db, summaryId: string): SummaryNode[] {
  const parentRows = db
    .prepare(
      `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
    )
    .all<{ parent_id: string }>(summaryId);

  const parentIds = parentRows.map((r) => r.parent_id);

  if (parentIds.length === 0) {
    return [];
  }

  const placeholders = parentIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, project_id, session_id, depth, kind, content, token_count,
              start_seq, end_seq, message_count, created_at, earliest_at, latest_at
       FROM summaries WHERE id IN (${placeholders})`
    )
    .all<{
      id: string;
      project_id: string;
      session_id: string;
      depth: number;
      kind: string;
      content: string;
      token_count: number;
      start_seq: number | null;
      end_seq: number | null;
      message_count: number;
      created_at: string;
      earliest_at: string | null;
      latest_at: string | null;
    }>(...parentIds);

  return rows.map((row) => {
    const parentIdsForRow = db
      .prepare(
        `SELECT parent_id FROM summary_parents WHERE summary_id = ?`
      )
      .all<{ parent_id: string }>(row.id)
      .map((r) => r.parent_id);

    const childIds = db
      .prepare(
        `SELECT summary_id FROM summary_parents WHERE parent_id = ?`
      )
      .all<{ summary_id: string }>(row.id)
      .map((r) => r.summary_id);

    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      depth: row.depth,
      kind: row.kind as "leaf" | "condensed" | "legacy" | "oversized",
      content: row.content,
      tokenCount: row.token_count,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      messageCount: row.message_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      parentIds: parentIdsForRow,
      childIds,
    };
  });
}

export function countSummaries(db: Db, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM summaries WHERE project_id = ?")
    .get<{ count: number }>(projectId);

  return row?.count ?? 0;
}
