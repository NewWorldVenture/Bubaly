// household-roles N6-R1-WALLET-METERS-FORGEABLE, round 7.
//
// The Money Coach (family-wide and per child, one shared counter) and the Money
// Mentor are capped at five calls a day on Basic. Each cap counted
// `wallet_audit_logs` rows ('ai_coach_call', 'ai_invest_call') from ANY actor,
// and any member may append to that trail as themselves with any action and
// any created_at (wallet_audit_logs_insert, 0380), so a child could write five
// and the parents were refused both helpers for the day.
//
// Each cap now counts the server's own record of a call, as the Relationship
// Helper's does since round 6: the `ai_requests` row withAiRequest files for
// it, kind 'feature', settled 'completed'. A member may file only a 'concierge'
// request, 'queued' (0255), and may not update one.
//
// Driven through the real routes, the real request recorder, the real plan
// resolver and the real tiers, over the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000c7701';
const PARENT = '00000000-0000-4000-8000-0000000c7711';
const CHILD = '00000000-0000-4000-8000-0000000c7712';
const WALLET = '00000000-0000-4000-8000-0000000c7721';
const NOW = new Date('2026-10-14T15:00:00Z');

const h = vi.hoisted(() => ({ db: null as unknown, service: null as unknown, caller: 'parent' as 'parent' | 'child', complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: h.caller === 'parent' ? PARENT : CHILD },
    memberships: [],
    active: {
      familyId: FAMILY, role: h.caller,
      member: { id: `member-${h.caller}`, display_name: h.caller === 'parent' ? 'Dana' : 'Kit' },
      family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
    },
  }),
  // A super administrator's raise has its own tests; here the family's plan stands.
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.service }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'test-model', complete: h.complete }),
}));
// The per-minute limit has its own tests.
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const { POST: coach } = await import('@/app/api/ai/wallet/route');
const { POST: childCoach } = await import('@/app/api/ai/wallet/child/[childId]/route');
const { POST: mentor } = await import('@/app/api/ai/invest/route');

/** One reply each helper can use: the coach reads the headline and insights, the mentor the explainer. */
const USABLE = JSON.stringify({ headline: 'Saving is going well.', insights: ['Kit is close to the bike.'], explainer: 'Compounding is interest on interest.', tips: [] });

