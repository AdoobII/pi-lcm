# pi-lcm: lossless context and memory for Pi

Date: 2026-11-12
Status: proposed

## Intent

Pi's compaction replaces dropped history with one flat summary. Once compacted, the detail is gone from the model's context, there is only one summary layer, and nothing carries across sessions. `pi-lcm` gives Pi a persistent, searchable memory: every message is stored, dropped history is compressed into a DAG of summaries instead of a single one, durable memories are promoted across sessions, and the model can search and expand exact history on demand.

The extension is standalone: no daemon, no external service, no native dependencies. It ships as a Pi package and uses `node:sqlite` (or `bun:sqlite` under Bun) with FTS5.

## Why now

- Pi exposes `session_before_compact`, which lets an extension return its own compaction and replace the built-in summarizer. lcm's design notes say Claude Code, Codex, and OMP cannot do this; Pi can.
- Pi's session files are already append-only JSONL trees, so the extension can mirror exact history without inventing a capture path.
- `node:sqlite` with FTS5 is available on Pi's minimum Node version (22.19), so BM25 search needs no dependency.

## Goals

1. Persist every model-visible message per project, keyed by Pi session entry ID, and index it with FTS5.
2. Own compaction: on `session_before_compact`, summarize the dropped span into leaf summaries, condense into a DAG, and return a rendered context window with `sum_` ids. Pi's flat summarizer does not run.
3. Keep the fresh tail raw, respecting Pi's `firstKeptEntryId`.
4. Provide native tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_store`, `lcm_stats`.
5. Store durable memories (explicit and auto-extracted) per project and recall them at session start and per prompt.
6. Fail open: any failure falls back to Pi's default compaction or no injection.
7. Zero native dependencies; works on Node >=22.19 and Bun.

## Non-goals

- MCP server. Pi tools are native; MCP can wrap the same store later.
- Passive tool-event learning (lcm's sidecar), project timeline, large-file extraction, commit attribution.
- Cross-harness shared store with lcm. A future adapter can sync, but v1 is its own store.
- Subagent transcripts.
- Branch summarization ownership (`session_before_tree`). v1 stores branch summaries as searchable nodes and lets Pi summarize.

## Anti-goals

- Losing a message. Raw messages stay in SQLite after summarization.
- Blocking a turn on memory work. Persistence is synchronous and small; summarization only runs inside compaction, which already blocks.
- Making compaction worse. If our summary is empty, fails, or cannot cover the span, return `undefined` and let Pi compact normally.
- Injecting noise. Recall is score-gated, token-capped, and never repeats a memory already surfaced in the session.
- Silently substituting a model. If no summarizer model is chosen, pi-lcm skips summarization rather than guessing.

## Constraints

- Node >=22.19 (Pi's floor); `node:sqlite` is experimental and prints a warning. Bun needs `bun:sqlite`; a thin driver adapter covers both.
- Extension runs in-process via jiti; TypeScript is loaded directly.
- Distribution as a Pi package: `peerDependencies` on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, no host packages in `dependencies`.
- `session_before_compact` gives `preparation.messagesToSummarize`, `turnPrefixMessages`, `previousSummary`, `firstKeptEntryId`, `tokensBefore`, `branchEntries`, `customInstructions`, `signal`.
- Summarizer calls go through `ctx.modelRegistry.complete(model, context, options)`.
- Pi's `serializeConversation` truncates tool results to 2000 characters; that is acceptable for summarizer input.

## Approaches considered

**A. Standalone Pi extension (chosen).** Own SQLite store, own DAG, own tools. No daemon. Cleanest fit; owns compaction end-to-end; zero external dependencies. Cost: the most code.

**B. lcm daemon client.** Port `hooks/omp/lcm.ts`; reuse lcm's store, summaries, promoted memory, passive learning, timeline. Cross-harness memory for free. Cost: requires lcm installed and running, couples to its HTTP protocol and versioning.

**C. Hybrid.** Standalone now, lcm-compatible schema for a later sync. Cost: schema constraint for a maybe.

A was chosen because the request is a Pi-native extension, and Pi's compaction seam lets it own the whole loop without a daemon.

## Architecture

```
src/
  index.ts            extension factory; event wiring; lifecycle
  config.ts           config load/merge (project + global + env)
  db/
    driver.ts         node:sqlite / bun:sqlite adapter
    schema.ts         tables, FTS5, triggers, migrations
  store/
    projects.ts       project identity (git root hash)
    sessions.ts       session registry and sync cursors
    messages.ts       persist entries, seq ranges, queries
    summaries.ts      DAG nodes, edges, roots/leaves, coverage
    memories.ts       CRUD, dedupe, FTS
  compact/
    engine.ts         compaction orchestration
    chunk.ts          token-budgeted chunking
    prompts.ts        leaf/condensed/prefix prompts
    render.ts         context window rendering
  recall/
    search.ts         BM25 across messages/summaries/memories
    inject.ts         restore + prompt-time blocks
  tools/
    grep.ts describe.ts expand.ts store.ts stats.ts
  util/
    tokens.ts log.ts
