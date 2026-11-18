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

async function askValue(
  ui: TriggerPromptUi,
  mode: "percent" | "tokens",
): Promise<CompactionTrigger | undefined> {
  const baseTitle = mode === "percent" ? PERCENT_TITLE : TOKENS_TITLE;
  const placeholder = mode === "percent" ? "40" : "400k";
  let title = baseTitle;
  for (;;) {
    const text = await ui.input(title, placeholder);
    if (text === undefined) return undefined;
    const parsed = parseTriggerInput(text, mode);
    if (parsed.ok && parsed.trigger.mode === mode) return parsed.trigger;
    const reason = parsed.ok
      ? mode === "percent"
        ? 'enter a percent such as "40", or choose Off in the previous step'
        : 'enter a token count such as "400k", or choose Off in the previous step'
      : parsed.reason;
    title = `${baseTitle}: ${reason}`;
  }
}

function reserveTokensHint(trigger: CompactionTrigger, contextWindows: number[], keepRecentTokens: number): string | null {
  const parts: string[] = [];
  const windows = [...new Set(contextWindows.filter((window) => Number.isFinite(window) && window > 0))].sort((a, b) => b - a);
  for (const window of windows) {
    const threshold = resolveThresholdTokens(trigger, window, keepRecentTokens);
    if (threshold.tokens === null) continue;
    parts.push(`reserveTokens ${reserveTokensFor(threshold.tokens, window)} for a ${window}-token window`);
  }
  return parts.length > 0 ? `For Pi's own settings.json: ${parts.join("; ")}` : null;
}

export async function askTrigger(
  ctx: { ui: TriggerPromptUi },
  contextWindows: number[],
  keepRecentTokens: number = DEFAULT_KEEP_RECENT_TOKENS,
): Promise<CompactionTrigger | undefined> {
  const choice = await ctx.ui.select(MODE_TITLE, [PERCENT_OPTION, TOKENS_OPTION, OFF_OPTION]);
  if (choice === OFF_OPTION) return { mode: "off", value: 0 };
  if (choice !== PERCENT_OPTION && choice !== TOKENS_OPTION) return undefined;

  const trigger = await askValue(ctx.ui, choice === PERCENT_OPTION ? "percent" : "tokens");
  if (!trigger) return undefined;

  const hint = reserveTokensHint(trigger, contextWindows, keepRecentTokens);
  if (hint) ctx.ui.notify(hint);
  return trigger;
}
