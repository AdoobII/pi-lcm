/**
 * Statement returned by Db.prepare()
 */
export interface DbStatement {
  run(...args: unknown[]): void;
  get<T = unknown>(...args: unknown[]): T | undefined;
  all<T = unknown>(...args: unknown[]): T[];
}

/**
 * Database handle returned by openDatabase()
 */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

/**
 * Open a SQLite database. Uses bun:sqlite under Bun and node:sqlite under Node.
 */
export async function openDatabase(path: string): Promise<Db> {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

  if (isBun) {
    // Bun: use bun:sqlite
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Database } = await import("bun:sqlite" as any);
    const db = new Database(path);
    // Cast to our structural type
    return db as unknown as Db;
  } else {
    // Node: use node:sqlite via require to avoid Vite bundling issues
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };
    const db = new DatabaseSync(path);
    return {
      exec(sql: string): void {
        db.exec(sql);
      },
      prepare(sql: string): DbStatement {
        const stmt = db.prepare(sql);
        return {
          run(...args: unknown[]): void {
            stmt.run(...args);
          },
          get<T = unknown>(...args: unknown[]): T | undefined {
            return stmt.get(...args) as T | undefined;
          },
          all<T = unknown>(...args: unknown[]): T[] {
            return stmt.all(...args) as T[];
          },
        };
      },
      close(): void {
        db.close();
      },
    };
  }
}
