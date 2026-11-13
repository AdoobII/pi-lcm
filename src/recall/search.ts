import type { Db } from "../db/driver.js";
import type { SearchHit, SearchType } from "../types.js";
import { quoteFtsQuery } from "../util/fts.js";

const TYPE_WEIGHTS: Record<SearchType, number> = {
  memory: 1.0,
  summary: 0.9,
  message: 0.8,
};

// FTS snippet delimiters - use unlikely control characters
const SNIPPET_START = "\u0001";
const SNIPPET_END = "\u0002";

/**
 * Build the SELECT clause for FTS queries.
 * Handles the common pattern of bm25 and snippet with table-specific columns.
 */
function buildFtsSelect(
  tableAlias: string,
  ftsTable: string,
  hasSessionId: boolean,
  hasDepth: boolean
): string {
  const parts: string[] = [
    `${tableAlias}.id`,
    `${tableAlias}.created_at as createdAt`,
    `bm25(${ftsTable}) as bm25_rank`,
    `snippet(${ftsTable}, 0, '${SNIPPET_START}', '${SNIPPET_END}', '…', 12) as snippet`,
  ];
  
  if (hasSessionId) {
    parts.unshift(`${tableAlias}.session_id as sessionId`);
  }
  
  if (hasDepth) {
    parts.unshift(`${tableAlias}.depth`);
  }
  
  return parts.join(", ");
}

interface RawHit {
  type: SearchType;
  id: string;
  rank: number;
  snippet: string;
  createdAt: string;
  sessionId?: string;
  depth?: number;
}

function normalizeRank(minRank: number, maxRank: number, rank: number): number {
  if (maxRank === minRank) {
    return 1;
  }
  return (maxRank - rank) / (maxRank - minRank);
}

function queryTable(
  db: Db,
  projectId: string,
  type: SearchType,
  quotedQuery: string,
  limit: number
): RawHit[] {
  const tableMap: Record<SearchType, { table: string; ftsTable: string }> = {
    message: { table: "messages", ftsTable: "messages_fts" },
    summary: { table: "summaries", ftsTable: "summaries_fts" },
    memory: { table: "memories", ftsTable: "memories_fts" },
  };

  const { table, ftsTable } = tableMap[type];

  // For messages, we need to join on messages_fts.rowid = messages.id
  // For summaries and memories, we join on ftsTable.rowid = table.rowid
  const isMessages = type === "message";
  const tableAlias = isMessages ? "msg" : type === "summary" ? "s" : "mem";

  const joinCondition = isMessages
    ? `${ftsTable}.rowid = ${tableAlias}.id`
    : `${ftsTable}.rowid = ${tableAlias}.rowid`;

  // Select appropriate columns based on table
  const selectCols = buildFtsSelect(
    tableAlias,
    ftsTable,
    type !== "memory",
    type === "summary"
  );

  const query = `
    SELECT ${selectCols}
    FROM ${table} ${tableAlias}
    JOIN ${ftsTable} ON ${joinCondition}
    WHERE ${tableAlias}.project_id = ? AND ${ftsTable} MATCH ?
    ORDER BY bm25_rank ASC
    LIMIT ?
  `;

  const rows = db.prepare(query).all<{
    id: string;
    sessionId?: string;
    depth?: number;
    createdAt: string;
    bm25_rank: number;
    snippet: string;
  }>(projectId, quotedQuery, limit);

  return rows.map((row) => ({
    type,
    id: row.id,
    rank: row.bm25_rank,
    snippet: row.snippet ?? "",
    createdAt: row.createdAt,
    sessionId: row.sessionId,
    depth: row.depth,
  }));
}

export function searchAll(
  db: Db,
  projectId: string,
  query: string,
  opts: { limit: number; types?: SearchType[] }
): SearchHit[] {
  const { limit, types = ["message", "summary", "memory"] } = opts;

  // Empty or whitespace-only queries return empty array
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return [];
  }

  const quotedQuery = quoteFtsQuery(trimmedQuery);
  
  // If quoteFtsQuery returns empty string (no valid terms), return empty
  if (quotedQuery === "") {
    return [];
  }

  const allRawHits: RawHit[] = [];

  for (const type of types) {
    try {
      const rawHits = queryTable(db, projectId, type, quotedQuery, limit);
      allRawHits.push(...rawHits);
    } catch (e) {
      // Only skip if the table genuinely doesn't exist
      const err = e as Error;
      if (err.message?.toLowerCase().includes("no such table")) {
        continue;
      }
      throw e;
    }
  }

  if (allRawHits.length === 0) {
    return [];
  }

  // Group by type to normalize ranks within each type
  const hitsByType: Record<SearchType, RawHit[]> = {
    message: [],
    summary: [],
    memory: [],
  };

  for (const hit of allRawHits) {
    hitsByType[hit.type].push(hit);
  }

  // Normalize ranks and apply weights for each type
  const scoredHits: SearchHit[] = [];

  for (const type of types) {
    const typeHits = hitsByType[type];
    if (typeHits.length === 0) {
      continue;
    }

    const ranks = typeHits.map((h) => h.rank);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const weight = TYPE_WEIGHTS[type];

    for (const hit of typeHits) {
      const normalized = normalizeRank(minRank, maxRank, hit.rank);
      const score = normalized * weight;

      scoredHits.push({
        type: hit.type,
        id: hit.id,
        score,
        snippet: hit.snippet,
        createdAt: hit.createdAt,
        sessionId: hit.sessionId,
        depth: hit.depth,
      });
    }
  }

  // Sort by score descending, then by createdAt descending
  scoredHits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  // Slice to limit
  return scoredHits.slice(0, limit);
}
