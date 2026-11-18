# pi-lcm: lossless context and memory for Pi

`pi-lcm` persists every message you exchange with Pi, owns compaction with a DAG of summaries, and stores durable memories that carry across sessions. It replaces Pi's flat summarizer with a hierarchical one: dropped history is compressed into leaf summaries, which are then condensed into higher-level summaries, forming a directed acyclic graph that preserves the full conversation history while staying within context limits.

## Install

```bash
# From the Pi package registry
pi install npm:pi-lcm

# Or from a local checkout
pi -e ./pi-lcm
```

## First run

On first activation, pi-lcm has no summarizer model configured. You must choose one:

- Use the model picker: run `/lcm-model` and select from available models.
- Or set `PI_LCM_MODEL` in your environment.

Until a model is chosen, pi-lcm **will not perform summarization**. It will still persist messages and fall back to Pi's default compaction. In print mode and JSON mode, if no model is chosen, pi-lcm skips all compaction work entirely.

## Configuration

Configuration is loaded from three sources in order (later overrides earlier):

1. **Global config**: `~/.pi/agent/lcm.json`
2. **Project config**: `<project>/.pi/lcm.json` (only when the project is trusted)
3. **Environment variables**: `PI_LCM_MODEL`, `PI_LCM_DB_PATH`, `PI_LCM_DEBUG`, `PI_LCM_COMPACT_TRIGGER`

All keys and their defaults:

