# pi-lcm Compaction Trigger and Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose when pi-lcm starts compaction (percent of the model's window or a token count), and carry a keep-list focus into every summary.

**Architecture:** A pure trigger module parses, validates and resolves the threshold. `agent_settled` evaluates it and calls `ctx.compact()` with the focus. Focus strings flow through the existing summarizer prompts. A first-run prompt and `/lcm-trigger` collect the choice.

**Tech Stack:** TypeScript (ESM), Pi 1.5.2 extension API, vitest, `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-11-18-compaction-trigger-design.md`

## Global Constraints

- Work in `~/dev/repos/.worktrees/pi-lcm-impl` (branch `feat/modes-events`). Nothing under `~/.pi` is modified by tasks. Tests: `npm test`; `npm run typecheck`. One test (`tests/unit/projects.test.ts`, macOS `/private/var` path) fails on `main` and is accepted.
- Trigger values: percent 5 to 90 inclusive; tokens at least 20000 and below the model's context window; effective threshold = `max(resolved, 2 * keepRecentTokens)` with `keepRecentTokens` from `pi.getSettings().compaction.keepRecentTokens` (default 20000).
- Config keys: `compactionTrigger` (`{mode, value}` or `null`), `compactionFocus` (string). Env override `PI_LCM_COMPACT_TRIGGER` accepts `40%`, `400k`, `400000`, `off`.
- The trigger only runs at `agent_settled`, never mid-run. After a failed compaction, back off until usage grows by 10% of the window.
- Commits go through the commit gate. The repo's local git identity is `adoobii25@gmail.com`; never set an author by hand.

## Review Focus

- A reading of `tokens: null` (right after a compaction) must never trigger.
- A failing summarizer must not cause a compaction loop on every settle.
- A model switch to a smaller window must not leave an impossible token threshold (it must be ignored with a notice or clamped).
- Garbage input (`"abc"`, `"-5%"`, `"0"`, `"1e999"`, `"4o0k"`) must be rejected without writing config.
- A user `/compact` focus must not be lost when the default keep-list is added.

---

### Task 1: Focus strings reach the summarizer

**Files:**
- Modify: `src/index.ts` (`handleSessionBeforeCompact`), `src/compact/engine.ts` (condensation call), `src/compact/prompts.ts`, `src/config.ts`, `src/types.ts`
- Test: `tests/unit/compact-focus.test.ts`

**Interfaces:**
- Produces: `DEFAULT_COMPACTION_FOCUS: string` in `src/compact/prompts.ts`; `LcmConfig.compactionFocus: string` (default `DEFAULT_COMPACTION_FOCUS`); `buildFocus(userFocus: string | undefined, configFocus: string): string | undefined` in `src/compact/prompts.ts` returning the user focus followed by a blank line and the config focus, trimmed, or `undefined` when both are empty.

