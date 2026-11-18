# pi-lcm: compaction trigger and focus strings

## Intent

Pi compacts only when free context drops below `reserveTokens` (default 16384), so on a 1M window compaction starts near 984k tokens. Long orchestration sessions then grow to hundreds of thousands of stale tokens, pay for repeated cache rewrites, and never build pi-lcm's summary DAG. pi-lcm should let the user say when compaction starts, as a share of the model's context window or as a token count, and should carry a keep-list into every summary so rulings, paths and commits survive.

## Goals

- First run asks for the trigger (percent or tokens), like it asks for the summarizer model. `/lcm-trigger` re-runs the prompt.
- The trigger is resolved against the active model's context window at check time, so model switches work.
- Focus strings reach the summarizer: a focus given to `/compact` and a configurable default keep-list.

## Non-goals and anti-goals

- No edits to Pi's `settings.json`, no change to Pi's own threshold (Pi has no percent form; its `reserveTokens` is a free-token count and stays as the backstop).
- No inferred task-edge detection. No compaction in the middle of a run.
- Must not compact in a loop, and must not run without a summarizer model.

## Constraints (verified)

- An extension can call `ctx.compact({customInstructions})`; manual compaction aborts a running turn, so the trigger runs only at `agent_settled` (idle).
- `ctx.getContextUsage()` gives `{ tokens | null, contextWindow, percent | null }` for the current model; `tokens` is null right after a compaction.
- `session_before_compact` receives `customInstructions`; pi-lcm does not forward it (`src/index.ts`, `computeCompactionSpan` call), and condensation passes `undefined` (`src/compact/engine.ts`).
- `pi.getSettings()` (read only) exposes the effective `compaction.keepRecentTokens`.

## Approaches

1. **pi-lcm owns the trigger (chosen):** config in `lcm.json`, check at `agent_settled`, `ctx.compact()` with the focus. Self-contained, but fires only between runs.
2. Write `reserveTokens` into Pi settings: fires mid-run but edits a shared file, goes stale on model changes, cannot express a percent for unknown models.
3. Both: most complete, most to build. Deferred; `/lcm-trigger` prints the matching `reserveTokens` so the user can add the backstop by hand.

## Design

- `LcmConfig.compactionTrigger: { mode: "percent" | "tokens" | "off"; value: number } | null` (null = never asked). `LcmConfig.compactionFocus: string` default keep-list.
- Parsing: `"40%"` and `"40 %"` are percent; a bare number below 100 with the percent mode chosen is percent; `"400k"`, `"400000"`, `"1.5m"` are tokens. Validation: percent 5 to 90; tokens at least 20000 and below the model window at check time; otherwise ignored with a notice.
- Threshold = percent: `floor(window * value / 100)`; tokens: `value`. Effective threshold = `max(threshold, 2 * keepRecentTokens)`.
- Check at `agent_settled`, after message sync: compact when `tokens >= threshold`, a summarizer model is set, no compaction in progress, and the last attempt did not fail at the same or lower token count. After a successful compaction `tokens` is null until the next response, so a null reading never triggers. A failed attempt backs off until usage grows by 10% of the window.
- First run (no `compactionTrigger` and `ctx.hasUI`): offer percent (suggest 40), tokens or off; ask for the number; validate in a loop; save to the global `lcm.json`; print the matching `reserveTokens` for each known window. Headless with no saved choice: do nothing, log once. `PI_LCM_COMPACT_TRIGGER` env override (`40%`, `400k`, `off`).
- Focus: effective instructions = the user's `/compact` focus (if any) followed by `compactionFocus`. Default keep-list: rulings and decisions with their reasons; file paths and commit hashes; open threads; user preferences; the ledger or plan path and an instruction to re-read it. Passed to leaf and condensed summary prompts.

## Decisions left to the builder

Exact prompt wording and notification text; test seams; where the focus text lives (`src/compact/prompts.ts` constant).
