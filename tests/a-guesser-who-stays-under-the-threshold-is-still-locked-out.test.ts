// LIBRARY-000CF4D7F670: a throttle row that never reached five failures has no
// lock, so its failures were remembered only for the 15-minute window and the
// count restarted at 1. A guesser sending four PINs per window was never locked
// and never escalated: 384 guesses a day against one username, a 4-digit PIN in
// about 13 days on average, which the module's own comment calls unacceptable
// at 480 a day. The per-address limit does not bound one username.
//
// Failures now count for a day unless a sign-in succeeds, so the fifth wrong PIN
// in a day locks and the escalation takes over from there. Every instant is
// fixed; nothing here reads the machine's clock or zone.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY, clearedState, evaluateThrottle, registerFailure, type ThrottleRow,
} from '@/lib/auth/child-throttle';

const T0 = Date.parse('2026-11-11T08:00:00.000Z');
const MIN = 60_000;
const DAY = 86_400_000;

/**
 * A guesser who never sends more than `perBurst` PINs in any `everyMs`,
 * whenever the gate lets them, for `days`.
 */
function paced(perBurst: number, everyMs: number, days: number) {
  let row: ThrottleRow | null = null;
  let guesses = 0;
  let locks = 0;
  const longest = { minutes: 0 };
  for (let burst = T0; burst < T0 + days * DAY; burst += everyMs) {
    for (let i = 0; i < perBurst; i += 1) {
      const at = new Date(burst + i * 1000);
      if (evaluateThrottle(row, at).locked) continue;
      const before: string | null = row?.locked_until ?? null;
      row = registerFailure(row, at);
      guesses += 1;
      if (row.locked_until && row.locked_until !== before) {
        locks += 1;
        longest.minutes = Math.max(longest.minutes, (Date.parse(row.locked_until) - at.getTime()) / MIN);
      }
    }
  }
  return { guesses, locks, longestLockMinutes: longest.minutes };
}

describe('a guesser who stays under the threshold is still locked out', () => {
  it('four wrong PINs, then one more sixteen minutes later, is five in a day and locks', () => {
    let row: ThrottleRow | null = null;
    for (let i = 0; i < 4; i += 1) row = registerFailure(row, new Date(T0 + i * 1000));
    expect(row).toMatchObject({ fails: 4, locked_until: null });

    const later = new Date(T0 + 16 * MIN);
    row = registerFailure(row, later);
    expect(row.fails).toBe(5);
    expect(Date.parse(row.locked_until!) - later.getTime()).toBe(DEFAULT_POLICY.lockMs);
    expect(evaluateThrottle(row, new Date(later.getTime() + 1000)).locked).toBe(true);
  });

  it('four PINs every fifteen minutes is held to a few dozen guesses a day, not 384', () => {
    const day = paced(4, 15 * MIN, 1);
    expect(day.locks).toBeGreaterThan(0);
    expect(day.guesses).toBeLessThanOrEqual(30);
    // And it escalates to the cap rather than repeating the base lock.
    expect(day.longestLockMinutes).toBe(120);
    expect(paced(4, 15 * MIN, 7).guesses).toBeLessThanOrEqual(7 * 15);
  });

  it('slower pacing does no better: one PIN every four minutes, or two an hour', () => {
    expect(paced(1, 4 * MIN, 1).guesses).toBeLessThanOrEqual(30);
    expect(paced(2, 60 * MIN, 1).guesses).toBeLessThanOrEqual(30);
  });

  it('the only pace that is never locked is under five a day', () => {
    const week = paced(4, DAY + MIN, 7);
    expect(week.locks).toBe(0);
    expect(week.guesses).toBe(28);
  });

  it('a child who mistypes and then signs in starts clean', () => {
    let row: ThrottleRow | null = null;
    for (let i = 0; i < 4; i += 1) row = registerFailure(row, new Date(T0 + i * 1000));
    // Sign-in clears the row on success (app/(auth)/actions.ts).
    row = clearedState(new Date(T0 + 5 * MIN));
    for (let i = 0; i < 4; i += 1) row = registerFailure(row, new Date(T0 + 6 * MIN + i * 1000));
    expect(row).toMatchObject({ fails: 4, locked_until: null });
  });

  it('a few mistypes are forgotten once a day has passed without a fifth', () => {
    let row: ThrottleRow | null = null;
    for (let i = 0; i < 4; i += 1) row = registerFailure(row, new Date(T0 + i * 1000));
    const nextDay = new Date(T0 + DAY + MIN);
    expect(registerFailure(row, nextDay)).toEqual({ fails: 1, window_start: nextDay.toISOString(), locked_until: null });
  });
});