```

### Data model

- `projects(id TEXT PK, root TEXT, created_at)` — `id` is a short hash of the git root (or cwd).
- `sessions(id TEXT PK, project_id, cwd, session_file, created_at, updated_at)`
- `messages(id INTEGER PK AUTOINCREMENT, project_id, session_id, entry_id TEXT, seq INTEGER, role, content, token_count, created_at, event_at, UNIQUE(session_id, entry_id))`
- `summaries(id TEXT PK, project_id, session_id, depth, kind, content, token_count, start_seq, end_seq, message_count, created_at, earliest_at, latest_at)`
- `summary_messages(summary_id, message_id)` — authoritative coverage
- `summary_parents(child_id, parent_id)`
- `memories(id TEXT PK, project_id, content, tags TEXT, source, content_hash, created_at, last_used_at, use_count, UNIQUE(project_id, content_hash))`
- `meta(key, value)` — `schema_version` and extension state
- FTS5: `messages_fts(content)`, `summaries_fts(content)`, `memories_fts(content, tags)`, external-content with triggers.

One row per session entry. If an entry projects to more than one model-visible message (context edits), their text is concatenated in projection order; `entry_id` stays unique. `messages.seq` is per-session insertion order and is used for display and ordering only. Summary coverage is the set of `summary_messages` rows, not a seq range: a branch switch can interleave insertion order, so a range would over-cover abandoned branches. `start_seq`/`end_seq` are denormalized bounds for display, and `lcm_expand` reads `summary_messages`.

### Persistence

Triggered on `session_start`, `turn_end`, `agent_settled`, and `session_tree`:
- Walk `ctx.sessionManager.getBranch()` from the last synced entry ID; on `session_tree`, reset the cursor and re-sync the new branch.
- Insert unseen entries of type `message` whose role is user, assistant, toolResult, or custom. Skip system messages and thinking blocks.
- Extract text: user text; assistant text plus tool calls rendered as `[Tool name] input`; tool results (text, capped at 100k chars); custom content (skipping `pi-lcm:*` injection types).
- Assign `seq`, token estimate (`ceil(chars / 4)`), timestamps.
- Batch in one transaction; FTS triggers index.
- Idempotent: `UNIQUE(session_id, entry_id)` with `INSERT OR IGNORE`.

### Compaction

On `session_before_compact`:

1. Sync messages through `branchEntries`.
2. Compute the span from `branchEntries` in branch order. Start at the first message entry at or after the previous compaction's `firstKeptEntryId` (or at the first message entry when there is no compaction). End before the entry named by `preparation.firstKeptEntryId`. If `firstKeptEntryId` is not a message entry, walk forward to the next message entry. If the boundary cannot be resolved, return `undefined`.
3. Look up the span's persisted rows by `entry_id`, preserving branch order. The span is empty only when there is nothing to summarize; in that case return `undefined`.
4. If the previous compaction was not ours and `preparation.previousSummary` exists, store it as a `legacy` node with no coverage so it survives. Legacy nodes render and search but `lcm_expand` reports that their sources predate the store.
5. Chunk the span by `leafSummaryBudget` tokens (default 1200), never splitting a tool call from its result.
6. For each chunk, call the summarizer with the leaf prompt. Store a depth-0 node and one `summary_messages` row per message in the chunk. On failure, retry once as a single chunk; if that fails, return `undefined`.
7. Condense: while any depth `d` has at least `condenseThreshold` (default 4) unparented nodes, summarize them into one depth-`d+1` node and link parents. Stop at `maxDepth` (default 5).
8. Render: highest-depth roots first, then recent leaves not covered by roots, under `renderBudget` (default 6000 tokens). Each node renders as `Summary [sum_…]:` plus its text and an `Expand for details about:` footer. Prepend the legacy/previous summary when present. If the window exceeds the budget, drop the oldest leaves first; roots are never dropped.

Rendered shape:

```text
<lcm-context version="1">
Summary [sum_1a2b3c4d5e6f7890]:
## Goal
...
Expand for details about: exact commands, file paths, error text

