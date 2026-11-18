import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionEntry, CompactionEntry, SessionTreeEvent, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { Model as PiModel, Api } from "@earendil-works/pi-ai";
import { resolveProjectRoot, projectIdFor, ensureProject } from "./store/projects.js";
import { ensureSession } from "./store/sessions.js";
import { entryToMessage } from "./store/entries.js";
import { insertMessages, getMessagesByEntryIds } from "./store/messages.js";
import { insertSummary } from "./store/summaries.js";
import { deleteMemoriesByTag, insertMemory } from "./store/memories.js";
import { openDatabase } from "./db/driver.js";
import { migrate, SchemaTooNewError } from "./db/schema.js";
import { resolveDbPath, ensureDbDirectory } from "./db/path.js";
import { compactSpan, CompactionDeps, CompactionSpan, CompactionOutcome } from "./compact/engine.js";
import { createSummarizer, resolveModel as resolvePiModel, NoModelError } from "./compact/summarizer.js";
import { buildFocus } from "./compact/prompts.js";
import { shouldCompact } from "./trigger-runtime.js";
import { createRecallState, buildRestoreBlock, buildPromptBlock } from "./recall/inject.js";
import { registerTools, ToolDeps } from "./tools/index.js";
import { loadConfig, saveModelChoice, DEFAULT_CONFIG } from "./config.js";
import { createExtensionState, ExtensionState } from "./state.js";
import { logError, logWarn, logDebug } from "./util/log.js";
import { estimateTokens } from "./util/tokens.js";
import type { LcmConfig, StoredMessage } from "./types.js";

// State is per-extension-instance, managed by the factory
let state: ExtensionState;
let extensionApi: ExtensionAPI | null = null;
// Changes on every session start so a compaction callback from a different session cannot alter the current session's trigger state.
let triggerEpoch = 0;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;

function getState(): ExtensionState {
  return state;
}

function getDb(): import("./db/driver.js").Db {
  const s = getState();
  if (!s.db) {
    throw new Error("Database not initialized");
  }
  return s.db;
}

function getDbPath(): string {
  return getState().dbPath ?? ":memory:";
}

function getProjectId(): string {
  return getState().projectId ?? "";
}

function getSessionId(): string {
  return getState().sessionId ?? "";
}

function resolveModelChoice(ctx: ExtensionContext, config: LcmConfig): Promise<string | null> {
  // Return config.model when set
  if (config.model) {
    return Promise.resolve(config.model);
  }
  
  // When ctx.hasUI is false, return null
  if (!ctx.hasUI) {
    return Promise.resolve(null);
  }
  
  // Otherwise use ctx.ui.select
  return ctx.ui.select(
    "pi-lcm summarizer model",
    [
      ...ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
      "Use the active session model",
      "Skip pi-lcm compaction"
    ]
  ).then((choice) => {
    if (choice === undefined || choice === "Skip pi-lcm compaction") {
      return null;
    }
    if (choice === "Use the active session model") {
      return "active";
    }
    // Persist non-null choices
    if (choice) {
      saveModelChoice(choice);
    }
    return choice;
  });
}

function resolveModel(ctx: ExtensionContext, config: LcmConfig): PiModel<Api> | null {
  const choice = config.model;
  if (!choice) {
    return null;
  }
  
  // For test model
  if (choice === "test/test-model") {
    const model = ctx.modelRegistry.find("test", "test-model");
    return model as PiModel<Api> | null;
  }
  
  // Use resolvePiModel
  try {
    const model = resolvePiModel(ctx, config);
    return model as PiModel<Api> | null;
  } catch {
    return null;
  }
}

