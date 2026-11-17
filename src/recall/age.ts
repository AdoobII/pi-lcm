const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_WINDOW_DAYS = 180;
const DECAY_FLOOR = 0.5;

/** Whole days from createdAt (an ISO string) to now, or 0 if createdAt is in the future or unparseable. */
export function ageDays(createdAt: string, now: Date): number {
  const elapsedMs = now.getTime() - new Date(createdAt).getTime();
  if (Number.isNaN(elapsedMs)) {
    return 0;
  }
  return Math.max(0, Math.floor(elapsedMs / DAY_MS));
}

/** Lowers the score linearly over 180 days, down to half the original score. */
export function decayedScore(score: number, ageDays: number): number {
  if (Number.isNaN(ageDays)) {
    return score;
  }
  return score * Math.max(DECAY_FLOOR, 1 - ageDays / DECAY_WINDOW_DAYS);
}