type Helper = { name: string; call: () => Promise<Response>; trailAction: string };
const FAMILY_COACH: Helper = { name: 'the family coach', call: () => coach(), trailAction: 'ai_coach_call' };
const CHILD_COACH: Helper = {
  name: 'a child’s coach', trailAction: 'ai_coach_call',
  call: () => childCoach(new Request('https://fixture.invalid'), { params: Promise.resolve({ childId: WALLET }) }),
};
const MENTOR: Helper = {
  name: 'the money mentor', trailAction: 'ai_invest_call',
  call: () => mentor(new Request('https://fixture.invalid/api/ai/invest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }) as never),
};
const HELPERS = [FAMILY_COACH, CHILD_COACH, MENTOR];

let db: InMemorySupabase;

/** `count` rows dated today, a minute apart, before NOW. */
function today<T extends Record<string, unknown>>(count: number, row: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => ({ ...row(i), created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString() }));
}

/** The model answers with a reply every helper can use, or with one none can. */
function modelAnswers(usable: boolean) {
  h.complete.mockResolvedValue({ text: usable ? USABLE : '{}', model: 'test-model' });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase();
  h.db = db;
  h.service = db;
  h.caller = 'parent';
  h.complete.mockReset();
  modelAnswers(true);
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  // Family Basic: the wallet's Basic tier, whose coach and mentor are metered at five a day.
  db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: PARENT, display_name: 'Dana', role: 'parent', is_active: true },
    { id: 'member-child', family_id: FAMILY, user_id: CHILD, display_name: 'Kit', role: 'child', is_active: true },
  ]);
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'member-child', is_active: true }]);
  db.seed('wallet_buckets', [{ id: 'bucket-save', family_id: FAMILY, child_wallet_id: WALLET, kind: 'save' }]);
  db.seed('wallet_transactions', [{ id: 'txn-1', family_id: FAMILY, child_wallet_id: WALLET, bucket_id: 'bucket-save', type: 'parent_top_up', status: 'completed', direction: 'credit', amount_cents: 5000, created_at: '2026-10-01T09:00:00Z' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Money Coach’s and the Money Mentor’s daily caps count only the server’s record of a call', () => {
  describe.each(HELPERS)('$name', (helper) => {
    it.each([
      ['a child’s own trail rows (0380 lets a member write them as themselves)', CHILD],
      ['trail rows with no actor', null],
    ])('five planted %s do not use up the parents’ day', async (_label, actor) => {
      db.seed('wallet_audit_logs', today(5, (i) => ({
        id: `planted-${i}`, family_id: FAMILY, actor_user_id: actor, action: helper.trailAction,
        entity_type: helper === MENTOR ? 'ai_invest_mentor' : 'ai_wallet_coach', detail: 'AI Money Coach generated',
      })));

      const res = await helper.call();

      expect(res.status).toBe(200);
      expect(h.complete).toHaveBeenCalledTimes(1);
    });

    it('five requests of the kind a member may file (concierge, queued) do not use it up either', async () => {
      db.seed('ai_requests', today(5, (i) => ({
        id: `concierge-${i}`, family_id: FAMILY, requested_by: CHILD, requested_by_member_id: 'member-child',
        kind: 'concierge', feature: helper === MENTOR ? 'invest.mentor' : 'wallet.coach', status: 'queued', request_text: 'Money help',
      })));

      const res = await helper.call();

      expect(res.status).toBe(200);
      expect(h.complete).toHaveBeenCalledTimes(1);
    });

    it('control: a meter that cannot be read refuses, and calls no model', async () => {
      h.service = withFaults(db, (table, calls) => (table === 'ai_requests' && calls.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head)
        ? { message: 'Synthetic meter failure' } : null));

      const res = await helper.call();

      expect(res.status).toBe(503);
      expect(h.complete).not.toHaveBeenCalled();
    });

    it('control: a call that produced nothing usable is not counted', async () => {
      modelAnswers(false);
      for (let i = 0; i < 5; i++) expect((await helper.call()).status).toBe(502);
      expect(db.table('ai_requests').filter((r) => r.status === 'failed')).toHaveLength(5);

      modelAnswers(true);
      expect((await helper.call()).status).toBe(200);
    });
  });

  it('control: five real coachings, the family’s and a child’s, by a parent and a child, use up the shared coach for the day, and the sixth calls no model', async () => {
    const calls = [FAMILY_COACH, CHILD_COACH, FAMILY_COACH, CHILD_COACH, FAMILY_COACH];
    for (const [i, helper] of calls.entries()) {
      h.caller = i % 2 ? 'child' : 'parent';
      expect((await helper.call()).status).toBe(200);
    }
    expect(db.table('ai_requests')).toHaveLength(5);
    expect(db.table('ai_requests').every((r) => r.kind === 'feature' && r.status === 'completed')).toBe(true);
    expect(db.table('ai_requests').map((r) => r.feature).sort()).toEqual(['wallet.coach', 'wallet.coach', 'wallet.coach', 'wallet.coach.child', 'wallet.coach.child']);

    h.caller = 'parent';
    for (const helper of [FAMILY_COACH, CHILD_COACH]) {
      const res = await helper.call();
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'wallet.coachDailyLimitReached' });
    }
    expect(h.complete).toHaveBeenCalledTimes(5);

    // The mentor keeps its own counter, as it did.
    expect((await MENTOR.call()).status).toBe(200);
  });

  it('control: five real explainers use up the mentor for the day, and the sixth calls no model; the coach keeps its own counter', async () => {
    for (let i = 0; i < 5; i++) {
      h.caller = i % 2 ? 'child' : 'parent';
      expect((await MENTOR.call()).status).toBe(200);
    }
    expect(db.table('ai_requests').every((r) => r.kind === 'feature' && r.feature === 'invest.mentor' && r.status === 'completed')).toBe(true);

    h.caller = 'parent';
    const res = await MENTOR.call();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'invest.mentorDailyLimitReached' });
    expect(h.complete).toHaveBeenCalledTimes(5);

    expect((await FAMILY_COACH.call()).status).toBe(200);
  });

  it('control: yesterday’s calls are not today’s', async () => {
    db.seed('ai_requests', Array.from({ length: 5 }, (_, i) => ({
      id: `yesterday-${i}`, family_id: FAMILY, requested_by: PARENT, requested_by_member_id: 'member-parent',
      kind: 'feature', feature: 'wallet.coach', status: 'completed', request_text: 'Money coaching for the family',
      created_at: new Date(Date.parse('2026-10-13T23:00:00Z') - i * 60_000).toISOString(),
    })));

    expect((await FAMILY_COACH.call()).status).toBe(200);
  });
});
