// M16, M17 and M18 — a money answer from the assistant is not built on a read
// that failed, nor on a column that is not there.
//
//   M16  AI Finance Insight (kind "billing") returned both reads' `data ?? []`
//        with no error check, so a failed read reached the model as "No
//        subscriptions." / "0 items" at HTTP 200. And even when the reads
//        worked it summed `amount`, a column expense_splits does not have
//        (it carries `total_cents`), so the model was told "total ~$0" on
//        every request.
//   M17  AI spending insights (kind "expenses") turned a failed expense_splits
//        read into "Total of recent expenses: $0.00 across 0 entries" at 200.
//   M18  The interactive brief dropped the bills read's error: a failed read
//        became "no bills due", and the brief went on at 200. The cron brief
//        (lib/briefing/deliver.ts) already fails closed.
//
// Both routes are driven for real against an in-memory database; a read is
// failed the way supabase-js fails one, with `{ data: null, error }`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ 'accept-language': 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-one' },
    active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one', display_name: 'Ada' }, family: { timezone: 'UTC', name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => {
  const { entitledServiceClient } = await import('./helpers/entitled-service-client');
  return { createServer: async () => h.db, createServiceClient: () => entitledServiceClient() };
});
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
  describeAIError: () => ({ message: 'unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The per-kind plan gate is covered by tests/insight-kinds-are-gated-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }),
}));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));

const { POST: insights } = await import('@/app/api/ai/insights/route');
const { POST: briefing } = await import('@/app/api/ai/briefing/route');
const { getTranslations } = await import('@/lib/i18n/server');

let base: InMemorySupabase;
let failing: string | null;

beforeEach(() => {
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded answer.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const ask = (kind: string) => insights(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
const today = () => new Date().toISOString().slice(0, 10);

describe('M17 — AI spending insights', () => {
  it('a failed expense_splits read answers "could not load", and the model is not asked', async () => {
    failing = 'expense_splits';
    const res = await ask('expenses');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe((await getTranslations())('insights.couldNotLoadDataFor'));
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('still answers from the splits when the read succeeds (the control)', async () => {
    base.seed('expense_splits', [{ id: 's-1', family_id: FAMILY, description: 'Groceries run', total_cents: 4250, category: 'Groceries', paid_by: 'member-one', spent_on: today() }]);
    const res = await ask('expenses');
    expect(res.status).toBe(200);
    expect(prompt()).toContain('Total of recent expenses: $42.50 across 1 entries');
  });
});

describe('M16 — AI Finance Insight', () => {
  it.each(['subscriptions_tracked', 'expense_splits'])('a failed %s read answers "could not load", and the model is not asked', async (table) => {
    failing = table;
    const res = await ask('billing');
    expect(res.status).toBe(500);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('tells the model what the recent expenses came to, from their cents, by category', async () => {
    base.seed('expense_splits', [
      { id: 's-1', family_id: FAMILY, description: 'Groceries run', total_cents: 12345, category: 'Groceries', paid_by: 'member-one', spent_on: today() },
      { id: 's-2', family_id: FAMILY, description: 'Pizza night', total_cents: 5000, category: 'Dining', paid_by: 'member-one', spent_on: today() },
    ]);
    const res = await ask('billing');
    expect(res.status).toBe(200);
    expect(prompt()).toContain('Recent expenses: 2 items, total $173.45.');
    expect(prompt()).toContain('- Groceries: $123.45');
    expect(prompt()).toContain('- Dining: $50.00');
    expect(prompt()).not.toContain('~$0');
  });
});

describe('M18 — the interactive brief', () => {
  const TICK = new Date('2026-09-07T11:00:00Z');
  const brief = () => briefing(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type: 'morning' }) }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TICK);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); }));
    base.seed('bills', [{ id: 'bill-rent', family_id: FAMILY, name: 'Rent', amount: 1800, due_date: '2026-09-01', status: 'overdue', autopay: false }]);
  });

  it('a manager\'s brief lists the overdue rent (the control)', async () => {
    const res = await brief();
    expect(res.status).toBe(200);
    const body = await res.json() as { digest: { items: { domain: string; title: string }[] } };
    expect(body.digest.items.some((i) => i.domain === 'bill')).toBe(true);
  });

  it('a failed bills read is a brief that could not be made, not a calm morning', async () => {
    failing = 'bills';
    const res = await brief();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe((await getTranslations())('briefing.failedToGenerateBriefing'));
    expect(h.complete).not.toHaveBeenCalled();
  });
});