function computeCompactionSpan(event: {
  preparation: { firstKeptEntryId: string; tokensBefore: number };
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal?: AbortSignal;
}): CompactionSpan | undefined {
  const { preparation, branchEntries, customInstructions, signal } = event;
  
  // Find the newest compaction entry
  let newestCompaction: CompactionEntry | null = null;
  
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (!entry) continue;
    if (entry.type === "compaction") {
      newestCompaction = entry as CompactionEntry;
      break;
    }
  }
  
  // Find all message entries
  const messageEntries: SessionEntry[] = [];
  for (const entry of branchEntries) {
    if (entry.type === "message") {
      messageEntries.push(entry);
    }
  }
  
  if (messageEntries.length === 0) {
    logDebug("computeCompactionSpan: no message entries found");
    return undefined;
  }
  
  const messageIds = messageEntries.map(e => e.id);
  
  // Start at first message entry at or after newest compaction's firstKeptEntryId
  let startMsgIndex = 0;
  if (newestCompaction) {
    const compFirstKept = (newestCompaction as CompactionEntry).firstKeptEntryId;
    const compFirstKeptIndex = messageIds.indexOf(compFirstKept);
    startMsgIndex = compFirstKeptIndex >= 0 ? compFirstKeptIndex : 0;
  }
  
  // End before preparation.firstKeptEntryId
  const prepFirstKeptIndex = messageIds.indexOf(preparation.firstKeptEntryId);
  let endMsgIndex = messageIds.length;
  
  if (prepFirstKeptIndex >= 0) {
    endMsgIndex = prepFirstKeptIndex;
  } else {
    // Walk forward: find the entry in branchEntries, then find next message
    for (let i = 0; i < branchEntries.length; i++) {
      const branchEntry = branchEntries[i];
      if (!branchEntry) continue;
      if (branchEntry.id === preparation.firstKeptEntryId) {
        // Find the next message entry
        for (let j = i + 1; j < branchEntries.length; j++) {
          const nextEntry = branchEntries[j];
          if (!nextEntry) continue;
          if (nextEntry.type === "message") {
            const msgIndex = messageIds.indexOf(nextEntry.id);
            if (msgIndex >= 0) {
              endMsgIndex = msgIndex;
            }
            break;
          }
        }
        break;
      }
    }
  }
  
  // Collect messages in range [startMsgIndex, endMsgIndex)
  const spanMessages = messageEntries.slice(startMsgIndex, endMsgIndex);
  
  if (spanMessages.length === 0) {
    logDebug(`computeCompactionSpan: empty span (start=${startMsgIndex}, end=${endMsgIndex}, messages=${messageIds.join(",")}, firstKept=${preparation.firstKeptEntryId})`);
    return undefined;
  }
  
  // Get stored messages for these entries
  const db = getDb();
  const entryIds = spanMessages.map(e => e.id);
  const storedMessages = getMessagesByEntryIds(db, getSessionId(), entryIds);
  
  // Find previous compaction summary
  let previousSummary: string | undefined;
  let previousWasOurs = false;
  if (newestCompaction) {
    previousSummary = newestCompaction.summary;
    previousWasOurs = Boolean((newestCompaction.details as { lcm?: { version: number } } | undefined)?.lcm?.version === 1);
  }
  
  // Use tokensBefore from preparation
  const tokensBefore = preparation.tokensBefore ?? 0;
  
  return {
    messages: storedMessages,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore,
    previousSummary,
    previousWasOurs,
    customInstructions,
    signal,
  };
}

async function syncMessages(ctx: ExtensionContext, state: ExtensionState, reset = false): Promise<void> {
  if (state.disabled || !state.db) {
    return;
  }
  
  try {
    const branch = ctx.sessionManager.getBranch();
    
    if (reset) {
      state.lastSyncedEntryId = null;
    }
    
    // Find the index after lastSyncedEntryId
    let startIndex = 0;
    if (state.lastSyncedEntryId) {
      for (let i = 0; i < branch.length; i++) {
        const branchEntry = branch[i];
        if (branchEntry && branchEntry.id === state.lastSyncedEntryId) {
          startIndex = i + 1;
          break;
        }
      }
    }
    
    // Map entries through entryToMessage
    const messages: import("./types.js").MessageInput[] = [];
    for (let i = startIndex; i < branch.length; i++) {
      const entry = branch[i];
      if (!entry) continue;
      const msg = entryToMessage(entry, { storeThinking: state.config.storeThinking });
      if (msg) {
        messages.push(msg);
      }
    }
    
    if (messages.length > 0) {
      const projectId = getProjectId();
      const sessionId = getSessionId();
      insertMessages(state.db, projectId, sessionId, messages);
      
      // Update lastSyncedEntryId to the last entry ID
      const lastEntry = branch[branch.length - 1];
      if (lastEntry) {
        state.lastSyncedEntryId = lastEntry.id;
      }
    }
  } catch (error) {
    logError(`syncMessages failed: ${error}`);
  }
}

