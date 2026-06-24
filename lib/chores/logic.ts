// lib/chores/logic.ts
// Pure, deterministic logic for Family Missions: reward calculation from an AI
// quality score, XP→level curve, and streak updates. No DB/network so the math
// is unit-tested directly and reused by both the server engine and the UI.

export type RewardMode = 'fixed_cash' | 'fixed_points' | 'ai_cash' | 'ai_points' | 'prize' | 'responsibility';
export type Difficulty = 'easy' | 'medium' | 'hard';

export const REWARD_MODE_LABELS: Record<RewardMode, string> = {
  fixed_cash: 'Fixed cash',
  fixed_points: 'Fixed points',
  ai_cash: 'AI-adjusted cash',
  ai_points: 'AI-adjusted points',
  prize: 'Prize unlock',
  responsibility: 'Responsibility (no pay)',
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
export const DIFFICULTY_XP: Record<Difficulty, number> = { easy: 10, medium: 20, hard: 35 };

export type ChoreReward = {
  reward_mode: RewardMode;
  points: number | null;
  points_min: number | null;
  points_max: number | null;
  cash_cents: number | null;
  cash_min_cents: number | null;
  cash_max_cents: number | null;
};

export type RewardOutcome = {
  type: 'cash' | 'points' | 'prize' | 'none';
  points: number;       // points to award
  cashCents: number;    // cash to award, in cents
  label: string;        // human summary
};

/** Linearly interpolate min..max by a 0..100 score, floored to an integer. */
export function scaleByScore(min: number, max: number, score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(lo + ((hi - lo) * clamped) / 100);
}

/**
 * Compute the reward for a chore given an AI (or parent) quality score 0..100.
 * AI modes interpolate within the parent-approved range; fixed modes ignore the
 * score; responsibility pays nothing; prize defers to the reward store.
 */
export function computeReward(chore: ChoreReward, score: number): RewardOutcome {
  switch (chore.reward_mode) {
    case 'fixed_points': {
      const points = Math.max(0, chore.points ?? 0);
      return { type: 'points', points, cashCents: 0, label: `${points} pts` };
    }
    case 'fixed_cash': {
      const cashCents = Math.max(0, chore.cash_cents ?? 0);
      return { type: 'cash', points: 0, cashCents, label: fmtCash(cashCents) };
    }
    case 'ai_points': {
      const points = scaleByScore(chore.points_min ?? 0, chore.points_max ?? chore.points_min ?? 0, score);
      return { type: 'points', points, cashCents: 0, label: `${points} pts` };
    }
    case 'ai_cash': {
      const cashCents = scaleByScore(chore.cash_min_cents ?? 0, chore.cash_max_cents ?? chore.cash_min_cents ?? 0, score);
      return { type: 'cash', points: 0, cashCents, label: fmtCash(cashCents) };
    }
    case 'prize':
      return { type: 'prize', points: 0, cashCents: 0, label: 'Prize unlock' };
    case 'responsibility':
    default:
      return { type: 'none', points: 0, cashCents: 0, label: 'No pay (responsibility)' };
  }
}

export function fmtCash(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Whether a submission with the given AI score may be auto-approved.
 * Requires a numeric threshold AND no safety flags AND no parent-review request.
 */
export function canAutoApprove(opts: {
  autoApproveScore: number | null;
  score: number;
  needsParentReview: boolean;
  safetyFlags: unknown[];
}): boolean {
  if (opts.autoApproveScore == null) return false;
  if (opts.needsParentReview) return false;
  if (opts.safetyFlags.length > 0) return false;
  return opts.score >= opts.autoApproveScore;
}

// ---------- XP / levels ----------
// Level N requires 100 * (N-1) * N / 2 cumulative XP (i.e. 100, 300, 600, …).
export function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  const n = level - 1;
  return (100 * n * (n + 1)) / 2;
}

export type LevelProgress = { level: number; intoLevel: number; span: number; pct: number };

export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = Math.max(1, next - base);
  const intoLevel = xp - base;
  return { level, intoLevel, span, pct: Math.min(100, Math.round((intoLevel / span) * 100)) };
}

// ---------- Streaks ----------
/**
 * Given the last activity date and "today" (both YYYY-MM-DD), return the new
 * streak. Same day → unchanged; consecutive day → +1; any gap → reset to 1.
 */
export function nextStreak(current: number, lastActivity: string | null, today: string): number {
  if (!lastActivity) return 1;
  if (lastActivity === today) return Math.max(1, current);
  const diff = dayDiff(lastActivity, today);
  if (diff === 1) return current + 1;
  return 1;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}
