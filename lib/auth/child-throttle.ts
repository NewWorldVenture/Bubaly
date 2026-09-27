// lib/auth/child-throttle.ts — pure brute-force policy for child (username+PIN)
// sign-in. A 4-digit PIN is only 10,000 combinations and kid usernames are
// guessable (suggested from the display name), so unthrottled sign-in is a real
// account-takeover risk. This module decides — from a persisted attempt record —
// whether a sign-in may proceed, and how the record evolves on failure/success.
// DOM-free + DB-free so the policy is unit-tested; the server does the read/write.

/** Persisted throttle state for one login key (a normalized username). */
export interface ThrottleRow {
  fails: number;            // consecutive failures in the current window
  window_start: string;     // ISO — when the current counting window began
  locked_until: string | null; // ISO — locked out until this instant, or null
}

export interface ThrottlePolicy {
  /** Failures allowed within the window before a lockout. */
  maxFails: number;
  /** Counting window length (ms). Failures older than this reset the counter. */
  windowMs: number;
  /** Base lockout length (ms). Escalates with repeated lockouts. */
  lockMs: number;
  /**
   * How long after a lockout lifts its failures are still counted (ms), so the
   * next failure escalates instead of starting a fresh window. Without it the
   * escalation below could never fire: a lock always outlasts the window.
   */
  lockMemoryMs: number;
}

export const DEFAULT_POLICY: ThrottlePolicy = {
  maxFails: 5,
  windowMs: 15 * 60_000, // 15 minutes
  lockMs: 15 * 60_000,   // 15 minutes
  lockMemoryMs: 24 * 60 * 60_000, // a day
};

export interface ThrottleDecision {
  /** True when the caller must be rejected before even attempting a password check. */
  locked: boolean;
  /** Seconds until the lock lifts (0 when not locked). */
  retryAfterSec: number;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Is this key currently locked out? Deterministic given `now`. */
export function evaluateThrottle(
  row: ThrottleRow | null | undefined,
  now: Date = new Date(),
): ThrottleDecision {
  const lockedUntil = ms(row?.locked_until);
  if (row?.locked_until && lockedUntil > now.getTime()) {
    return { locked: true, retryAfterSec: Math.ceil((lockedUntil - now.getTime()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

/**
 * The next persisted state after a FAILED attempt. Failures within the window
 * accumulate; crossing `maxFails` triggers a lockout whose length escalates when
 * the account was already recently locked (repeat offenders wait longer).
 *
 * "Recently locked" is `lockMemoryMs` after the lock lifts. The window alone
 * cannot carry it: the lock is as long as the window and starts after the
 * window does, so by the time a lock lifted the window had always closed, the
 * count restarted at 1, and every lockout was the base 15 minutes. Measured
 * against a patient guesser: 96 lockouts a day, all 15 minutes, 480 guesses a
 * day — a 4-digit PIN in about ten days on average. A success clears all of it.
 */
export function registerFailure(
  row: ThrottleRow | null | undefined,
  now: Date = new Date(),
  policy: ThrottlePolicy = DEFAULT_POLICY,
): ThrottleRow {
  const nowMs = now.getTime();
  const windowStart = ms(row?.window_start);
  const lockedUntil = ms(row?.locked_until);
  const rememberedUntil = Math.max(windowStart + policy.windowMs, lockedUntil > 0 ? lockedUntil + policy.lockMemoryMs : 0);
  const withinWindow = row && windowStart > 0 && nowMs < rememberedUntil;

  const fails = (withinWindow ? row!.fails : 0) + 1;
  const window_start = withinWindow ? row!.window_start : now.toISOString();

  let locked_until: string | null = withinWindow ? (row!.locked_until ?? null) : null;
  if (fails >= policy.maxFails) {
    // Escalate: each lockout while already-been-locked doubles the wait (capped 8×).
    const priorLocks = Math.max(0, Math.floor(fails / policy.maxFails) - 1);
    const factor = Math.min(8, 2 ** priorLocks);
    locked_until = new Date(nowMs + policy.lockMs * factor).toISOString();
  }
  return { fails, window_start, locked_until };
}

/** The state after a SUCCESSFUL sign-in — a clean slate. */
export function clearedState(now: Date = new Date()): ThrottleRow {
  return { fails: 0, window_start: now.toISOString(), locked_until: null };
}

/** Friendly "try again in …" text for the retry-after seconds. */
export function retryAfterLabel(sec: number): string {
  if (sec <= 0) return 'a moment';
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const m = Math.ceil(sec / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