async function handleSessionStart(event: { type: string; reason: string }, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    logDebug("session_start: starting");
    triggerEpoch++;
    state.compactRequested = false;
    state.lastFailure = null;
    
    // Resolve project root and id
    const cwd = ctx.sessionManager.getCwd();
    const projectRoot = resolveProjectRoot(cwd);
    const projectId = projectIdFor(projectRoot);
    const sessionId = ctx.sessionManager.getSessionId();
    
    state.projectRoot = projectRoot;
    state.projectId = projectId;
    state.sessionId = sessionId;
    
    // Load config
    const config = loadConfig({
      projectRoot,
      env: process.env,
      trusted: ctx.isProjectTrusted(),
    });
    state.config = config;
    
    logDebug(`session_start: config loaded, model=${config.model}, dbPath=${config.dbPath}`);
    
    // Resolve DB path
    const dbPath = resolveDbPath({
      cwd,
      projectRoot,
      projectId,
      config,
      trusted: ctx.isProjectTrusted(),
    });
    state.dbPath = dbPath;
    
    // Ensure DB directory exists
    ensureDbDirectory(dbPath, ctx.isProjectTrusted());
    
    // Open database
    const dbPromise = openDatabase(dbPath).then((db) => {
      migrate(db as import("./db/driver.js").Db);
      return db;
    });
    
    state.dbPromise = dbPromise;
    state.db = await dbPromise;
    
    // Ensure project and session
    ensureProject(state.db, projectRoot);
    ensureSession(
      state.db,
      projectId,
      sessionId,
      cwd,
      ctx.sessionManager.getSessionFile()
    );
    
    // Reset state
    state.lastSyncedEntryId = null;
    // The recall override persists until the next lcm:recall-config event.
    const recallOverride = state.recall.override;
    state.recall = createRecallState();
    state.recall.override = recallOverride;
    
    // Sync branch
    await syncMessages(ctx, state);
    
    // Resolve model choice
    const choice = await resolveModelChoice(ctx, config);
    state.modelChoice = choice;
    
    logDebug(`session_start: modelChoice=${choice}`);
    
    // Update config with the resolved choice
    state.config = { ...config, model: choice };
    
    // Resolve model
    const model = resolveModel(ctx, state.config);
    state.model = model;
    
    if (choice && !model) {
      logWarn(`pi-lcm: configured summarizer model ${choice} is unavailable; skipping pi-lcm compaction`);
    }
    
    logDebug(`session_start: model=${model?.id ?? "null"}`);
    
    // Warn if no model and no UI
    if (state.model === null && !ctx.hasUI) {
      logWarn("pi-lcm: no summarizer model configured; skipping pi-lcm compaction");
    }
    
    logDebug("session_start: complete");
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      state.disabled = true;
      ctx.ui.notify("pi-lcm: database schema is newer than this extension; disabled", "error");
    } else {
      logError(`session_start failed: ${error}`);
      // Don't disable on other errors during startup
    }
  }
}

async function handleTurnEnd(event: unknown, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    await syncMessages(ctx, state);
  } catch (error) {
    logError(`turn_end sync failed: ${error}`);
  }
}

async function handleAgentSettled(event: unknown, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    await syncMessages(ctx, state);
  } catch (error) {
    logError(`agent_settled sync failed: ${error}`);
  }

  scheduleCompactionTrigger(ctx);
}

// Print, json and rpc runs send their next prompt right after settle, so a compaction started then
// would reject that prompt or race it.
const NON_INTERACTIVE_MODES: ReadonlySet<string> = new Set(["print", "json", "rpc"]);