| Key | Default | Description |
|-----|---------|-------------|
| `dbPath` | `null` | Custom path to the SQLite database. If relative, resolved from project root. |
| `model` | `null` | Model to use for summarization. Must be set for compaction to work. |
| `leafSummaryBudget` | `1200` | Token budget for leaf summaries (first-level compaction). |
| `condensedSummaryBudget` | `2000` | Token budget for condensed summaries (higher-level compaction). |
| `condenseThreshold` | `4` | Minimum number of child summaries before condensing. |
| `maxDepth` | `5` | Maximum depth of the summary DAG. |
| `maxChunks` | `20` | Maximum number of chunks to process in one compaction. |
| `renderBudget` | `6000` | Token budget for rendering the context window from summaries. |
| `expandBudget` | `20000` | Token budget for expanding messages in `lcm_expand`. |
| `restoreMemories` | `20` | Maximum number of memories to restore at session start. |
| `recallLimit` | `5` | Maximum number of memories to inject per prompt. |
| `recallThreshold` | `0.35` | Minimum BM25 score for memory recall. |
| `autoMemories` | `true` | Whether to automatically extract and store memories. |
| `storeThinking` | `false` | Whether to store thinking blocks. Disabled by default for privacy. |
| `compactionFocus` | list of decisions, file paths, commit hashes, open threads, preferences and ledger or plan paths | Instructions sent to the summarizer for leaf and condensed summaries, after any `/compact` instructions. Set to `""` to send none. A non-string value is ignored. |
| `compactionTrigger` | `null` | When compaction starts, as `{"mode": "percent", "value": 40}` (share of the context window, 5 to 90), `{"mode": "tokens", "value": 400000}` (token count, at least 20000 and below the model's window) or `{"mode": "off", "value": 0}`. `null` means no trigger has been chosen. Invalid values are ignored. `PI_LCM_COMPACT_TRIGGER` overrides it and accepts `40%`, `400k`, `400000`, `1.5m` or `off`. |
| `debug` | `false` | Enable verbose logging. |

Example `~/.pi/agent/lcm.json`:

```json
{
  "model": "gpt-4o-mini",
  "leafSummaryBudget": 1500,
  "condensedSummaryBudget": 2500,
  "debug": true
}
```

## Tools

pi-lcm provides five native tools for exploring and managing your conversation history and memories.

### `lcm_grep`

Search across messages, summaries, and memories using BM25 full-text search.

**Parameters:**
- `query` (required): Search query string
- `limit` (optional, default: 10): Maximum number of results
- `type` (optional, default: "all"): Filter by type: "all", "messages", "summaries", or "memories"

**Usage:** Start here when you need to find something. Use grep first, then describe or expand for detail.

### `lcm_describe`

Get metadata about a summary or session without loading full content.

**Parameters:**
- `id` (required): Summary ID (starting with `sum_`) or session ID

**Usage:** After finding a summary with grep, use describe to understand its structure, depth, message count, and relationships before expanding.

### `lcm_expand`

Expand a summary, message range, or search result to see full content.

**Parameters:**
- `target` (required): Target to expand. Can be:
  - `sum_<id>`: A summary ID
  - `messages:N-M`: A message sequence range (inclusive)
  - Free text: Searches for the top matching summary and expands it
- `format` (optional, default: "full"): Output format: "full" or "condensed"

**Usage:** Use expand when you need exact detail from a summary or message range. The escalation path is: grep → describe → expand.

### `lcm_store`

Store a durable memory with optional tags.

**Parameters:**
- `content` (required): Memory content to store
- `tags` (optional): Array of tags for categorization (use `type:` prefix for categories, e.g., `type:preference`, `type:lesson`)

**Usage:** Store important insights, preferences, or lessons. Always include type tags to categorize memories.

### `lcm_stats`

Get statistics about the memory store.

**Parameters:** None

**Output includes:**
- Total messages, summaries, and memories
- Database path
- Token savings from compaction (raw message tokens minus summary tokens)
- Number of compactions performed

## Database location

By default, the SQLite database is stored at:

```
<project root>/.pi/lcm/<project-hash>.db
```

The `.pi/lcm/` directory contains a `.gitignore` file that ignores all `*.db` files, so the database won't be committed to version control.

If the project is not trusted (e.g., in an untrusted workspace), the database falls back to:

```
~/.pi/agent/lcm/<project-hash>.db
```

You can override the database path with the `dbPath` config key or the `PI_LCM_DB_PATH` environment variable.

To delete the database, simply remove the `.db` file. The next session will create a fresh database.

## Privacy

- **Local storage**: All messages, summaries, and memories are stored locally in SQLite. No data leaves your machine unless you explicitly share it.
- **Summarizer model**: The summarizer sends conversation content to the configured model provider for summarization. This is necessary to generate summaries but means that summarized content is shared with the model provider.
- **Thinking blocks**: By default, thinking blocks are **not stored** (`storeThinking: false`). Enable `storeThinking: true` if you want thinking content persisted.
- **No telemetry**: pi-lcm does not collect or transmit any usage data.

## Troubleshooting

### No model chosen

If you see messages like "no summarizer model configured" or compaction isn't working:

1. Run `/lcm-model` to pick a model interactively
2. Or set `PI_LCM_MODEL` in your environment: `export PI_LCM_MODEL=gpt-4o-mini`
3. Or add `"model": "your-model-name"` to `~/.pi/agent/lcm.json`

Without a model, pi-lcm will fall back to Pi's default compaction.

### FTS unavailable

If full-text search fails with "FTS5 not available", your SQLite build may not have FTS5 support. This is rare on modern systems. pi-lcm will log a warning and continue without search functionality.

### DB locked

If you see "database is locked" errors:

1. Ensure no other process is accessing the database
2. Check for stale Pi processes that might have open database handles
3. The database should auto-recover on next access

### Schema too new

If you see "schema version mismatch" errors, the database was created with a newer version of pi-lcm. To fix:

1. Delete the database file (see Database location above)
2. A fresh database will be created with the current schema

### How to delete the database

To start fresh:

```bash
# For a project database
rm <project root>/.pi/lcm/<project-hash>.db

# For the global fallback database
rm ~/.pi/agent/lcm/<project-hash>.db

# Or use your config's custom dbPath
rm $(jq -r '.dbPath' ~/.pi/agent/lcm.json)
```

All conversation history and memories will be lost. The next Pi session will create a new database.

## License

MIT
