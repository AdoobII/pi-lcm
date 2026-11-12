/**
 * Minimal type declarations for node:sqlite module
 * This module is experimental in Node.js and may not have @types available
 */
declare module "node:sqlite" {
  export class StatementSync {
    run(...args: unknown[]): void;
    get<T = unknown>(...args: unknown[]): T | undefined;
    all<T = unknown>(...args: unknown[]): T[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
