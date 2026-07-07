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

  it('resets the counter when the window has elapsed', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 5; i++) r = registerFailure(r, AT(T0)); // locked, fails=5
    // 16 minutes later the window has expired → back to a single fresh failure.
    const later = new Date(Date.parse(T0) + 16 * 60_000).toISOString();
    const r2 = registerFailure(r, new Date(later));
    expect(r2.fails).toBe(1);
    expect(r2.locked_until).toBeNull();
    expect(r2.window_start).toBe(later);
  });

  it('escalates the lockout for repeat offenders in the same window', () => {
    let r = registerFailure(null, AT(T0));
    for (let i = 2; i <= 10; i++) r = registerFailure(r, AT(T0)); // fails=10 → 2× lock
    expect(r.fails).toBe(10);
    expect(Date.parse(r.locked_until!) - Date.parse(T0)).toBe(DEFAULT_POLICY.lockMs * 2);
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
