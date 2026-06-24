import { describe, expect, it } from 'vitest';
import {
  analyzeSubscriptions,
  buildSubscriptionsPrompt,
  parseSubscriptionsResponse,
  type SubscriptionEntryLike,
} from '@/lib/finance/subscriptions-ai';

function sub(overrides: Partial<SubscriptionEntryLike> = {}): SubscriptionEntryLike {
  return { name: 'Netflix', cost_cents: 1599, cadence: 'monthly', category: 'Streaming', status: 'active', last_used: null, ...overrides };
}

describe('analyzeSubscriptions', () => {
  it('summarizes active subscriptions', () => {
    const r = analyzeSubscriptions([
      sub({ name: 'Netflix', cost_cents: 1599 }),
      sub({ name: 'Spotify', cost_cents: 999 }),
      sub({ name: 'Old App', status: 'canceled', cost_cents: 500 }),
    ]);
    expect(r.totalSubscriptions).toBe(3);
    expect(r.activeCount).toBe(2);
    expect(r.monthlySpendCents).toBe(1599 + 999);
    expect(r.annualSpendCents).toBe((1599 + 999) * 12);
    expect(r.summary).toContain('3 subscriptions');
  });

  it('normalizes yearly cadence to monthly', () => {
    const r = analyzeSubscriptions([sub({ cost_cents: 12000, cadence: 'yearly' })]);
    expect(r.monthlySpendCents).toBe(1000);
  });

  it('normalizes weekly cadence to monthly', () => {
    const r = analyzeSubscriptions([sub({ cost_cents: 100, cadence: 'weekly' })]);
    expect(r.monthlySpendCents).toBe(Math.round(100 * 52 / 12));
  });

  it('detects stale subscriptions', () => {
    const old = new Date();
    old.setDate(old.getDate() - 90);
    const r = analyzeSubscriptions([sub({ last_used: old.toISOString().slice(0, 10) })]);
    expect(r.staleCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeSubscriptions([]);
    expect(r.totalSubscriptions).toBe(0);
    expect(r.monthlySpendCents).toBe(0);
    expect(r.summary).toContain('0 subscriptions');
  });
});

describe('buildSubscriptionsPrompt', () => {
  it('builds prompt with subscription info', () => {
    const { system, user } = buildSubscriptionsPrompt([
      sub({ name: 'Netflix', cost_cents: 1599 }),
    ]);
    expect(system).toContain('JSON');
    expect(user).toContain('Netflix');
    expect(user).toContain('1 subscription');
  });
});

describe('parseSubscriptionsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseSubscriptionsResponse('{"suggestions":["cancel unused"],"savingOpportunities":["bundle streaming"],"managementTip":"review monthly"}');
    expect(r.suggestions).toEqual(['cancel unused']);
    expect(r.savingOpportunities).toEqual(['bundle streaming']);
    expect(r.managementTip).toBe('review monthly');
  });

  it('handles malformed input', () => {
    const r = parseSubscriptionsResponse('garbage');
    expect(r.suggestions).toEqual([]);
    expect(r.savingOpportunities).toEqual([]);
    expect(r.managementTip).toBe('');
  });

  it('handles code fences', () => {
    const r = parseSubscriptionsResponse('```json\n{"suggestions":["x"],"savingOpportunities":["y"],"managementTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });

  it('caps arrays at limits', () => {
    const r = parseSubscriptionsResponse(JSON.stringify({
      suggestions: ['a', 'b', 'c', 'd', 'e'],
      savingOpportunities: ['1', '2', '3', '4'],
      managementTip: 'tip',
    }));
    expect(r.suggestions).toHaveLength(4);
    expect(r.savingOpportunities).toHaveLength(3);
  });
});
