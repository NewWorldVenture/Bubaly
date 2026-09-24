import { describe, it, expect } from 'vitest';
import {
  evaluateThrottle, registerFailure, clearedState, retryAfterLabel,
  DEFAULT_POLICY, type ThrottleRow,
} from '@/lib/auth/child-throttle';

const AT = (iso: string) => new Date(iso);
const T0 = '2026-07-07T12:00:00.000Z';

describe('evaluateThrottle', () => {
  it('is unlocked with no record', () => {
    expect(evaluateThrottle(null, AT(T0))).toEqual({ locked: false, retryAfterSec: 0 });
  });

  it('is unlocked once the lock instant has passed', () => {
    const row: ThrottleRow = { fails: 5, window_start: T0, locked_until: '2026-07-07T12:05:00.000Z' };
    expect(evaluateThrottle(row, AT('2026-07-07T12:05:01Z')).locked).toBe(false);
  });

  it('is locked while locked_until is in the future, reporting retry-after', () => {
    const row: ThrottleRow = { fails: 5, window_start: T0, locked_until: '2026-07-07T12:10:00.000Z' };
    const d = evaluateThrottle(row, AT('2026-07-07T12:09:30Z'));
    expect(d.locked).toBe(true);
    expect(d.retryAfterSec).toBe(30);
  });
});

describe('registerFailure', () => {
  it('starts a fresh window on the first failure', () => {
    const r = registerFailure(null, AT(T0));
    expect(r.fails).toBe(1);
    expect(r.window_start).toBe(T0);
    expect(r.locked_until).toBeNull();
  });

  it('accumulates failures within the window without locking below the threshold', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 4; i++) r = registerFailure(r, AT(T0));
    expect(r.fails).toBe(4);
    expect(r.locked_until).toBeNull();
  });

  it('locks out on the 5th failure within the window', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 5; i++) r = registerFailure(r, AT(T0));
    expect(r.fails).toBe(5);
    expect(r.locked_until).not.toBeNull();
    // 15-minute base lock.
    expect(Date.parse(r.locked_until!) - Date.parse(T0)).toBe(DEFAULT_POLICY.lockMs);
  });

  it('forgets ordinary failures once the window has elapsed', () => {
    // A child who mistypes a few times and comes back later starts fresh.
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 4; i++) r = registerFailure(r, AT(T0)); // fails=4, never locked
    const later = new Date(Date.parse(T0) + 16 * 60_000).toISOString();
    const r2 = registerFailure(r, new Date(later));
    expect(r2.fails).toBe(1);
    expect(r2.locked_until).toBeNull();
    expect(r2.window_start).toBe(later);
  });

  it('remembers a lockout after it lifts, so the next failure locks again (SEC-022)', () => {
    // This case used to assert the opposite — that 16 minutes after a lockout
    // the counter was back to 1. That was the defect: the lock (15 min) always
    // outlasted the window (15 min), so no lockout was ever "repeat" and the
    // escalation below could not happen through sign-in.
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 5; i++) r = registerFailure(r, AT(T0)); // locked until T0+15m
    const afterLock = new Date(Date.parse(T0) + 16 * 60_000);
    expect(evaluateThrottle(r, afterLock).locked).toBe(false);
    const r2 = registerFailure(r, afterLock);
    expect(r2.fails).toBe(6);
    expect(Date.parse(r2.locked_until!) - afterLock.getTime()).toBe(DEFAULT_POLICY.lockMs);
  });

  it('forgets a lockout once its memory has passed', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 5; i++) r = registerFailure(r, AT(T0));
    const forgotten = new Date(Date.parse(r.locked_until!) + DEFAULT_POLICY.lockMemoryMs + 1_000);
    const r2 = registerFailure(r, forgotten);
    expect(r2).toEqual({ fails: 1, window_start: forgotten.toISOString(), locked_until: null });
  });

  it('escalates the lockout for repeat offenders in the same window', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 10; i++) r = registerFailure(r, AT(T0)); // fails=10 → 2× lock
    expect(r.fails).toBe(10);
    expect(Date.parse(r.locked_until!) - Date.parse(T0)).toBe(DEFAULT_POLICY.lockMs * 2);
  });
});

describe('a patient guesser, through the gate the sign-in action uses', () => {
  // Guesses whenever evaluateThrottle allows, one per second, and otherwise
  // waits exactly until the lock lifts. Before SEC-022 this was 480 guesses a
  // day with every lockout the base 15 minutes: a 4-digit PIN in ~10 days on
  // average. The policy's own comment promised escalation; now it happens.
  function guessFor(days: number) {
    let row: ThrottleRow | null = null;
    let t = Date.parse(T0);
    const end = t + days * 86_400_000;
    let guesses = 0;
    const lockMinutes = new Set<number>();
    while (t < end) {
      const gate = evaluateThrottle(row, new Date(t));
      if (gate.locked) { t += gate.retryAfterSec * 1000; continue; }
      const before: string | null = row?.locked_until ?? null;
      row = registerFailure(row, new Date(t));
      guesses += 1;
      if (row.locked_until && row.locked_until !== before) lockMinutes.add((Date.parse(row.locked_until) - t) / 60_000);
      t += 1000;
    }
    return { guesses, lockMinutes: [...lockMinutes].sort((a, b) => a - b) };
  }

  it('escalates the lockout all the way to its cap', () => {
    expect(guessFor(1).lockMinutes).toEqual([15, 30, 60, 120]);
  });

  it('holds a sustained guesser to a few dozen guesses a day, not hundreds', () => {
    expect(guessFor(1).guesses).toBeLessThanOrEqual(30);
    expect(guessFor(7).guesses).toBeLessThanOrEqual(7 * 15);
  });

  it('gains nothing by waiting out the memory instead', () => {
    // Five guesses, then sit out the lock and the memory: fewer per day than
    // guessing straight through.
    const perDay = DEFAULT_POLICY.maxFails / ((DEFAULT_POLICY.lockMs + DEFAULT_POLICY.lockMemoryMs) / 86_400_000);
    expect(perDay).toBeLessThan(guessFor(7).guesses / 7);
  });
});

describe('clearedState', () => {
  it('returns a clean slate on success', () => {
    expect(clearedState(AT(T0))).toEqual({ fails: 0, window_start: T0, locked_until: null });
  });
});

describe('retryAfterLabel', () => {
  it('formats seconds and minutes', () => {
    expect(retryAfterLabel(0)).toBe('a moment');
    expect(retryAfterLabel(30)).toBe('30 seconds');
    expect(retryAfterLabel(1)).toBe('1 second');
    expect(retryAfterLabel(90)).toBe('2 minutes');
    expect(retryAfterLabel(60)).toBe('1 minute');
  });
});
