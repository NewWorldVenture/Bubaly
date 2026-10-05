import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionsWorkspace } from '@/components/modules/subscriptions-module';
import { expenseSuggestions, type FamilySnapshot } from '@/lib/autopilot/engine';
import type { Tables } from '@/lib/database.types';
import { nextOccurrenceOnOrAfter, projectedNextCharge, subscriptionCadence } from '@/lib/finance/subscription-schedule';
import { createFormat } from '@/lib/utils/format';
import { renderTranslated } from './helpers/render-translated';

type Subscription = Tables<'subscriptions_tracked'>;
const state = vi.hoisted(() => ({ rows: [] as Subscription[], createClient: vi.fn() }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: state.rows, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: state.createClient }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/modules/savings-coach-card', () => ({ SavingsCoachCard: () => null }));

const context = { familyId: 'synthetic-family', userId: 'synthetic-user', memberId: 'synthetic-member', role: 'parent' as const, active: true };
const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  id: 'synthetic-sub', family_id: context.familyId, name: 'Synthetic subscription', cost_cents: 1599,
  cadence: 'monthly', status: 'active', next_charge: '2026-01-27', last_used: '2026-06-24',
  category: 'Streaming', note: null, created_by: context.userId,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});
const snapshot = (today: string, subscriptions: FamilySnapshot['subscriptions']): FamilySnapshot => ({
  today, tz: 'UTC', renewals: [], appointments: [], overdueChores: [], birthdays: [],
  lingeringGroceries: [], events: [], subscriptions, stressSignals: [], medications: [],
  favoriteMeals: [], plannedDinnerDays: [], insurance: [],
});
const tracked = (nextCharge: string | null, cadence = 'monthly', status = 'active'): FamilySnapshot['subscriptions'][number] => ({
  id: 'synthetic-sub', name: 'Synthetic subscription', costCents: 1599, cadence, nextCharge, lastUsed: null, status,
});
const chargeSuggestions = (today: string, nextCharge: string | null, cadence = 'monthly', status = 'active') =>
  expenseSuggestions(snapshot(today, [tracked(nextCharge, cadence, status)]), 'en-US', key => key)
    .filter(row => row.dedupeKey.startsWith('sub-charge:'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-24T12:00:00Z'));
  state.rows = [subscription()];
  state.createClient.mockReset().mockImplementation(() => { throw new Error('Projection must not write to a database'); });
});
afterEach(() => { vi.useRealTimers(); expect(state.createClient).not.toHaveBeenCalled(); });

describe('subscription projection keeps the stored anchor', () => {
  it.each([
    ['2026-01-31', 'monthly', '2026-02-10', '2026-02-28'],
    ['2026-01-31', 'monthly', '2026-03-01', '2026-03-31'],
    ['2026-01-31', 'monthly', '2026-03-31', '2026-03-31'],
    ['2026-01-02', 'weekly', '2026-06-24', '2026-06-26'],
    ['2026-01-02', 'biweekly', '2026-06-24', '2026-07-03'],
    ['2025-11-10', 'quarterly', '2026-06-24', '2026-08-10'],
    ['2024-02-29', 'yearly', '2028-02-01', '2028-02-29'],
    ['1900-01-02', 'weekly', '2026-06-24', '2026-06-30'],
    ['2026-06-27', 'monthly', '2026-06-24', '2026-06-27'],
  ] as const)('%s / %s from %s projects %s', (anchor, cadence, today, expected) => {
    expect(nextOccurrenceOnOrAfter(anchor, cadence, today)).toBe(expected);
  });
  it('uses supported aliases and the existing subscription monthly fallback safely', () => {
    expect(subscriptionCadence(' Quarterly ')).toBe('quarterly');
    expect(subscriptionCadence('annually')).toBe('yearly');
    expect(subscriptionCadence('fortnightly')).toBe('biweekly');
    for (const value of [null, 'unknown', 'constructor']) expect(subscriptionCadence(value)).toBe('monthly');
  });
  it('does not invent a charge date for a missing or impossible anchor', () => {
    for (const value of [null, '', 'soon', '2026-02-30']) expect(projectedNextCharge(value, 'monthly', '2026-06-24')).toBeNull();
    expect(projectedNextCharge('2026-01-27T00:00:00.000Z', 'monthly', '2026-06-24')).toBe('2026-06-27');
  });
});

describe('actual autopilot projects every charge cycle', () => {
  it('emits a current-cycle heads-up even when the hand-entered date is months old', () => {
    const [june] = chargeSuggestions('2026-06-24', '2026-01-27');
    expect(june).toMatchObject({ dedupeKey: 'sub-charge:synthetic-sub:2026-06-27', expiresAt: '2026-06-27T23:59:59Z',
      payload: { subscriptionId: 'synthetic-sub', titleFacts: { kind: 'charge', inDays: 3 } } });
    const [july] = chargeSuggestions('2026-07-24', '2026-01-27');
    expect(july.dedupeKey).toBe('sub-charge:synthetic-sub:2026-07-27');
  });
  it('includes today and preserves fresh, future and inactive-status behavior', () => {
    expect(chargeSuggestions('2026-06-27', '2026-01-27')[0].payload).toMatchObject({ titleFacts: { inDays: 0 } });
    expect(chargeSuggestions('2026-06-24', '2026-06-27')).toHaveLength(1);
    expect(chargeSuggestions('2026-06-24', '2026-01-14')).toHaveLength(0);
    expect(chargeSuggestions('2026-06-24', null)).toHaveLength(0);
    expect(chargeSuggestions('2026-06-24', '2026-01-27', 'monthly', 'trial')).toHaveLength(1);
    for (const status of ['paused', 'canceled']) expect(chargeSuggestions('2026-06-24', '2026-01-27', 'monthly', status)).toHaveLength(0);
  });
});

describe('rendered subscription list shows the charge coming on the family day', () => {
  it('renders the projected date instead of the old anchor, without changing the stored row', () => {
    const html = renderTranslated(createElement(SubscriptionsWorkspace, { context, timezone: 'UTC' }));
    const date = createFormat('en-US').fmtDate('2026-06-27');
    expect(html).toContain(`next ${date}`);
    expect(state.rows[0].next_charge).toBe('2026-01-27');
  });
  it.each([
    ['America/New_York', '2026-05-31'], ['UTC', '2026-06-30'],
  ])('uses %s at the same UTC month boundary', (timezone, expected) => {
    vi.setSystemTime(new Date('2026-06-01T02:00:00Z'));
    state.rows = [subscription({ next_charge: '2026-01-31' })];
    const html = renderTranslated(createElement(SubscriptionsWorkspace, { context, timezone }));
    expect(html).toContain(`next ${createFormat('en-US').fmtDate(expected)}`);
  });
  it('retains a future stored date and omits the charge label when no anchor is known', () => {
    state.rows = [subscription({ next_charge: '2026-06-27' })];
    expect(renderTranslated(createElement(SubscriptionsWorkspace, { context, timezone: 'UTC' })))
      .toContain(`next ${createFormat('en-US').fmtDate('2026-06-27')}`);
    state.rows = [subscription({ next_charge: null })];
    expect(renderTranslated(createElement(SubscriptionsWorkspace, { context, timezone: 'UTC' }))).not.toContain(' · next ');
  });
});
