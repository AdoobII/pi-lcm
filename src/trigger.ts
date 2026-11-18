export type CompactionTrigger = { mode: "percent" | "tokens" | "off"; value: number };

export type ParseTriggerResult = { ok: true; trigger: CompactionTrigger } | { ok: false; reason: string };

export type ThresholdResult = { tokens: number } | { tokens: null; reason: string };

export const MIN_TRIGGER_PERCENT = 5;
export const MAX_TRIGGER_PERCENT = 90;
export const MIN_TRIGGER_TOKENS = 20000;

const NUMBER_PATTERN = /^(\d+(?:\.\d+)?)\s*([%km]?)$/;
const TOKEN_MULTIPLIER: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000 };

function percentTrigger(value: number): ParseTriggerResult {
  if (value < MIN_TRIGGER_PERCENT || value > MAX_TRIGGER_PERCENT) {
    return { ok: false, reason: `percent must be between ${MIN_TRIGGER_PERCENT}% and ${MAX_TRIGGER_PERCENT}%` };
  }
  return { ok: true, trigger: { mode: "percent", value } };
}

function tokensTrigger(value: number): ParseTriggerResult {
  if (!Number.isSafeInteger(value) || value < MIN_TRIGGER_TOKENS) {
    return { ok: false, reason: `token count must be at least ${MIN_TRIGGER_TOKENS} (for example 400k)` };
  }
  return { ok: true, trigger: { mode: "tokens", value } };
}

export function parseTriggerInput(text: string, defaultMode?: "percent" | "tokens"): ParseTriggerResult {
  const input = typeof text === "string" ? text.trim().toLowerCase() : "";
  if (input === "off") return { ok: true, trigger: { mode: "off", value: 0 } };
  const match = NUMBER_PATTERN.exec(input);
  if (!match) return { ok: false, reason: 'use a percent like "40%", a token count like "400k", or "off"' };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return { ok: false, reason: "number is too large" };
  const suffix = match[2] ?? "";
  if (suffix === "%") return percentTrigger(amount);
  if (suffix === "" && defaultMode === "percent" && amount < 100) return percentTrigger(amount);
  if (suffix === "" && defaultMode === undefined && amount < 100) {
    return { ok: false, reason: 'add a unit: "40%" for a percent or "400k" for tokens' };
  }
  return tokensTrigger(Math.round(amount * (TOKEN_MULTIPLIER[suffix] ?? 1)));
}

export function resolveThresholdTokens(
  trigger: CompactionTrigger | null,
  contextWindow: number,
  keepRecentTokens: number,
): ThresholdResult {
  if (!trigger || trigger.mode === "off") return { tokens: null, reason: "compaction trigger is off" };
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { tokens: null, reason: "model context window is unknown" };
  }
  const configured = trigger.mode === "percent" ? Math.floor((contextWindow * trigger.value) / 100) : trigger.value;
  if (!Number.isFinite(configured)) return { tokens: null, reason: "compaction trigger value is invalid" };
  if (trigger.mode === "tokens" && configured >= contextWindow) {
    return { tokens: null, reason: `trigger of ${configured} tokens is not below the ${contextWindow} token context window` };
  }
  const keep = Number.isFinite(keepRecentTokens) && keepRecentTokens > 0 ? keepRecentTokens : 0;
  const tokens = Math.max(configured, 2 * keep);
  if (tokens >= contextWindow) {
    return { tokens: null, reason: `threshold of ${tokens} tokens is not below the ${contextWindow} token context window` };
  }
  return { tokens };
}

export function reserveTokensFor(thresholdTokens: number, contextWindow: number): number {
  return contextWindow - thresholdTokens;
}

export function sanitizeTrigger(value: unknown): CompactionTrigger | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { mode, value: amount } = value as Record<string, unknown>;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (mode === "off") return { mode: "off", value: amount };
  if (mode === "percent") {
    return amount >= MIN_TRIGGER_PERCENT && amount <= MAX_TRIGGER_PERCENT ? { mode, value: amount } : null;
  }
  if (mode === "tokens") {
    return Number.isSafeInteger(amount) && amount >= MIN_TRIGGER_TOKENS ? { mode, value: amount } : null;
  }
  return null;
}
