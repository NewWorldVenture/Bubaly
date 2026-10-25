import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// Two admin reads that failed were shown as values (coverage sweep round 9,
// class A):
//   - /admin/ai-activity's strip read a failed count as 0 — "Failed (last
//     24h): 0", an all-clear nobody gave — though the code beside it said a
//     dash beats a 500;
//   - /admin/billing's recent table read a failed family-name read as "—",
//     no family, for a subscription that has one.
// Each now reads Unavailable. The REAL pages, in-memory database with
// PostgREST's 1,000-row cap.
const CAP = 1000;

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, describeConfiguredServiceKey: () => null }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
// The signal-precision card has its own coverage and reads other tables.
vi.mock('@/lib/metric/signal-precision-server', () => ({ loadSignalPrecision: async () => ({ ok: false }) }));
vi.mock('@/components/metrics/signal-precision-card', () => ({ SignalPrecisionCard: () => null }));

let db: InMemorySupabase;
const m = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
const head = (calls: FaultCall[]) => calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head === true);

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('/admin/ai-activity: a summary count that FAILS is Unavailable, not 0', () => {
  const request = (k: number, status: string): Row => ({
    id: `req-${k}`, family_id: 'fam-1', user_id: null, feature: 'planner', status, model: null, error: null, prompt_tokens: 0,
    completion_tokens: 0, cost_cents: 0, latency_ms: 0, created_at: new Date(Date.UTC(2026, 9, 22, 10) + k * 1000).toISOString(),
  });
  async function render(): Promise<string> {
    const { default: Page } = await import('@/app/(app)/admin/ai-activity/page');
    return renderServerPage(await Page({ searchParams: Promise.resolve({}) }));
  }
  const tile = (html: string, labelKey: string) =>
    new RegExp(`<p class="text-xs text-muted">${m(labelKey, { hours: 24 })}</p><p class="[^"]*">([^<]*)</p>`).exec(html)?.[1];

  it.each([
    ['failed', 'adminAiActivity.failedLastHours', (c: FaultCall[]) => head(c) && c.some((call) => call.method === 'in' && (call.args[1] as string[]).includes('failed'))],
    ['in flight', 'adminAiActivity.inFlightLastHours', (c: FaultCall[]) => head(c) && c.some((call) => call.method === 'in' && (call.args[1] as string[]).includes('executing'))],
    ['total', 'adminAiActivity.totalLastHours', (c: FaultCall[]) => head(c) && !c.some((call) => call.method === 'in')],
  ])('the %s count', async (_, labelKey, failing) => {
    db.seed('ai_requests', [request(1, 'failed'), request(2, 'completed')]);
    let faulted = 0;
    h.db = withFaults(db, (table, calls) => {
      if (table !== 'ai_requests' || !failing(calls)) return null;
      faulted += 1;
      return { message: 'ai_requests unavailable' };
    });
    const html = await render();
    expect(faulted).toBe(1);
    expect(tile(html, labelKey)).toBe(unavailable);
    // The ledger below still renders.
    expect(textOf(html)).toContain('planner');
  });

  it('the control: every count read is its figure', async () => {
    db.seed('ai_requests', [request(1, 'failed'), request(2, 'completed')]);
    const html = await render();
    expect(tile(html, 'adminAiActivity.failedLastHours')).toBe('1');
    expect(tile(html, 'adminAiActivity.totalLastHours')).toBe('2');
    expect(html).not.toContain(unavailable);
  });
});

describe('/admin/billing: a family name read that FAILS is Unavailable, not "no family"', () => {
  async function render(): Promise<string> {
    const { default: Page } = await import('@/app/(app)/admin/billing/page');
    return renderServerPage(await Page());
  }
  function seed() {
    db.seed('subscriptions', [{ id: 'sub-1', family_id: 'fam-1', plan: 'plus', status: 'active', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', current_period_end: null }]);
    db.seed('families', [{ id: 'fam-1', name: 'Avery family' }]);
    db.seed('billing_customers', []);
  }
  const firstCell = (html: string) => /<td class="px-4 py-3 font-medium">([^<]*)<\/td>/.exec(html)?.[1];

  it('the recent table names it Unavailable', async () => {
    seed();
    h.db = withFaults(db, (table) => (table === 'families' ? { message: 'families unavailable' } : null));
    const html = await render();
    expect(html).not.toContain(SOURCE_MESSAGES['billing.couldNotLoadBillingData']);
    expect(firstCell(html)).toBe(unavailable);
  });

  it('the control: a name read that succeeds names the family', async () => {
    seed();
    expect(firstCell(await render())).toBe('Avery family');
  });
});