// Pi starts deferred prompts after the agent_settled handlers return. Checking from a timer runs
// after they have started, so the idle and pending-message checks can see them.
function scheduleCompactionTrigger(ctx: ExtensionContext): void {
  if (NON_INTERACTIVE_MODES.has(ctx.mode)) {
    return;
  }
  const epoch = triggerEpoch;
  setTimeout(() => {
    try {
      if (epoch !== triggerEpoch) return;
      evaluateCompactionTrigger(ctx);
    } catch (error) {
      logError(`agent_settled trigger failed: ${error}`);
    }
  }, 0);
}

function readKeepRecentTokens(): number {
  const keep = extensionApi?.getSettings?.().compaction?.keepRecentTokens;
  return typeof keep === "number" && Number.isFinite(keep) && keep >= 0 ? keep : DEFAULT_KEEP_RECENT_TOKENS;
}

function evaluateCompactionTrigger(ctx: ExtensionContext): void {
  if (state.compactRequested || !ctx.isIdle() || ctx.hasPendingMessages()) {
    return;
  }
  const usage = ctx.getContextUsage();
  const decision = shouldCompact({
    usage,
    trigger: state.config.compactionTrigger ?? null,
    keepRecentTokens: readKeepRecentTokens(),
    hasModel: state.model !== null,
    isCompacting: state.isCompacting,
    lastFailure: state.lastFailure,
  });
  if (!decision.compact || !usage || usage.tokens === null) {
    return;
  }

  const tokens = usage.tokens;

  const epoch = triggerEpoch;
  state.compactRequested = true;
  try {
    ctx.compact({
      customInstructions: buildFocus(undefined, state.config.compactionFocus),
      onComplete: () => {
        if (epoch !== triggerEpoch) return;
        state.compactRequested = false;
        state.lastFailure = null;
      },
      onError: (error) => {
        logWarn(`pi-lcm: triggered compaction failed: ${error}`);
        if (epoch !== triggerEpoch) return;
        state.compactRequested = false;
        state.lastFailure = { tokens };
      },
    });
  } catch (error) {
    logError(`pi-lcm: could not start compaction: ${error}`);
    state.compactRequested = false;
    state.lastFailure = { tokens };
    return;
  }

  if (ctx.hasUI) {
    try {
      ctx.ui.notify(`pi-lcm: compacting at ${tokens} of ${usage.contextWindow} tokens (threshold ${decision.thresholdTokens})`);
    } catch (error) {
      logDebug(`trigger notify failed: ${error}`);
    }
  }
}

async function handleSessionTree(event: SessionTreeEvent, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    // Reset lastSyncedEntryId and sync
    state.lastSyncedEntryId = null;
    await syncMessages(ctx, state, true);
    
    // When event.summaryEntry exists, insert a legacy node
    if (event.summaryEntry) {
      const summaryEntry = event.summaryEntry;
      const db = getDb();
      const projectId = getProjectId();
      const sessionId = getSessionId();
      const content = summaryEntry.summary;
      const tc = estimateTokens(content);
      
      insertSummary(db, projectId, {
        sessionId,
        depth: 0,
        kind: "legacy",
        content,
        tokenCount: tc,
        messageIds: [],
        parentIds: [],
      });
    }
  } catch (error) {
    logError(`session_tree handling failed: ${error}`);
  }
}

