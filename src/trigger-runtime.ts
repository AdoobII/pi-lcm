import { resolveThresholdTokens, type CompactionTrigger } from "./trigger.js";

export const FAILURE_BACKOFF_FRACTION = 0.1;

export interface ShouldCompactInput {
  usage: { tokens: number | null; contextWindow: number } | undefined;
  trigger: CompactionTrigger | null;
  keepRecentTokens: number;
  hasModel: boolean;
  isCompacting: boolean;
  lastFailure: { tokens: number } | null;
}

export type ShouldCompactResult = { compact: true; thresholdTokens: number } | { compact: false; reason: string };

export function shouldCompact(input: ShouldCompactInput): ShouldCompactResult {
  const { usage, trigger, keepRecentTokens, hasModel, isCompacting, lastFailure } = input;
  if (!hasModel) return { compact: false, reason: "no summarizer model" };
  if (isCompacting) return { compact: false, reason: "compaction already running" };
  if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) {
    return { compact: false, reason: "context usage is unknown" };
  }
  const threshold = resolveThresholdTokens(trigger, usage.contextWindow, keepRecentTokens);
  if (threshold.tokens === null) return { compact: false, reason: threshold.reason };
  if (usage.tokens < threshold.tokens) return { compact: false, reason: "below threshold" };
  if (lastFailure && usage.tokens < lastFailure.tokens + FAILURE_BACKOFF_FRACTION * usage.contextWindow) {
    return { compact: false, reason: "backing off after a failed compaction" };
  }
  return { compact: true, thresholdTokens: threshold.tokens };
}
