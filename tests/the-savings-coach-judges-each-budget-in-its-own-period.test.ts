// M11 — the AI savings coach judges each budget in its own period, on the
// family's calendar.
//
// POST /api/ai/savings took "this month" from `new Date().toISOString()`, the
// UTC month: from 17:00 on the last day of a month Los Angeles read next
// month's empty window and was told there was no overspending, and Tokyo kept
// counting last month until 09:00 on the 1st. It then set that month of
// spending against each budget's raw amount whatever its period: $400 of
// groceries in a month against a $150 WEEKLY budget read as "$250 over", and a
// yearly budget was never over. Categories matched case-sensitively and the
// window had no end, so next month's scheduled rows counted.
//
// The route is driven for real against an in-memory database. The model is
// left unconfigured so the deterministic suggestions come back, and once
// configured to read the facts the model is handed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, tz: 'UTC', complete: vi.fn() }));

// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  refuseOverAIAllowance: async () => null,
  withinAIAllowance: async () => true,
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-parent' }, family: { id: 'family-1', timezone: harness.tz } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
// The plan gate is covered by tests/route-plan-gate.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: unknown) => unknown) => run({ used() {}, failed() {} }),
}));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: async () => ({ complete: harness.complete }), isAIConfigured: async () => true }));

const { POST } = await import('@/app/api/ai/savings/route');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

let db: InMemorySupabase;
let seq = 0;
const expense = (date: string, amount: number, category: string, status = 'posted') =>
  ({ id: `t-${String(++seq).padStart(5, '0')}`, family_id: FAMILY, name: category, amount, category, date, type: 'expense', status });
const budget = (category: string, amount: number, period: string) =>
  ({ id: `b-${String(++seq).padStart(5, '0')}`, family_id: FAMILY, category, amount, period, created_at: '2026-01-01T00:00:00Z' });

type Suggestion = { title: string; detail: string };
async function suggestions(): Promise<Suggestion[]> {
  const res = await POST();
  expect(res.status).toBe(200);
  return ((await res.json()) as { suggestions: Suggestion[] }).suggestions;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  harness.tz = 'UTC';
  // No model: the route answers its deterministic, data-driven suggestions.
  harness.complete.mockReset().mockRejectedValue(new Error('AI is not configured'));
  seq = 0;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the savings coach reads the family\'s month', () => {
  it('at 17:30 on 31 October in Los Angeles, October\'s overspend is still October\'s', async () => {
    harness.tz = 'America/Los_Angeles';
    vi.setSystemTime(new Date('2026-11-01T00:30:00Z')); // 17:30 PDT, 31 October
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    db.seed('transactions', [expense('2026-10-05', 200, 'Groceries'), expense('2026-10-20', 200, 'Groceries')]);

    const out = await suggestions();
    expect(out).toContainEqual({ title: 'Trim Groceries spending', detail: t('savings.overYourMonthlyBudget', { amount: '$100', category: 'Groceries' }) });
  });

  it('at 08:00 on 1 November in Tokyo, October is no longer this month', async () => {
    harness.tz = 'Asia/Tokyo';
    vi.setSystemTime(new Date('2026-10-31T23:00:00Z')); // 08:00 JST, 1 November
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    db.seed('transactions', [expense('2026-10-05', 400, 'Groceries')]);

    const out = await suggestions();
    expect(out.map((s) => s.title)).not.toContain('Trim Groceries spending');
  });
});

describe('each budget is set against its own period', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))); // a Tuesday; the week began Sunday 11 October

  it('a weekly budget is not "over" because of last week\'s spending', async () => {
    db.seed('budgets', [budget('Groceries', 150, 'weekly')]);
    db.seed('transactions', [
      expense('2026-10-02', 300, 'Groceries'), // the week before
      expense('2026-10-12', 100, 'Groceries'), // this week
    ]);
    const out = await suggestions();
    expect(out.map((s) => s.title)).not.toContain('Trim Groceries spending');
  });

  it('a yearly budget can be over', async () => {
    db.seed('budgets', [budget('Travel', 6000, 'yearly')]);
    db.seed('transactions', [expense('2026-03-10', 4000, 'Travel'), expense('2026-07-01', 3000, 'Travel')]);
    const out = await suggestions();
    expect(out).toContainEqual({ title: 'Trim Travel spending', detail: t('savings.overYourYearlyBudget', { amount: '$1000', category: 'Travel' }) });
  });

  it('matches categories however they are spelled, and leaves next month\'s scheduled rows out', async () => {
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    db.seed('transactions', [
      expense('2026-10-03', 250, 'groceries'),
      expense('2026-10-09', 100, 'Groceries'),
      expense('2026-11-01', 900, 'Groceries', 'scheduled'),
    ]);
    const out = await suggestions();
    expect(out).toContainEqual({ title: 'Trim Groceries spending', detail: t('savings.overYourMonthlyBudget', { amount: '$50', category: 'Groceries' }) });
  });

  it('the model is told each overspend with its period', async () => {
    harness.complete.mockReset().mockResolvedValue({ text: '{"summary":"ok","suggestions":[]}', model: 'test', usage: {} });
    db.seed('budgets', [budget('Groceries', 150, 'weekly'), budget('Travel', 6000, 'yearly')]);
    db.seed('transactions', [expense('2026-10-12', 200, 'Groceries'), expense('2026-02-01', 6500, 'Travel')]);
    await POST();
    const prompt = (harness.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
    expect(prompt).toContain('Groceries (weekly budget) +$50');
    expect(prompt).toContain('Travel (yearly budget) +$500');
  });
});

// M11-RATCHET — the year of spending the coach sums is read on the id.
//
// The read spans up to a year plus the leading week, which is many pages. It
// was paged on offsets, so a transaction recorded between two pages (here, a
// January pet bill entered while the coach was reading) shifted every row
// after it by one place: the last row of the first page came back as the first
// row of the second, and Groceries was summed one row high.
describe('a year of spending is read once, row by row, while it is written to', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-10-13T12:00:00Z')));

  it('a row recorded between two pages does not count a grocery shop twice', async () => {
    db.seed('budgets', [budget('Groceries', 1500, 'monthly'), budget('Travel', 100, 'monthly')]);
    // October: 1,500 one-dollar shops, exactly the budget, and one trip over its own.
    db.seed('transactions', Array.from({ length: 1500 }, (_, i) => expense(`2026-10-${String(1 + (i % 12)).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', [expense('2026-10-02', 150, 'Travel')]);
    let pages = 0;
    harness.db = withFaults(db, (table) => {
      // Before the second page: a January row, dated ahead of every October one.
      if (table === 'transactions' && ++pages === 2) {
        db.seed('transactions', [{ id: 't-00000', family_id: FAMILY, name: 'Vet', amount: 80, category: 'Pets', date: '2026-01-05', type: 'expense', status: 'posted' }]);
      }
      return null;
    });

    const out = await suggestions();
    expect(pages).toBeGreaterThan(1);
    // The read happened: Travel is over by its own $50.
    expect(out).toContainEqual({ title: 'Trim Travel spending', detail: t('savings.overYourMonthlyBudget', { amount: '$50', category: 'Travel' }) });
    // And Groceries is the $1,500 it is, not over by a row read twice.
    expect(out.map((s) => s.title)).not.toContain('Trim Groceries spending');
  });
});