async function handleSessionBeforeCompact(event: {
  type: string;
  preparation: { firstKeptEntryId: string; tokensBefore: number };
  branchEntries: SessionEntry[];
  customInstructions?: string;
  reason: string;
  willRetry: boolean;
  signal: AbortSignal;
}, ctx: ExtensionContext): Promise<{ compaction: CompactionOutcome } | undefined> {
  if (state.disabled) {
    logDebug("session_before_compact: disabled");
    return undefined;
  }
  
  if (state.isCompacting) {
    logDebug("session_before_compact: already compacting");
    return undefined;
  }
  
  if (state.model === null) {
    logDebug("session_before_compact: no model configured");
    return undefined;
  }
  
  try {
    // Sync first
    await syncMessages(ctx, state);
    
    // Compute span
    const span = computeCompactionSpan({
      preparation: event.preparation,
      branchEntries: event.branchEntries,
      customInstructions: buildFocus(event.customInstructions, state.config.compactionFocus),
      signal: event.signal,
    });
    
    if (!span || span.messages.length === 0) {
      logDebug("session_before_compact: span cannot be resolved or is empty");
      return undefined;
    }
    
    // Set compacting flag
    state.isCompacting = true;
    
    // Create summarizer
    const summarizer = createSummarizer(ctx, state.config);
    
    // Build deps
    const modelLimit = Math.max(4000, (state.model?.contextWindow ?? 12000) - 4000);
    
    const deps: CompactionDeps = {
      db: getDb(),
      config: state.config,
      projectId: getProjectId(),
      sessionId: getSessionId(),
      summarize: summarizer,
      modelLimit,
    };
    
    // Compact
    const outcome = await compactSpan(deps, span).catch((error) => {
      logError(`compactSpan failed: ${error}`);
      return undefined;
    });
    
    if (!outcome) {
      logDebug("session_before_compact: compactSpan returned undefined");
      return undefined;
    }
    
    return { compaction: outcome };
  } catch (error) {
    logError(`session_before_compact failed: ${error}`);
    state.isCompacting = false;
    return undefined;
  } finally {
    state.isCompacting = false;
  }
}

async function handleSessionCompact(event: {
  type: string;
  compactionEntry: SessionEntry;
  fromExtension: boolean;
}, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    // When !event.fromExtension, store the produced summary as a legacy node
    if (!event.fromExtension) {
      const compactionEntry = event.compactionEntry as CompactionEntry;
      const db = getDb();
      const projectId = getProjectId();
      const sessionId = getSessionId();
      
      // Compute covered message ids by walking the current branch
      const branch = ctx.sessionManager.getBranch();
      const firstKeptEntryId = compactionEntry.firstKeptEntryId;
      
      // Find the previous compaction's firstKeptEntryId
      let previousFirstKept: string | null = null;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (!entry) continue;
        if (entry.id === compactionEntry.id) {
          continue;
        }
        if (entry.type === "compaction") {
          previousFirstKept = (entry as CompactionEntry).firstKeptEntryId;
          break;
        }
      }
      
      // Start from previousFirstKept (or beginning) to firstKeptEntryId
      const startId = previousFirstKept ?? null;
      const endId = firstKeptEntryId;
      
      // Collect message entries in this range, then batch-load their stored ids.
      const entryIds: string[] = [];
      let inRange = startId === null;
      
      for (const entry of branch) {
        if (entry.type === "message") {
          if (startId !== null && !inRange) {
            if (entry.id === startId) {
              inRange = true;
            }
          }
          
          if (inRange) {
            if (entry.id === endId) {
              break;
            }
            entryIds.push(entry.id);
          }
        }
      }
      const messageIds = getMessagesByEntryIds(db, sessionId, entryIds).map((m) => m.id);
      
      // Insert legacy node
      const tokenCount = estimateTokens(compactionEntry.summary);
      insertSummary(db, projectId, {
        sessionId,
        depth: 0,
        kind: "legacy",
        content: compactionEntry.summary,
        tokenCount,
        messageIds,
        parentIds: [],
      });
    }
  } catch (error) {
    logError(`session_compact handling failed: ${error}`);
  }
}

async function handleBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<{ message: { customType: string; content: string; display: boolean } } | undefined> {
  if (state.disabled) {
    return undefined;
  }
  
  try {
    // Only for user messages
    if (event.messageType !== "user") {
      return undefined;
    }
    
    const db = getDb();
    const projectId = getProjectId();
    const sessionId = getSessionId();
    
    // Build restore block
    const restoreBlock = buildRestoreBlock(db, projectId, sessionId, state.config, state.recall);
    
    // Build prompt block
    const promptBlock = buildPromptBlock(db, projectId, sessionId, event.prompt, state.config, state.recall);
    
    // Combine blocks
    const blocks = [restoreBlock, promptBlock].filter((b) => b !== null);
    
    if (blocks.length === 0) {
      return undefined;
    }
    
    const content = blocks.join("\n\n");
    
    return {
      message: {
        customType: "pi-lcm:recall",
        content,
        display: false,
      },
    };
  } catch (error) {
    logError(`before_agent_start failed: ${error}`);
    return undefined;
  }
}

