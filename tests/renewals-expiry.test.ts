import { describe, it, expect } from 'vitest';
import {
  daysToExpiry, isActive, isExpired, isExpiringSoon, expiryBucket,
  groupByExpiry, renewalStats, rollForward, type RenewalLike,
} from '@/lib/renewals/expiry';

const today = '2026-06-21';
const r = (over: Partial<RenewalLike>): RenewalLike => ({
  id: Math.random().toString(36).slice(2), expires_at: '2026-07-21', reminder_days: 30, status: 'active', ...over,
});

describe('daysToExpiry', () => {
  it('counts signed whole days', () => {
    expect(daysToExpiry(r({ expires_at: '2026-06-28' }), today)).toBe(7);
    expect(daysToExpiry(r({ expires_at: '2026-06-18' }), today)).toBe(-3);
  });
});

describe('isExpired', () => {
  it('flags active renewals past expiry only', () => {
    expect(isExpired(r({ expires_at: '2026-06-20' }), today)).toBe(true);
    expect(isExpired(r({ expires_at: '2026-06-22' }), today)).toBe(false);
    expect(isExpired(r({ expires_at: '2026-06-01', status: 'renewed' }), today)).toBe(false);
  });
});

describe('isExpiringSoon', () => {
  it('uses each item\'s own reminder window', () => {
    // 20 days out, reminder 30 → soon
    expect(isExpiringSoon(r({ expires_at: '2026-07-11', reminder_days: 30 }), today)).toBe(true);
    // 20 days out, reminder 7 → not yet
    expect(isExpiringSoon(r({ expires_at: '2026-07-11', reminder_days: 7 }), today)).toBe(false);
    // already expired → not "soon"
    expect(isExpiringSoon(r({ expires_at: '2026-06-10', reminder_days: 30 }), today)).toBe(false);
  });
});

describe('expiryBucket', () => {
  it('classifies by status, expiry, and reminder window', () => {
    expect(expiryBucket(r({ status: 'renewed' }), today)).toBe('done');
    expect(expiryBucket(r({ expires_at: '2026-06-10' }), today)).toBe('expired');
    expect(expiryBucket(r({ expires_at: '2026-07-01', reminder_days: 30 }), today)).toBe('soon');
    expect(expiryBucket(r({ expires_at: '2026-12-01', reminder_days: 30 }), today)).toBe('upcoming');
  });
});

describe('groupByExpiry', () => {
  it('buckets and sorts active groups by expiry', () => {
    const groups = groupByExpiry([
      r({ id: 'a', expires_at: '2026-12-01', reminder_days: 30 }),
      r({ id: 'b', expires_at: '2026-09-01', reminder_days: 30 }),
      r({ id: 'c', expires_at: '2026-06-10' }),
    ], today);
    expect(groups.upcoming.map((x) => x.id)).toEqual(['b', 'a']);
    expect(groups.expired.map((x) => x.id)).toEqual(['c']);
  });
});

describe('renewalStats', () => {
  it('summarises active/expiringSoon/expired', () => {
    const stats = renewalStats([
      r({ expires_at: '2026-07-01', reminder_days: 30 }), // soon + active
      r({ expires_at: '2026-06-10' }),                    // expired + active
      r({ expires_at: '2027-01-01', reminder_days: 30 }), // active
      r({ status: 'renewed', expires_at: '2026-06-01' }), // not active
    ], today);
    expect(stats.active).toBe(3);
    expect(stats.expiringSoon).toBe(1);
    expect(stats.expired).toBe(1);
  });
});

describe('rollForward', () => {
  it('advances the expiry by N months (default 12)', () => {
    expect(rollForward('2026-07-21')).toBe('2027-07-21');
    expect(rollForward('2026-07-21', 6)).toBe('2027-01-21');
  });
});
