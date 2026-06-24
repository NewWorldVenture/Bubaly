import { describe, expect, it } from 'vitest';
import { analyzeRewards, buildRewardsPrompt, parseRewardsResponse, type RewardForAI } from '@/lib/rewards/rewards-ai';

function reward(overrides: Partial<RewardForAI> = {}): RewardForAI {
  return { title: 'Extra screen time', cost_points: 50, redeemed_at: null, ...overrides };
}

describe('analyzeRewards', () => {
  it('summarizes rewards', () => {
    const r = analyzeRewards([reward(), reward({ redeemed_at: '2025-06-01' })]);
    expect(r.totalRewards).toBe(2);
    expect(r.redeemedCount).toBe(1);
    expect(r.totalPoints).toBe(100);
  });
  it('handles empty', () => { expect(analyzeRewards([]).summary).toContain('No rewards'); });
});

describe('buildRewardsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildRewardsPrompt([reward()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Extra screen time');
  });
});

describe('parseRewardsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRewardsResponse('{"suggestions":["add experience rewards"],"motivationTips":["celebrate effort"],"rewardIdea":"movie night"}');
    expect(r.suggestions).toEqual(['add experience rewards']);
  });
  it('handles malformed', () => { expect(parseRewardsResponse('bad').suggestions).toEqual([]); });
});
