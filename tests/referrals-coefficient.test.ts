// X12 — new households per existing household. Above 1 the product grows
// without spend; below it, every family is one you had to buy.
import { describe, it, expect } from 'vitest';
import { referralCoefficient } from '@/lib/referrals/core';

const referrals = (...statuses: string[]) => statuses.map((status) => ({ status }));
const invites = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe('referralCoefficient', () => {
  it('is null — not 0 — when there are no households to divide by', () => {
    const c = referralCoefficient({ households: 0, referralRows: referrals('converted'), inviteRows: [] });
    expect(c.coefficient).toBeNull();
    expect(c.joined).toBe(1);
  });

  it('counts referrals that produced a household', () => {
    const c = referralCoefficient({
      households: 10,
      referralRows: referrals('signed_up', 'converted', 'rewarded'),
      inviteRows: [],
    });
    expect(c.fromReferrals).toBe(3);
    expect(c.coefficient).toBe(0.3);
  });

  it('does not count a code that was only handed out', () => {
    // `pending` measures enthusiasm, not growth.
    const c = referralCoefficient({
      households: 4,
      referralRows: referrals('pending', 'pending', 'expired', 'converted'),
      inviteRows: [],
    });
    expect(c.fromReferrals).toBe(1);
    expect(c.coefficient).toBe(0.25);
  });

  it('counts accepted invites alongside referrals', () => {
    const c = referralCoefficient({
      households: 5,
      referralRows: referrals('converted'),
      inviteRows: invites('accepted', 'accepted', 'pending', 'revoked', 'expired'),
    });
    expect(c.fromInvites).toBe(2);
    expect(c.joined).toBe(3);
    expect(c.coefficient).toBe(0.6);
  });

  it('reports a coefficient above 1 when the loop outruns the base', () => {
    const c = referralCoefficient({
      households: 2,
      referralRows: referrals('converted', 'converted', 'rewarded'),
      inviteRows: invites('accepted'),
    });
    expect(c.coefficient).toBe(2);
  });

  it('rounds to two decimals', () => {
    const c = referralCoefficient({ households: 3, referralRows: referrals('converted'), inviteRows: [] });
    expect(c.coefficient).toBe(0.33);
  });

  it('answers 0 for a real week with no referrals at all', () => {
    // Zero is honest HERE: the households were read, the referrals were read,
    // and nobody joined. That is different from a null.
    const c = referralCoefficient({ households: 12, referralRows: [], inviteRows: [] });
    expect(c.coefficient).toBe(0);
    expect(c.households).toBe(12);
  });

  it('never takes a negative household count', () => {
    const c = referralCoefficient({ households: -4, referralRows: [], inviteRows: [] });
    expect(c.households).toBe(0);
    expect(c.coefficient).toBeNull();
  });
});
