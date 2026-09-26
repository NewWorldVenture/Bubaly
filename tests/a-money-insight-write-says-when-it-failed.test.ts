import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, between } from './helpers/source-order';

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

const insight = { kind: 'heavy_week', title: 'Heavy week', detail: 'Rent and insurance', severity: 'warn', weekStart: '2026-10-05', amount: 1800 };
const db = (errors: unknown[]) => {
  let n = 0;
  return { from: () => ({ upsert: () => Promise.resolve({ error: errors[n++] ?? null }) }) };
};
const actions = () => import('@/app/(app)/dashboard/money-timeline/actions');

beforeEach(() => {
  requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('the copilot insight writes say whether they landed', () => {
  it('a refused dismissal is not ok', async () => {
    createServer.mockResolvedValue(db([{ message: 'rls' }]));
    const res = await (await actions()).setMoneyInsightStatusAction({ insight: insight as never, status: 'dismissed' });
    expect(res).toEqual({ ok: false });
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
    loadMoneyTimeline.mockResolvedValue({ insights: [insight, { ...insight, kind: 'goal_gap' }] });
    const res = await (await actions()).syncMoneyInsightsAction();
    expect(res).toEqual({ ok: false });
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
  const mod = readFileSync('components/modules/money-timeline-module.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('neither call is fire-and-forget any more', () => {
    expect(mod).not.toMatch(/void setMoneyInsightStatusAction\(/);
    expect(mod).not.toMatch(/void syncMoneyInsightsAction\(/);
    // A rejected call is logged and treated as a failure, not dropped.
    expect(mod).toContain(".catch(failedWrite('insight status save'))");
    expect(mod).toContain(".catch(failedWrite('insight refresh'))");
  });

  it('a refused dismissal restores the insight before saying so', () => {
    const act = between(mod, 'const act = (', 'const refresh = (');
    expect(at(act, 'if (res.ok) return;')).toBeLessThan(at(act, 'if (previous === undefined) delete next[insight.key];'));
    expect(at(act, 'if (previous === undefined) delete next[insight.key];')).toBeLessThan(at(act, "setWriteError(t('moneyTimeline.couldNotSaveThatInsight'))"));
  });

  it('a failed refresh is named', () => {
    expect(mod).toContain("if (!res.ok) setWriteError(t('moneyTimeline.couldNotRefreshYourInsights'));");
    expect(mod).toContain('{writeError && <p role="alert"');
  });
});