async function handleSessionShutdown(event: { type: string }, ctx: ExtensionContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    if (state.db) {
      state.db.close();
      state.db = null;
    }
  } catch (error) {
    logError(`session_shutdown failed: ${error}`);
  }
}

async function handleLcmModelCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (state.disabled) {
    return;
  }
  
  try {
    // Re-run the picker
    const config = state.config;
    const choice = await resolveModelChoice(ctx, config);
    
    if (choice) {
      saveModelChoice(choice);
      state.modelChoice = choice;
      
      // Resolve model
      const resolvedConfig = { ...config, model: choice };
      const model = resolveModel(ctx, resolvedConfig);
      state.model = model;
      
      ctx.ui.notify(`pi-lcm: model set to ${choice}`);
    } else {
      ctx.ui.notify("pi-lcm: compaction disabled");
    }
  } catch (error) {
    logError(`lcm-model command failed: ${error}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function handleLcmStoreEvent(data: unknown): void {
  if (state.disabled || !state.db || !state.projectId) {
    return;
  }

  try {
    const payload = data as { content?: unknown; tags?: unknown } | null;
    if (typeof payload?.content !== "string" || payload.content.trim().length === 0) {
      return;
    }
    const tags = isStringArray(payload.tags) ? payload.tags : [];
    insertMemory(state.db, state.projectId, payload.content, tags, "auto");
  } catch (error) {
    logError(`lcm:store failed: ${error}`);
  }
}

function handleLcmForgetEvent(data: unknown): void {
  if (state.disabled || !state.db || !state.projectId) {
    return;
  }

  try {
    const payload = data as { tag?: unknown } | null;
    if (typeof payload?.tag !== "string" || payload.tag.length === 0) {
      return;
    }
    deleteMemoriesByTag(state.db, state.projectId, payload.tag);
  } catch (error) {
    logError(`lcm:forget failed: ${error}`);
  }
}

function handleLcmRecallConfigEvent(data: unknown): void {
  if (data === null || data === undefined) {
    state.recall.override = null;
    return;
  }

  const payload = data as { limit?: unknown; tags?: unknown };
  const limit = typeof payload.limit === "number" && Number.isInteger(payload.limit) && payload.limit > 0
    ? payload.limit
    : undefined;
  const tags = isStringArray(payload.tags) ? payload.tags : undefined;
  state.recall.override = { limit, tags };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Initialize fresh state for this extension instance
  state = createExtensionState();
  extensionApi = pi;
  
  // Set up ToolDeps getters that read live state
  const toolDeps: ToolDeps = {
    getDb: () => getDb(),
    getDbPath: () => getDbPath(),
    getProjectId: () => getProjectId(),
    getSessionId: () => getSessionId(),
    config: {} as LcmConfig, // Will be set in session_start
  };
  
  // Register tools
  registerTools(pi, toolDeps);
  
  // Register events
  pi.on("session_start", handleSessionStart);
  pi.on("turn_end", handleTurnEnd);
  pi.on("agent_settled", handleAgentSettled);
  pi.on("session_tree", handleSessionTree);
  pi.on("session_before_compact", handleSessionBeforeCompact);
  pi.on("session_compact", handleSessionCompact);
  pi.on("before_agent_start", handleBeforeAgentStart);
  pi.on("session_shutdown", handleSessionShutdown);
  
  pi.events.on("lcm:store", handleLcmStoreEvent);
  pi.events.on("lcm:forget", handleLcmForgetEvent);
  pi.events.on("lcm:recall-config", handleLcmRecallConfigEvent);

  // Register command
  pi.registerCommand("lcm-model", {
    description: "Select the summarizer model for pi-lcm compaction",
    handler: handleLcmModelCommand,
  });
}
