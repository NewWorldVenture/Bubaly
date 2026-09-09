import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { annualListPriceCents, compareEstimatedTimeValue } from '@/lib/metric/value';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
const { loadFamilyValueComparisonAction } = await import('@/app/(app)/dashboard/billing/value-comparison-actions');
const { ValueComparisonSummary } = await import('@/components/billing/family-value-comparison');
const { loadFamilyValue } = await import('@/lib/metric/value-server');
const NOW = new Date('2026-09-09T12:00:00Z');
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase();
  db.seed('subscriptions', [{ id: 'sub', family_id: 'ours', plan: 'basic', status: 'active' }]);
  db.seed('family_automation_runs', [
    { id: 'ours-done', family_id: 'ours', state: 'completed', status: 'executed', completed_at: '2026-09-08T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
    { id: 'theirs', family_id: 'theirs', state: 'completed', status: 'executed', completed_at: '2026-09-08T00:00:00Z' },
  ]);
  mocks.requireUserContext.mockResolvedValue({ active: { familyId: 'ours' } });
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('time value arithmetic', () => {
  it('compares the same seven days and uses exact annual list prices', () => {
    const monthly = compareEstimatedTimeValue(60, 25, annualListPriceCents('basic')!);
    expect(monthly?.estimatedValueCents).toBe(2500);
    expect(monthly?.periodListCents).toBeCloseTo(999 * 12 * 7 / 365.25);
    expect(monthly?.ratio).toBeCloseTo(2500 / (999 * 12 * 7 / 365.25));
    expect(annualListPriceCents('basic_annual')).toBe(9999);
    expect(annualListPriceCents('family_annual')).toBe(9999);
    expect(annualListPriceCents('plus_annual')).toBe(24999);
    expect(annualListPriceCents('plus')).toBe(2499 * 12);
    expect(annualListPriceCents('free')).toBe(0);
    expect(annualListPriceCents('unknown')).toBeNull();
  });
  it.each([[NaN, 25, 12000], [-1, 25, 12000], [10, Infinity, 12000], [10, -1, 12000], [10, 1001, 12000], [10, 25, 0], [10, 25, NaN]])('rejects invalid estimate inputs %j', (minutes, hourly, price) => {
    expect(compareEstimatedTimeValue(minutes, hourly, price)).toBeNull();
  });
  it('keeps a zero week and a chosen zero hourly value valid', () => {
    expect(compareEstimatedTimeValue(0, 25, 12000)).toMatchObject({ estimatedValueCents: 0, ratio: 0 });
    expect(compareEstimatedTimeValue(12, 0, 12000)).toMatchObject({ estimatedValueCents: 0, ratio: 0 });
  });
});

describe('family value read boundary', () => {
  it('loads only the authenticated household and counts completion time rather than creation time', async () => {
    expect(await loadFamilyValueComparisonAction()).toEqual({ familyId: 'ours', result: { state: 'available', completedRuns: 1, undatedCompletedRuns: 0, annualListCents: 11988 } });
    expect(mocks.requireUserContext).toHaveBeenCalledOnce();
    expect(mocks.createServer).toHaveBeenCalledOnce();
  });
  it('preserves authentication redirects before any database access', async () => {
    const redirect = new Error('NEXT_REDIRECT');
    mocks.requireUserContext.mockRejectedValue(redirect);
    await expect(loadFamilyValueComparisonAction()).rejects.toBe(redirect);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
  it.each([['free', 'active'], ['plus', 'trialing'], ['plus', 'canceled'], ['plus', 'past_due']])('omits comparisons for %s/%s', async (plan, status) => {
    db.replace('subscriptions', [{ family_id: 'ours', plan, status }]);
    expect(await loadFamilyValueComparisonAction()).toEqual({ familyId: 'ours', result: { state: 'ineligible' } });
  });
  it.each([
    { rows: [] }, { rows: [{ family_id: 'theirs', plan: 'plus', status: 'active' }] },
    { rows: [{ family_id: 'ours', plan: 'unknown', status: 'active' }] },
    { rows: [{ family_id: 'ours', plan: 'plus', status: 'unknown' }] },
  ])('does not replace unknown subscription evidence with a free plan: %j', async ({ rows }) => {
    db.replace('subscriptions', rows);
    expect((await loadFamilyValueComparisonAction()).result).toEqual({ state: 'unavailable' });
  });
  it('returns unavailable for subscription and transport failures', async () => {
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    expect(await loadFamilyValue(db as never, 'ours', NOW)).toEqual({ state: 'unavailable' });
    mocks.createServer.mockRejectedValue(new Error('client offline'));
    expect((await loadFamilyValueComparisonAction()).result).toEqual({ state: 'unavailable' });
  });
});

describe('estimate presentation', () => {
  it('exposes the run-only basis, editable hourly assumption, list price, and undated exclusions', () => {
    const html = renderToStaticMarkup(createElement(ValueComparisonSummary, { result: { state: 'available', completedRuns: 2, undatedCompletedRuns: 3, annualListCents: 11988 }, onRetry: vi.fn() }));
    expect(html).toContain('2 recorded plan completions in the last 7 days');
    expect(html).toContain('24 modeled minutes');
    expect(html).toContain('type="number"');
    expect(html).toContain('USD/hour');
    expect(html).toContain('$10.00');
    expect(html).toContain('3 completed plans have no completion date');
    expect(html).toContain('not measured time or cash saved');
    expect(html).toContain('not your invoice');
    expect(html).toContain('reminders are excluded');
  });
  it('separates a real zero week from unavailable and ineligible results', () => {
    const render = (result: Parameters<typeof ValueComparisonSummary>[0]['result']) => renderToStaticMarkup(createElement(ValueComparisonSummary, { result, onRetry: vi.fn() }));
    expect(render({ state: 'available', completedRuns: 0, undatedCompletedRuns: 0, annualListCents: 11988 })).toContain('$0.00');
    expect(render({ state: 'unavailable' })).toContain('Try again');
    expect(render({ state: 'unavailable' })).not.toContain('$0.00');
    expect(render({ state: 'ineligible' })).toBe('');
    expect(render(null)).toContain('Loading');
  });
});
