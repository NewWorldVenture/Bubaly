import { describe, it, expect } from 'vitest';
import {
  earnedByMember, spentByMember, computeBalances, canAfford,
  type AssignmentLike, type RedemptionLike,
} from '@/lib/rewards/points';

const A = (member_id: string, status: string, points_awarded: number | null): AssignmentLike => ({ member_id, status, points_awarded });
const R = (member_id: string, cost_points: number, status: RedemptionLike['status']): RedemptionLike => ({ member_id, cost_points, status });

describe('earnedByMember', () => {
  it('sums only approved assignments with awarded points', () => {
    const earned = earnedByMember([
      A('kid', 'approved', 10),
      A('kid', 'approved', 5),
      A('kid', 'submitted', 20),   // not approved → ignored
      A('kid', 'approved', null),  // no points → ignored
      A('teen', 'approved', 15),
    ]);
    expect(earned.get('kid')).toBe(15);
    expect(earned.get('teen')).toBe(15);
  });
});

describe('spentByMember', () => {
  it('counts approved and fulfilled redemptions only', () => {
    const spent = spentByMember([
      R('kid', 50, 'approved'),
      R('kid', 30, 'fulfilled'),
      R('kid', 100, 'requested'), // pending → not spent yet
      R('kid', 20, 'rejected'),   // rejected → not spent
    ]);
    expect(spent.get('kid')).toBe(80);
  });
});

describe('computeBalances', () => {
  it('produces earned/spent/available per member', () => {
    const balances = computeBalances(
      ['kid', 'teen'],
      [A('kid', 'approved', 100), A('teen', 'approved', 40)],
      [R('kid', 30, 'fulfilled')],
    );
    const kid = balances.find((b) => b.memberId === 'kid')!;
    const teen = balances.find((b) => b.memberId === 'teen')!;
    expect(kid).toEqual({ memberId: 'kid', earned: 100, spent: 30, available: 70 });
    expect(teen).toEqual({ memberId: 'teen', earned: 40, spent: 0, available: 40 });
  });

  it('clamps available at zero and defaults missing members', () => {
    const balances = computeBalances(
      ['kid', 'ghost'],
      [A('kid', 'approved', 10)],
      [R('kid', 50, 'approved')],
    );
    expect(balances.find((b) => b.memberId === 'kid')!.available).toBe(0);
    expect(balances.find((b) => b.memberId === 'ghost')!).toEqual({ memberId: 'ghost', earned: 0, spent: 0, available: 0 });
  });
});

describe('canAfford', () => {
  it('checks available against cost', () => {
    const bal = { memberId: 'kid', earned: 100, spent: 40, available: 60 };
    expect(canAfford(bal, 60)).toBe(true);
    expect(canAfford(bal, 61)).toBe(false);
    expect(canAfford(undefined, 0)).toBe(false);
  });
});
