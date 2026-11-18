import { DEFAULT_KEEP_RECENT_TOKENS, parseTriggerInput, reserveTokensFor, resolveThresholdTokens, type CompactionTrigger } from "./trigger.js";

export interface TriggerPromptUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

const PERCENT_OPTION = "Percent of context window (suggested: 40%)";
const TOKENS_OPTION = "Number of tokens";
const OFF_OPTION = "Off (Pi's own threshold only)";

const MODE_TITLE = "pi-lcm: when should compaction start?";
const PERCENT_TITLE = "Percent of the context window (5 to 90)";
const TOKENS_TITLE = "Token count (for example 400k)";

const PERCENT_STEP_HINT = "enter a percent between 5 and 90, for example 40 or 40%";
const TOKENS_STEP_HINT = "enter a token count of at least 20000 and below the window, for example 400k";
const MAX_HINT_WINDOWS = 3;

export interface ModelWindow {
  id: string;
  contextWindow: number;
}

const MAX_INVALID_ANSWERS = 5;

async function askValue(
  ui: TriggerPromptUi,
  mode: "percent" | "tokens",
  largestWindow: number | null,
): Promise<CompactionTrigger | undefined> {
  const baseTitle = mode === "percent" ? PERCENT_TITLE : TOKENS_TITLE;
  const placeholder = mode === "percent" ? "40" : "400k";
  const stepHint = mode === "percent" ? PERCENT_STEP_HINT : TOKENS_STEP_HINT;
  const ownRangeReason = mode === "percent" ? "percent must be" : "token count must be";
  let title = baseTitle;
  for (let invalidAnswers = 0; invalidAnswers < MAX_INVALID_ANSWERS; invalidAnswers++) {
    const text = await ui.input(title, placeholder);
    if (text === undefined) return undefined;
    const parsed = parseTriggerInput(text, mode);
    if (parsed.ok && parsed.trigger.mode === mode) {
      if (mode === "tokens" && largestWindow !== null && parsed.trigger.value >= largestWindow) {
        title = `${baseTitle}: ${parsed.trigger.value} tokens is not below your largest known context window (${largestWindow} tokens), so it could never fire`;
        continue;
      }
      return parsed.trigger;
    }
    // Show the parser's range message only for this step. Other reasons mention options this step does not offer.
    const reason = !parsed.ok && parsed.reason.startsWith(ownRangeReason) ? parsed.reason : stepHint;
    title = `${baseTitle}: ${reason}`;
  }
  ui.notify("pi-lcm: too many invalid answers; compaction trigger unchanged", "warning");
  return undefined;
}

// Pi's compaction.reserveTokens applies to every model unless it is set under compaction.modelOverrides, so a value
// computed for a large window would make Pi compact after every turn on a smaller model if it were set globally.
function reserveTokensHint(trigger: CompactionTrigger, models: ModelWindow[], keepRecentTokens: number): string | null {
  const byId = new Map<string, number>();
  for (const { id, contextWindow } of models) {
    if (Number.isFinite(contextWindow) && contextWindow > 0 && !byId.has(id)) byId.set(id, contextWindow);
  }
  if (byId.size === 0) return null;
  const known = [...byId].map(([id, contextWindow]) => ({ id, contextWindow }));
  const fitting = known
    .flatMap(({ id, contextWindow }) => {
      const threshold = resolveThresholdTokens(trigger, contextWindow, keepRecentTokens);
      return threshold.tokens === null ? [] : [{ id, contextWindow, reserve: reserveTokensFor(threshold.tokens, contextWindow) }];
    })
    .sort((a, b) => b.contextWindow - a.contextWindow || a.id.localeCompare(b.id));
  if (fitting.length === 0) {
    return "pi-lcm: compaction.reserveTokens could not be computed because no known context window fits the trigger";
  }
  const shown = fitting.slice(0, MAX_HINT_WINDOWS).map(({ id, contextWindow, reserve }) => `["${id}"] = ${reserve} (${contextWindow}-token window)`);
  const more = fitting.length - shown.length;
  if (more > 0) shown.push(`and ${more} more`);

  const smallest = known.reduce((a, b) => (b.contextWindow < a.contextWindow ? b : a));
  const smallestThreshold = resolveThresholdTokens(trigger, smallest.contextWindow, keepRecentTokens);
  const globalAdvice = smallestThreshold.tokens === null
    ? `A single global compaction.reserveTokens is not safe, because the trigger does not fit your smallest known window (${smallest.contextWindow} tokens).`
    : `A single global compaction.reserveTokens is safe only at ${reserveTokensFor(smallestThreshold.tokens, smallest.contextWindow)}, the value for your smallest known window (${smallest.contextWindow} tokens); a larger global value can make Pi compact after every turn on a smaller model.`;
  const prefix = "pi-lcm: to also set Pi's own threshold, use compaction.modelOverrides[\"<model>\"].reserveTokens in settings.json: ";
  return `${prefix}${shown.join("; ")}. ${globalAdvice}`;
}

export async function askTrigger(
  ctx: { ui: TriggerPromptUi },
  models: ModelWindow[],
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): Promise<CompactionTrigger | undefined> {
  const choice = await ctx.ui.select(MODE_TITLE, [PERCENT_OPTION, TOKENS_OPTION, OFF_OPTION]);
  if (choice === OFF_OPTION) return { mode: "off", value: 0 };
  if (choice !== PERCENT_OPTION && choice !== TOKENS_OPTION) return undefined;

  const windows = models.map((model) => model.contextWindow).filter((window) => Number.isFinite(window) && window > 0);
  const largestWindow = windows.length > 0 ? Math.max(...windows) : null;
  const trigger = await askValue(ctx.ui, choice === PERCENT_OPTION ? "percent" : "tokens", largestWindow);
  if (!trigger) return undefined;

  const hint = reserveTokensHint(trigger, models, keepRecentTokens);
  if (hint) ctx.ui.notify(hint);
  return trigger;
}
