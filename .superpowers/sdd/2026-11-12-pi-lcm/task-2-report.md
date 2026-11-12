# Task 2: SQLite Driver, Schema, and Migrations - Implementation Report

## Summary
Successfully implemented the SQLite driver, schema definitions, and migration system as specified in the brief.

## TDD Evidence

### RED Phase
**Command:** `npm test -- tests/unit/db.test.ts`

**Output:**
```
 FAIL  tests/unit/db.test.ts [ tests/unit/db.test.ts ]
Error: Failed to load url ../../src/db/driver.js (resolved id: ../../src/db/driver.js). Does the file exist?
```

**Why it failed:** The test file was created but the implementation files (`src/db/driver.ts` and `src/db/schema.ts`) did not exist yet, causing the module import to fail.

### GREEN Phase
**Command:** `npm test -- tests/unit/db.test.ts`

**Output:**
```
(node:25975) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 ✓ tests/unit/db.test.ts (3 tests) 11ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**Result:** All 3 tests pass:
1. ✅ creates every table and records the version
2. ✅ indexes messages with FTS5
3. ✅ is idempotent and rejects a newer schema

## Implementation Details

### Files Created

1. **`src/db/driver.ts`**
   - Exports `Db` and `DbStatement` interfaces matching the brief specification
   - Implements `openDatabase(path: string): Promise<Db>`
   - Detects runtime environment (Bun vs Node) using `typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"`
   - Uses `bun:sqlite` under Bun (via dynamic import)
   - Uses `node:sqlite` under Node (via `require` to avoid Vite bundling issues with `node:` prefix)
   - Both adapters expose `exec(sql)`, `prepare(sql)` returning `{ run, get, all }`, and `close()`

2. **`src/db/schema.ts`**
   - Exports `SCHEMA_VERSION = 1`
   - Exports `SchemaTooNewError` class (extends `Error`)
   - Implements `migrate(db: Db): void` function
   - Schema includes all required tables: `projects`, `sessions`, `messages`, `summaries`, `summary_messages`, `summary_parents`, `memories`, `meta`
   - FTS5 virtual tables: `messages_fts`, `summaries_fts`, `memories_fts`
   - Triggers for FTS5 tables (ai, ad, au) for insert, delete, update operations
   - Indexes on `messages(session_id, seq)`, `summaries(session_id, depth)`, `summary_messages(message_id)`, `summary_parents(parent_id)`, `memories(project_id)`
   - Column defaults match brief exactly: `created_at` columns use `TEXT NOT NULL DEFAULT (datetime('now'))`
   - `messages.role` has CHECK constraint: `CHECK(role IN ('user','assistant','toolResult','custom','bashExecution'))`
   - `sessions.session_file` is nullable
   - Migration is idempotent and synchronous
   - Throws `SchemaTooNewError` when stored version > `SCHEMA_VERSION`
   - Handles `:memory:` databases (WAL mode failure is caught and ignored)

3. **`tests/unit/db.test.ts`**
   - Contains all 3 tests from the brief
   - Tests table creation, FTS5 indexing, and migration idempotency

### Technical Challenges and Solutions

1. **Vite/Vitest Bundling Issue with `node:sqlite`**
   - Problem: Vite was transforming `import("node:sqlite")` to `import("sqlite")`, causing module resolution to fail
   - Solution: Used `require("node:sqlite")` for Node.js environment, which works correctly at runtime
   - Bun import remains as dynamic import since it's only loaded when Bun is detected

2. **Type Safety**
   - Used TypeScript type assertions to ensure the Bun Database type matches our `Db` interface
   - All types are properly typed without adding runtime dependencies

### Validation

- ✅ All 3 tests pass
- ✅ `npm run typecheck` passes with no errors
- ✅ No runtime dependencies added
- ✅ Works with `:memory:` databases for testing
- ✅ Schema matches brief specification exactly

## Files Changed
- `src/db/driver.ts` (new)
- `src/db/schema.ts` (new)
- `tests/unit/db.test.ts` (new)

## Commit
```
feat: add sqlite driver and schema migrations
3 files changed, 326 insertions(+)
```

---

## Fix Report (Task 2 Review)

### Changes Made

1. **Created `src/node-sqlite.d.ts`**
   - Added minimal type declarations for `node:sqlite` module
   - Declares `export class DatabaseSync` and `export class StatementSync` (not interfaces) so `new DatabaseSync(path)` type-checks correctly
   - Enables type-safe usage of `node:sqlite` without runtime dependencies

2. **Updated `src/db/driver.ts`**
   - Added local structural type `BunDatabase` for Bun's SQLite Database to avoid `as any` cast
   - Replaced `require("node:sqlite")` with `createRequire(import.meta.url)("node:sqlite")` from `node:module`
     - This works in Node ESM, Vitest, and jiti
     - Avoids Vite's dynamic-import transformation of `node:` protocol URLs
     - Added comment explaining why `createRequire` is used
   - Kept `await import("bun:sqlite")` for Bun path

### Covering Tests

**Command:** `npm test -- tests/unit/db.test.ts`

**Output:**
```
> pi-lcm@0.1.0 test
> vitest run tests/unit/db.test.ts

 RUN  v2.1.9 /mnt/c/Users/Adib/dev/repos/pi-lcm

(node:30922) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/unit/db.test.ts (3 tests) 11ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

**Command:** `npm run typecheck`

**Output:**
```
> pi-lcm@0.1.0 typecheck
> tsc --noEmit
```
(No errors)

### Files Changed
- `src/node-sqlite.d.ts` (new)
- `src/db/driver.ts` (updated)
- `.superpowers/sdd/2026-11-12-pi-lcm/task-2-report.md` (updated)
