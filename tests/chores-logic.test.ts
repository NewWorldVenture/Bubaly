import { describe, expect, it } from 'vitest';
import {
  scaleByScore, computeReward, canAutoApprove, levelForXp, xpForLevel, levelProgress, nextStreak, type ChoreReward,
} from '@/lib/chores/logic';

const base: ChoreReward = {
  reward_mode: 'fixed_points', points: 50, points_min: null, points_max: null,
  cash_cents: null, cash_min_cents: null, cash_max_cents: null,
};

describe('scaleByScore', () => {
  it('interpolates min..max by score', () => {
    expect(scaleByScore(1, 5, 0)).toBe(1);
    expect(scaleByScore(1, 5, 100)).toBe(5);
    expect(scaleByScore(1, 5, 50)).toBe(3);
    expect(scaleByScore(100, 500, 85)).toBe(440);
  });
  it('clamps out-of-range scores', () => {
    expect(scaleByScore(1, 5, -20)).toBe(1);
    expect(scaleByScore(1, 5, 200)).toBe(5);
  });
});

describe('computeReward', () => {
  it('fixed points ignores score', () => {
    expect(computeReward(base, 10).points).toBe(50);
    expect(computeReward(base, 99).points).toBe(50);
  });
  it('fixed cash', () => {
    const r = computeReward({ ...base, reward_mode: 'fixed_cash', cash_cents: 300 }, 0);
    expect(r.type).toBe('cash');
    expect(r.cashCents).toBe(300);
    expect(r.label).toBe('$3.00');
  });
  it('ai cash scales within $1-$5 range', () => {
    const r = computeReward({ ...base, reward_mode: 'ai_cash', cash_min_cents: 100, cash_max_cents: 500 }, 85);
    expect(r.type).toBe('cash');
    expect(r.cashCents).toBe(440); // $1 + 85% of $4
  });
  it('ai points scales within range', () => {
    const r = computeReward({ ...base, reward_mode: 'ai_points', points_min: 10, points_max: 50 }, 50);
    expect(r.points).toBe(30);
  });
  it('responsibility pays nothing', () => {
    expect(computeReward({ ...base, reward_mode: 'responsibility' }, 100).type).toBe('none');
  });
  it('prize defers', () => {
    expect(computeReward({ ...base, reward_mode: 'prize' }, 100).type).toBe('prize');
  });
});

describe('canAutoApprove', () => {
  it('requires threshold, score, no flags, no parent-review', () => {
    expect(canAutoApprove({ autoApproveScore: 80, score: 90, needsParentReview: false, safetyFlags: [] })).toBe(true);
    expect(canAutoApprove({ autoApproveScore: 80, score: 70, needsParentReview: false, safetyFlags: [] })).toBe(false);
    expect(canAutoApprove({ autoApproveScore: null, score: 100, needsParentReview: false, safetyFlags: [] })).toBe(false);
    expect(canAutoApprove({ autoApproveScore: 80, score: 90, needsParentReview: true, safetyFlags: [] })).toBe(false);
    expect(canAutoApprove({ autoApproveScore: 80, score: 90, needsParentReview: false, safetyFlags: ['knife'] })).toBe(false);
  });
});

describe('xp + levels', () => {
  it('level thresholds follow the curve', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(300);
    expect(xpForLevel(4)).toBe(600);
  });
  it('levelForXp maps xp to level', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(299)).toBe(2);
    expect(levelForXp(300)).toBe(3);
  });
  it('levelProgress reports band position', () => {
    const p = levelProgress(200); // level 2, base 100, next 300, into 100/200
    expect(p.level).toBe(2);
    expect(p.intoLevel).toBe(100);
    expect(p.span).toBe(200);
    expect(p.pct).toBe(50);
  });
});

describe('streaks', () => {
  it('starts at 1 with no history', () => {
    expect(nextStreak(0, null, '2026-06-22')).toBe(1);
  });
  it('same day is unchanged', () => {
    expect(nextStreak(4, '2026-06-22', '2026-06-22')).toBe(4);
  });
  it('consecutive day increments', () => {
    expect(nextStreak(4, '2026-06-21', '2026-06-22')).toBe(5);
  });
  it('a gap resets to 1', () => {
    expect(nextStreak(9, '2026-06-19', '2026-06-22')).toBe(1);
  });
});
