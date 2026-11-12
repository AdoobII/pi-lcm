/**
 * Quote an FTS5 query string by splitting on whitespace, dropping empty terms,
 * stripping existing double quotes, wrapping each term in double quotes, and
 * joining with AND.
 */
export function quoteFtsQuery(query: string): string {
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return "";
  }
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
}
