import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { between } from './helpers/source-order';

/**
 * Audit C1-S9-73 — the Financial Copilot's two writes returned nothing and
 * discarded their results, and the module fired them as `void action()`. A
 * refused dismissal vanished anyway and came back on the next visit; a failed
 * refresh looked like one with nothing new.
 */
const requireUserContext = vi.fn();
const createServer = vi.fn();
const loadMoneyTimeline = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimeline: (...a: unknown[]) => loadMoneyTimeline(...a) }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }),
}));

// A payload main's validation admits (merged in Audit C1-S9-89): 0168's CHECKs
// allow `watch`, not `warn`, and `goal_at_risk`, not `goal_gap`. The first
// version of this fixture was rejected before it reached the write it tests.
const insight = { kind: 'heavy_week', title: 'Heavy week', detail: 'Rent and insurance', severity: 'watch', weekStart: '2026-10-05', amount: 1800 };
const db = (errors: unknown[]) => {
  let n = 0;
  return { from: () => ({ upsert: () => Promise.resolve({ error: errors[n++] ?? null }) }) };
};
const actions = () => import('@/app/(app)/dashboard/money-timeline/actions');

beforeEach(() => {
  // `family.timezone`: main's money timeline reads the family's day; `role`: a
  // dismissal is a manager's call since 0352 (merge, Audit C1-S9-89).
  requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1', role: 'parent', family: { timezone: 'UTC' } } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('the copilot insight writes say whether they landed', () => {
  it('a refused dismissal is not ok', async () => {
    createServer.mockResolvedValue(db([{ message: 'rls' }]));
    const res = await (await actions()).setMoneyInsightStatusAction({ insight: insight as never, status: 'dismissed' });
    expect(res.ok).toBe(false);
    expect(res.error, 'the caller needs a sentence to show').toBeTruthy();
  });

  it('a saved dismissal is ok', async () => {
    createServer.mockResolvedValue(db([]));
    const res = await (await actions()).setMoneyInsightStatusAction({ insight: insight as never, status: 'dismissed' });
    expect(res).toEqual({ ok: true });
  });

  it('a refresh with any refused write is not ok, and still writes the rest', async () => {
    const upserts: unknown[] = [];
    let n = 0;
    createServer.mockResolvedValue({ from: () => ({ upsert: (row: unknown) => { upserts.push(row); return Promise.resolve({ error: n++ === 0 ? { message: 'rls' } : null }); } }) });
    loadMoneyTimeline.mockResolvedValue({ insights: [insight, { ...insight, kind: 'goal_at_risk' }] });
    const res = await (await actions()).syncMoneyInsightsAction();
    expect(res.ok).toBe(false);
    expect(upserts).toHaveLength(2);
  });

  it('a refresh where everything landed is ok', async () => {
    createServer.mockResolvedValue(db([]));
    loadMoneyTimeline.mockResolvedValue({ insights: [insight] });
    const res = await (await actions()).syncMoneyInsightsAction();
    expect(res).toEqual({ ok: true });
  });
});

describe('the module undoes what it showed, and says so', () => {
  // main's module (merged in Audit C1-S9-89) awaits both calls in try/catch and
  // settles a card through the exported, pure `settleWrite` — so the undo is
  // proved on the function rather than on the spelling of the component.
  const mod = readFileSync('components/modules/money-timeline-module.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('neither call is fire-and-forget any more', () => {
    expect(mod).not.toMatch(/void setMoneyInsightStatusAction\(/);
    expect(mod).not.toMatch(/void syncMoneyInsightsAction\(/);
    expect(mod).toContain('settle(await setMoneyInsightStatusAction({ insight, status }));');
    expect(mod).toContain('const result = await syncMoneyInsightsAction();');
    // A rejected call is a failure too, not dropped.
    expect(between(mod, 'const act = async', 'const refresh = async')).toContain('settle(null);');
  });

  it('a refused dismissal restores the insight before saying so', async () => {
    const { settleWrite } = await import('@/components/modules/money-timeline-module');
    const refused = settleWrite('k1', 'active', { ok: false, error: 'rls said no' }, 'fallback');
    expect(refused.apply({ k1: 'dismissed', k2: 'acknowledged' })).toEqual({ k1: 'active', k2: 'acknowledged' });
    expect(refused.error).toBe('rls said no');
    // A transport failure (null) is not a saved choice either.
    const lost = settleWrite('k1', 'active', null, 'fallback');
    expect(lost.apply({ k1: 'dismissed' })).toEqual({ k1: 'active' });
    expect(lost.error).toBe('fallback');
    // Negative control: a landed write keeps what was shown and says nothing.
    const landed = settleWrite('k1', 'active', { ok: true }, 'fallback');
    expect(landed.apply({ k1: 'dismissed' })).toEqual({ k1: 'dismissed' });
    expect(landed.error).toBeNull();
  });

  it('a failed refresh is named', () => {
    expect(mod).toContain("if (!result?.ok) setActionError(result?.error || t('moneyTimeline.weCouldNotRefreshTheseInsights'));");
  });
});
