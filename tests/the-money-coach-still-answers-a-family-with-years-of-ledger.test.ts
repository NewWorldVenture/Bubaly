// The AI Money Coach summed a family's whole wallet ledger in the route, read
// with a ceiling of 3,000 rows family-wide (2,000 for one child's coach), and
// readAll answers a read past its ceiling as a FAILED read, so the route
// refused with 502 "could not generate coaching right now" on every call, for
// good: every credit writes one ledger row per bucket it is split into, so a
// family on weekly allowances crosses 3,000 rows in a few years. The child's
// wallet page sums the same ledger with a ceiling of 50,000 and kept showing
// the balance the coach would no longer talk about.
//
// Both coaches now read as far as the page does. Past that they still refuse
// rather than coach on part of a ledger.
//
// Finding N10 (child-money-scope). Driven through the real routes, the real
// request recorder, plan resolver and tiers, over the in-memory database with
// PostgREST's 1,000-row response cap; the model is the one seam.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { formatCents } from '@/lib/wallet/ledger';

const FAMILY = '00000000-0000-4000-8000-0000000d1001';
const PARENT = '00000000-0000-4000-8000-0000000d1011';
const WALLET = '00000000-0000-4000-8000-0000000d1021';
const NOW = new Date('2026-10-14T15:00:00Z');
/** Seven years of a weekly allowance split four ways, and then some. */
const LEDGER_ROWS = 3_600;
const CENTS_EACH = 25;

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT },
    memberships: [],
    active: {
      familyId: FAMILY, role: 'parent',
      member: { id: 'member-parent', display_name: 'Dana' },
      family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
    },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'test-model', complete: h.complete }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const { POST: familyCoach } = await import('@/app/api/ai/wallet/route');
const { POST: childCoach } = await import('@/app/api/ai/wallet/child/[childId]/route');

const USABLE = JSON.stringify({ headline: 'Saving is going well.', insights: ['Kit has saved steadily for years.'], suggestion: 'Keep going.' });

let db: InMemorySupabase;

/** What the route asked the model, as the user turn it sent. */
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1_000 });
  h.db = db;
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: USABLE, model: 'test-model' });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: PARENT, display_name: 'Dana', role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, user_id: null, display_name: 'Kit', role: 'child', is_active: true },
  ]);
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'member-child', is_active: true }]);
  db.seed('wallet_buckets', [{ id: 'bucket-save', family_id: FAMILY, child_wallet_id: WALLET, kind: 'save' }]);
  db.seed('wallet_transactions', Array.from({ length: LEDGER_ROWS }, (_, i) => ({
    id: `txn-${String(i).padStart(6, '0')}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-save',
    type: 'allowance', status: 'completed', direction: 'credit', amount_cents: CENTS_EACH,
    created_at: new Date(Date.UTC(2019, 0, 1) + i * 3_600_000).toISOString(),
  })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the money coach still answers a family with years of ledger', () => {
  const saved = formatCents(LEDGER_ROWS * CENTS_EACH);

  it(`the family coach answers past 3,000 rows, on the whole ledger's figures`, async () => {
    const res = await familyCoach();

    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(prompt()).toContain(`Kit: ${saved} total (${saved} saved)`);
  });

  it(`a child's coach answers past 2,000 rows, on the whole ledger's figures`, async () => {
    const res = await childCoach(new Request('https://fixture.invalid'), { params: Promise.resolve({ childId: WALLET }) });

    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(prompt()).toContain(`Total balance: ${saved}`);
    expect(prompt()).toContain(`Save: ${saved}`);
  });
});
