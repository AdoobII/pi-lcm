import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/driver.js";
import type { Memory, SearchHit } from "../types.js";
import { quoteFtsQuery } from "../util/fts.js";

/**
 * Normalize content for deduplication: trim, collapse whitespace, lowercase.
 */
function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Compute SHA-256 hash of normalized content.
 */
function contentHash(content: string): string {
  const normalized = normalizeContent(content);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Insert a memory. Deduplicates by (project_id, content_hash) using INSERT OR IGNORE.
 * Tags are stored as JSON text and parsed on read.
 */
export function insertMemory(
  db: Db,
  projectId: string,
  content: string,
  tags: string[],
  source: "manual" | "auto"
): Memory {
  const id = randomUUID();
  const hash = contentHash(content);
  const tagsJson = JSON.stringify(tags);
  const now = new Date().toISOString();

  // Try to insert, but ignore if duplicate (based on project_id + content_hash)
  db.prepare(
    `INSERT OR IGNORE INTO memories 
     (id, project_id, content, tags, source, created_at, last_used_at, use_count, content_hash) 
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(id, projectId, content, tagsJson, source, now, hash);

  // Select the memory (either the one we just inserted or the existing duplicate)
  const row = db.prepare(
    `SELECT id, project_id, content, tags, source, created_at, last_used_at, use_count 
     FROM memories 
     WHERE project_id = ? AND content_hash = ?`
  ).get<{
    id: string;
    project_id: string;
    content: string;
    tags: string;
    source: "manual" | "auto";
    created_at: string;
    last_used_at: string | null;
    use_count: number;
  }>(projectId, hash);

  if (!row) {
    throw new Error("Failed to insert or retrieve memory");
  }

  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    tags: JSON.parse(row.tags),
    source: row.source,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

/**
 * Search memories using FTS5 with the quoted query.
 */
export function searchMemories(
  db: Db,
  projectId: string,
  query: string,
  limit: number
): SearchHit[] {
  const quotedQuery = quoteFtsQuery(query);
  if (quotedQuery === "") {
    return [];
  }

  const rows = db.prepare(
    `SELECT 
      m.id,
      m.project_id,
      m.content,
      m.tags,
      m.source,
      m.created_at,
      m.last_used_at,
      m.use_count,
      memories_fts.rank as score,
      snippet(memories_fts, 1, '<b>', '</b>', '...', 16) as snippet
     FROM memories m
     JOIN memories_fts ON m.rowid = memories_fts.rowid
     WHERE m.project_id = ? AND memories_fts MATCH ?
     ORDER BY memories_fts.rank DESC
     LIMIT ?`
  ).all<{
    id: string;
    project_id: string;
    content: string;
    tags: string;
    source: "manual" | "auto";
    created_at: string;
    last_used_at: string | null;
    use_count: number;
    score: number;
    snippet: string;
  }>(projectId, quotedQuery, limit);

  return rows.map((row) => ({
    type: "memory" as const,
    id: row.id,
    score: row.score,
    snippet: row.snippet,
    createdAt: row.created_at,
  }));
}

/**
 * Get recent memories ordered by use_count DESC, then created_at DESC.
 */
export function recentMemories(
  db: Db,
  projectId: string,
  limit: number
): Memory[] {
  const rows = db.prepare(
    `SELECT id, project_id, content, tags, source, created_at, last_used_at, use_count 
     FROM memories 
     WHERE project_id = ?
     ORDER BY use_count DESC, created_at DESC
     LIMIT ?`
  ).all<{
    id: string;
    project_id: string;
    content: string;
    tags: string;
    source: "manual" | "auto";
    created_at: string;
    last_used_at: string | null;
    use_count: number;
  }>(projectId, limit);

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    tags: JSON.parse(row.tags),
    source: row.source,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  }));
}

/**
 * Mark a memory as used: increment use_count and set last_used_at.
 */
export function markMemoryUsed(db: Db, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`
  ).run(now, id);
}

/**
 * Count memories for a project.
 */
export function countMemories(db: Db, projectId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE project_id = ?`
  ).get<{ count: number }>(projectId);
  return row?.count ?? 0;
}