Summary [sum_...]:
...
</lcm-context>
```

9. Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage, details: { lcm: { version: 1, nodeIds } } } }`.

The summarizer prompt asks for Pi's structured format (Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context), an `Expand for details about:` footer, and a `<memories>` JSON block of durable insights. `customInstructions` from `/compact` is appended as operator directions.

Cost cap: if the span would produce more than `maxChunks` (default 20) chunks, widen chunks up to the summarizer model's input limit. If the span still does not fit one call, make one oversized-window node covering the whole span rather than falling back to Pi, so nothing is lost. The node records `kind: "oversized"` and renders with a note.

On `session_compact`, if `fromExtension` is false (Pi's default ran), store the produced summary as a `legacy` node with coverage computed the same way as step 2, so it remains searchable and expandable.

On `session_tree`, store Pi's branch summary as a `legacy` node with no coverage.

### Search ranking

BM25 scores are not comparable across the three FTS tables. Each table's results are ranked independently, normalized to `0..1` within the result set, then merged with type weights (`memories` 1.0, `summaries` 0.9, `messages` 0.8). Ties break by recency. User queries are tokenized and each term quoted before being joined with `AND`, so FTS operators in a query are treated as text.

### Memory

- `lcm_store` inserts a memory with tags, deduped by content hash per project.
- Auto-extraction: parsed from the `<memories>` block during compaction; stored with `source: "auto"` and `type:` tags from the model.
- Recall at session start: up to `restoreMemories` (default 20) most recent or most reused memories plus the latest summaries from other sessions, injected once as a hidden custom message at the first `before_agent_start`.
- Per-prompt recall: BM25 search on the prompt across memories and summaries; inject up to `recallLimit` (default 5) results above `recallThreshold`, token-capped, as a hidden `<memory-context>` custom message. Never re-surface an id already surfaced in the session.
- Injected blocks end with `<!-- surfaced-memory-ids: ... -->` so the model can cite them.

### Commands

- `/lcm-model` — reopen the summarizer model picker and persist the choice.

### Tools

- `lcm_grep(query, limit?, type?)` — BM25 over messages, summaries, memories; returns id, type, score, snippet, timestamp.
- `lcm_describe(id)` — node or session metadata: depth, covered message count, seq bounds, parent/child ids, timestamps, token count.
- `lcm_expand(target, format?)` — `sum_…` expands its `summary_messages` links; `messages:N-M` expands a seq range; free text runs a search then expands the top hit. Bounded to `expandBudget` tokens.
- `lcm_store(content, tags?)` — persist a memory.
- `lcm_stats()` — counts, DB path, token savings, compaction count.

Tools use TypeBox schemas and return `{ content, details }`. `promptGuidelines` teach the escalation order (grep, then describe, then expand).

### Config

Separate files, merged: `~/.pi/agent/lcm.json`, `<project>/.pi/lcm.json`, env `PI_LCM_*`. Keys: `dbPath`, `model`, `leafSummaryBudget`, `condensedSummaryBudget`, `condenseThreshold`, `maxDepth`, `maxChunks`, `renderBudget`, `restoreMemories`, `recallLimit`, `recallThreshold`, `autoMemories`, `storeThinking`, `debug`. Defaults live in `config.ts`.

A separate file avoids depending on Pi's settings schema and lets the extension work without project trust for global config.

### Summarizer model selection

`model` is `provider/id` (for example `anthropic/claude-haiku-4-5`). Resolution order:

1. `PI_LCM_MODEL`
2. `model` in `.pi/lcm.json` or `~/.pi/agent/lcm.json`
3. A one-time interactive choice, persisted to `~/.pi/agent/lcm.json`
4. The sentinel `"active"` resolves to `ctx.model`

On `session_start` in TUI or RPC mode (`ctx.hasUI` true), when no model is configured, pi-lcm shows a `ctx.ui.select` of `ctx.modelRegistry.getAvailable()` labeled `provider/id`, plus `Use the active session model` and `Skip pi-lcm compaction`. The choice is persisted, so the prompt appears once. `/lcm-model` reopens it. If the user skips, pi-lcm does not summarize for that session and Pi's default compaction runs; the prompt returns next session.

Print and JSON modes cannot prompt (`ctx.hasUI` false). With no configured model there, pi-lcm does not summarize: Pi's default compaction runs, and one warning is written to the log. Set `model` or `PI_LCM_MODEL` to enable pi-lcm compaction in automation. The `"active"` sentinel is the explicit way to use the session model in every mode.

### Failure and edge cases

- Every handler is wrapped; errors go to `~/.pi/agent/lcm/pi-lcm.log` (rotated at 1 MB) and are swallowed.
- `session_before_compact` returns `undefined` on any failure.
- Recall injection returns nothing on failure.
- DB open failure disables the extension for the session with one `ctx.ui.notify` when UI is present.
- `isCompacting` guard prevents re-entrant compaction.
- WAL, `busy_timeout=5000`, `foreign_keys=ON`, short transactions.
- Schema changes are sequential migrations keyed by `meta.schema_version`; a newer database than the extension understands disables the extension instead of writing.
- Images in messages are stored as `[image]`; thinking blocks are skipped unless `storeThinking` is on.
- A branch switch (`/tree`) resets the sync cursor and re-syncs the new branch. Abandoned-branch rows stay stored and searchable but are never covered by a summary on the new branch.
- `/fork` and `/new` create new session IDs; entries sync under the new ID on `session_start`.
- FTS queries quote user terms to avoid operator injection.
- If a configured model cannot be resolved, pi-lcm skips summarization for the session and logs the error; it does not silently substitute another model. `"active"` is the explicit way to use `ctx.model`.
- Chunks are also capped by the summarizer model's context window, not just `leafSummaryBudget`.
- Summarizer `usage` is returned to Pi so session totals include it.

### Testing

- Unit: token estimation, chunking (tool-call pairing), DAG condensation, rendering budget, coverage links, FTS search, memory dedupe, config merge.
- Integration: a fake `ExtensionAPI`/`ExtensionContext` harness drives `session_start`, `turn_end`, `session_before_compact`, and the tools against an in-memory DB; asserts a valid `CompactionResult`, coverage of every dropped message, and fallback on summarizer failure.
- Manual: `pi -e ./` in a scratch repo; `/compact`; `lcm_grep`, `lcm_expand`, `lcm_store`; restart and verify restore.

### Packaging

- `package.json`: `"name": "pi-lcm"`, `"pi": { "extensions": ["./src/index.ts"] }`, `peerDependencies` on the two Pi packages, no runtime dependencies.
- Install: `pi install npm:pi-lcm` or `pi -e ./pi-lcm`.
- `README.md` with install, config, tools, privacy.

## Decisions made (my calls)

- Store per project under `<project root>/.pi/lcm/<project-hash>.db`, using Pi's `CONFIG_DIR_NAME` instead of a hardcoded `.pi`. The extension writes `.pi/lcm/.gitignore` containing `*` so the database is never committed. `dbPath` overrides the location. When the project is untrusted (`ctx.isProjectTrusted()` false), the extension falls back to `~/.pi/agent/lcm/<project-hash>.db` rather than writing into a repo the user has not trusted.
- Coverage by `summary_messages` links built from the branch span, with seq bounds only for display. Deterministic, branch-safe, and robust to Pi's projection copying messages.
- Summaries are created only during compaction in v1. No background summarizer, no concurrency. Search still covers all raw messages.
- The compaction span is derived from `branchEntries` order and looked up by `entry_id`, so branch switches cannot pull abandoned messages into a summary.
- The summarizer model is chosen once interactively and persisted. With no chosen model, pi-lcm skips summarization in every mode, including print/JSON; `/lcm-model` changes it later. `"active"` is the explicit opt-in to the session model.
- Skip thinking blocks and system messages from storage.
- No `context` hook in v1; recall injects at `before_agent_start`.
- Auto-extracted memories are on by default; `autoMemories: false` disables.

## Left to the builder

- Exact prompt wording and the `<memories>` schema.
- Model picker labels and ordering.
- FTS5 tokenizer choice (`unicode61 remove_diacritics 2` versus `porter`).
- Injection thresholds and budgets after dogfooding.
- Tool rendering in the TUI.
- Schema migration strategy after v1.
- Whether to add background summarization later.

## Open questions

None blocking.