- [ ] **Step 1:** Write failing tests: `build_focus_combines_user_and_default`; `build_focus_returns_undefined_when_empty`; `before_compact_passes_event_custom_instructions_to_the_span` (the handler forwards `event.customInstructions` combined with the config focus); `condensation_receives_the_focus` (the summarize call for depth 1 gets `customInstructions`); `leaf_and_condensed_prompts_contain_operator_directions`.
- [ ] **Step 2:** Run `npm test -- compact-focus`; expect FAIL.
- [ ] **Step 3:** Implement: `DEFAULT_COMPACTION_FOCUS` is a short list asking the summarizer to keep rulings and decisions with their reasons, file paths and commit hashes, open threads, user preferences, and any ledger or plan path with an instruction to re-read it. Forward `event.customInstructions` (add it to the handler's event type) through `buildFocus`; thread the same string into the condensation `SummarizeOptions` in `engine.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit through the commit gate.

### Task 2: Trigger parsing and threshold resolution

**Files:**
- Create: `src/trigger.ts`
- Modify: `src/types.ts`, `src/config.ts` (new keys, `saveTriggerChoice`, env override)
- Test: `tests/unit/trigger.test.ts`, `tests/unit/config-trigger.test.ts`

**Interfaces:**
- Produces:
  - `type CompactionTrigger = { mode: "percent" | "tokens" | "off"; value: number }`
  - `parseTriggerInput(text: string, defaultMode?: "percent" | "tokens"): { ok: true; trigger: CompactionTrigger } | { ok: false; reason: string }`
  - `resolveThresholdTokens(trigger: CompactionTrigger | null, contextWindow: number, keepRecentTokens: number): { tokens: number } | { tokens: null; reason: string }`
  - `reserveTokensFor(thresholdTokens: number, contextWindow: number): number` (`contextWindow - thresholdTokens`)
  - `saveTriggerChoice(trigger: CompactionTrigger): void` in `src/config.ts` (writes the global `lcm.json`, keeping other keys)
- Config: `LcmConfig.compactionTrigger: CompactionTrigger | null` (default `null`), `loadConfig` reads `PI_LCM_COMPACT_TRIGGER`.

- [ ] **Step 1:** Write failing tests with the spec's values: `"40%"` and `"40 %"` parse to percent 40; `"400k"` to tokens 400000; `"400000"` to tokens 400000; `"1.5m"` to tokens 1500000; `"off"` to mode off; `"40"` with `defaultMode: "percent"` to percent 40; rejected: `"abc"`, `"-5%"`, `"0"`, `"4%"`, `"95%"`, `"10k"` (below 20000), `"1e999"`, `"4o0k"`, `""`. `resolveThresholdTokens`: percent 40 on 1,000,000 gives 400000; tokens 400000 on a 200,000 window gives `{tokens: null, reason}`; tokens 25000 with `keepRecentTokens` 20000 is raised to 40000; `null` and off give `{tokens: null}`; `reserveTokensFor(400000, 1000000) === 600000`. Config: env override beats file; `saveTriggerChoice` keeps `model`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `src/trigger.ts` as pure functions; add the config keys and writer.
- [ ] **Step 4:** Run `npm test && npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit through the commit gate.

### Task 3: Trigger evaluation at `agent_settled`

**Files:**
- Create: `src/trigger-runtime.ts`
- Modify: `src/index.ts` (`handleAgentSettled`, state), `src/state.ts`
- Test: `tests/unit/trigger-runtime.test.ts`, `tests/integration/trigger.test.ts`

**Interfaces:**
- Consumes: `resolveThresholdTokens` (Task 2), `buildFocus` (Task 1).
- Produces: `shouldCompact(input: { usage: { tokens: number | null; contextWindow: number } | undefined; trigger: CompactionTrigger | null; keepRecentTokens: number; hasModel: boolean; isCompacting: boolean; lastFailure: { tokens: number } | null }): { compact: true; thresholdTokens: number } | { compact: false; reason: string }`.
- Behaviour: after message sync at `agent_settled`, call `shouldCompact` with `ctx.getContextUsage()`; when true, `ctx.compact({ customInstructions: buildFocus(undefined, config.compactionFocus), onComplete, onError })` and notify through `ctx.ui.notify` when a UI exists. `onError` records `lastFailure.tokens`; later checks need `tokens >= lastFailure.tokens + 0.1 * contextWindow` to retry. `onComplete` clears the failure.

- [ ] **Step 1:** Write failing tests: `null_tokens_never_triggers`; `below_threshold_does_nothing`; `at_threshold_compacts`; `no_summarizer_model_skips`; `already_compacting_skips`; `failure_backs_off_until_ten_percent_more`; `percent_threshold_follows_the_active_model_window` (same trigger, two windows); `integration_agent_settled_calls_compact_once_with_focus` (fake pi/ctx; a second settle while the first is pending does not call again).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `shouldCompact` as a pure function and wire it into `handleAgentSettled`; keep `lastFailure` in `ExtensionState`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit through the commit gate.

### Task 4: First-run prompt and `/lcm-trigger`

**Files:**
- Modify: `src/index.ts` (`handleSessionStart`, new `handleLcmTriggerCommand`, command registration)
- Create: `src/trigger-prompt.ts`
- Test: `tests/unit/trigger-prompt.test.ts`, `tests/integration/trigger-prompt.test.ts`

**Interfaces:**
- Produces: `askTrigger(ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; input(title: string, placeholder?: string): Promise<string | undefined>; notify(msg: string, level?: string): void } }, contextWindows: number[]): Promise<CompactionTrigger | undefined>`; options in order `Percent of context window (suggested: 40%)`, `Number of tokens`, `Off (Pi's own threshold only)`; input loops until valid or cancelled (cancel returns `undefined` and saves nothing); after a valid choice it notifies the matching `reserveTokens` for each distinct window (`reserveTokensFor`).
- First run: when `config.compactionTrigger === null` and `ctx.hasUI`, ask, save with `saveTriggerChoice`, set state. Headless: log one warning, change nothing. `off` is saved so it is not asked again.

- [ ] **Step 1:** Write failing tests: `first_run_asks_when_unset`; `does_not_ask_when_saved_or_off`; `cancel_saves_nothing`; `invalid_then_valid_input_loops_and_saves_once`; `headless_never_prompts`; `reserve_tokens_hint_is_notified`; `command_reruns_the_prompt_and_replaces_the_choice`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `askTrigger` and wire the session-start prompt (after the model picker) and `/lcm-trigger`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit through the commit gate.

### Task 5: Live verification and docs

**Files:**
- Modify (pi-modes worktree `~/dev/repos/.worktrees/pi-modes-impl`): `tests/live/helpers.ts` or `tests/live/harness.ts` (allow writing `compactionTrigger`/`compactionFocus` into the temp `lcm.json`), create `tests/live/compaction.live.test.ts`, `docs/usage.md`
- Modify (pi-lcm worktree): `README.md`

**Interfaces:**
- Consumes: all earlier tasks, the live harness.

- [ ] **Step 1:** Write `compaction.live.test.ts`: with a temp `lcm.json` holding `compactionTrigger: {mode: "tokens", value: 20000}` and a small custom `compactionFocus`, run several prompts that grow the context past the threshold; assert a `compaction` entry appears in the session after `agent_settled`, that `session_before_compact` carried the focus text (use the probe log), that no second compaction fires immediately, and that with `off` nothing compacts.
- [ ] **Step 2:** Run `npm run test:live` in the pi-modes worktree; expect PASS. Record the result and the date in `docs/usage.md`.
- [ ] **Step 3:** Document in the pi-lcm `README.md`: the trigger, percent and token forms, the floor, `/lcm-trigger`, `PI_LCM_COMPACT_TRIGGER`, the focus keys, the Pi `reserveTokens` backstop hint, and that the trigger only fires between runs.
- [ ] **Step 4:** Commit in both repos through the commit gate.
