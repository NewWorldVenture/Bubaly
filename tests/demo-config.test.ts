import { describe, it, expect } from 'vitest';
import {
  DEMO_TTL_MINUTES, demoExpiry, demoSecondsLeft, formatCountdown,
  isLikelyEmail, isDemoEmailUsedUp,
} from '@/lib/demo/config';

const NOW = new Date('2026-07-08T12:00:00Z');

describe('demoExpiry', () => {
  it('is TTL minutes after now', () => {
    expect(demoExpiry(NOW).getTime()).toBe(NOW.getTime() + DEMO_TTL_MINUTES * 60_000);
  });
});

describe('demoSecondsLeft', () => {
  it('counts down and clamps at zero', () => {
    const exp = new Date(NOW.getTime() + 90_000).toISOString(); // 90s out
    expect(demoSecondsLeft(exp, NOW)).toBe(90);
    const past = new Date(NOW.getTime() - 5_000).toISOString();
    expect(demoSecondsLeft(past, NOW)).toBe(0);
  });
  it('handles a bad date as 0', () => {
    expect(demoSecondsLeft('not-a-date', NOW)).toBe(0);
  });
});

describe('formatCountdown', () => {
  it('renders M:SS with padding', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('isLikelyEmail', () => {
  it('accepts normal addresses, rejects garbage/empty', () => {
    expect(isLikelyEmail('testjimmy@yahoo.com')).toBe(true);
    expect(isLikelyEmail('  a@b.co  ')).toBe(true);
    expect(isLikelyEmail('')).toBe(false);
    expect(isLikelyEmail('not-an-email')).toBe(false);
    expect(isLikelyEmail('a@b')).toBe(false);
    expect(isLikelyEmail('a b@c.com')).toBe(false);
  });
});

describe('isDemoEmailUsedUp', () => {
  it('blocks only once the recorded window has passed', () => {
    const past = new Date(NOW.getTime() - 1_000).toISOString();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(isDemoEmailUsedUp(past, NOW)).toBe(true);      // window over → blocked
    expect(isDemoEmailUsedUp(future, NOW)).toBe(false);   // still inside → allowed
  });
  it('fails open on missing or unparsable records', () => {
    expect(isDemoEmailUsedUp(null, NOW)).toBe(false);
    expect(isDemoEmailUsedUp(undefined, NOW)).toBe(false);
    expect(isDemoEmailUsedUp('not-a-date', NOW)).toBe(false);
  });
});
