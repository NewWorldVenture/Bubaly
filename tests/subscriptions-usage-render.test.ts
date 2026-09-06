import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubLike } from '@/lib/finance/subscriptions';
import { usd } from '@/lib/finance/splits';
import { SubscriptionsModule } from '@/components/modules/subscriptions-module';

type Fixture = SubLike & { id: string; name: string; category: string | null; next_charge: string | null };
const state = vi.hoisted(() => ({ subs: [] as Fixture[], createClient: vi.fn() }));

vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'test-family', userId: 'test-user', selfMember: { id: 'test-member', role: 'parent', is_active: true } }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: state.subs, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: state.createClient }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/modules/savings-coach-card', () => ({ SavingsCoachCard: () => null }));

function sub(id: string, overrides: Partial<Fixture> = {}): Fixture {
  return { id, name: id, cost_cents: 1500, cadence: 'monthly', status: 'active', last_used: null, category: 'Streaming', next_charge: null, ...overrides };
}

function reviewCost(html: string): string | undefined {
  return /Usage review \/ mo<\/p><p[^>]*>([^<]+)<\/p>/.exec(html)?.[1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-24T00:00:00Z'));
  state.subs = [];
  state.createClient.mockReset();
  state.createClient.mockImplementation(() => { throw new Error('Rendering must not access a database'); });
});

afterEach(() => {
  vi.useRealTimers();
  expect(state.createClient).not.toHaveBeenCalled();
});

describe('subscription usage presentation', () => {
  it('shows unknown usage with a correction action and no asserted waste or savings', () => {
    state.subs = [sub('No recorded date'), sub('Omitted date', { last_used: undefined }), sub('Blank date', { last_used: '' })];
    const html = renderToStaticMarkup(createElement(SubscriptionsModule));
    expect(html.match(/usage unknown; Edit to add last use/g)).toHaveLength(3);
    expect(reviewCost(html)).toBe(usd(0));
    expect(html).toContain('title="Mark used today"');
    expect(html).not.toContain('never used');
    expect(html).not.toContain('unused');
    expect(html).not.toContain('Wasted / mo');
    expect(html).not.toContain('You could save');
  });

  it('distinguishes invalid and future dates without formatting them as recorded use', () => {
    state.subs = [
      sub('Invalid date', { last_used: 'not-a-date' }),
      sub('Impossible date', { last_used: '2026-02-30' }),
      sub('Future date', { last_used: '2026-06-25' }),
    ];
    const html = renderToStaticMarkup(createElement(SubscriptionsModule));
    expect(html.match(/last-use date is invalid; Edit to correct/g)).toHaveLength(2);
    expect(html).toContain('last-use date is in the future; Edit to correct');
    expect(html).not.toContain('last recorded use');
    expect(html).not.toContain('never used');
    expect(reviewCost(html)).toBe(usd(0));
  });

  it('reviews only old recorded use on active or trial subscriptions while preserving recorded dates', () => {
    state.subs = [
      sub('Old active', { cost_cents: 500, last_used: '2026-01-01' }),
      sub('Old trial', { cost_cents: 12000, cadence: 'yearly', status: 'trial', last_used: '2026-01-01' }),
      sub('Recent', { last_used: '2026-06-23' }),
      sub('Unknown'),
      sub('Paused', { status: 'paused', last_used: '2026-01-01' }),
      sub('Canceled', { status: 'canceled', last_used: '2026-01-01' }),
    ];
    const html = renderToStaticMarkup(createElement(SubscriptionsModule));
    expect(reviewCost(html)).toBe(usd(1500));
    expect(html.match(/review usage<\/span>/g)).toHaveLength(2);
    expect(html.match(/last recorded use/g)).toHaveLength(5);
    expect(html).toContain('Confirm current household use before deciding what to keep. This amount is not confirmed savings.');
    expect(html).toContain('Reactivate');
    expect(html).not.toContain('You could save');
    expect(html).not.toContain('unused');
  });
});
