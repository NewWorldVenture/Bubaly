// household-roles N5-R1-RELATIONSHIP-METER-FORGEABLE, round 6.
//
// The Relationship Helper's twenty-a-day family cap counted `audit_logs` rows
// with action 'relationship_ai_digest' from ANY actor. Any member may append to
// their family's trail as themselves, with any action and any created_at
// (audit_insert, 0380), so a child or a guest could write twenty and the
// parents were refused for the day. And a member's own rows lose their actor
// once that member's login is deleted (actor_id is `on delete set null`), so a
// meter of rows with no actor would have had the same hole.
//
// The cap now counts the server's own record of a digest: the `ai_requests` row
// withAiRequest files for it, kind 'feature', settled 'completed'. A member may
// file only a 'concierge' request, 'queued' (0255), and may not update one.
//
// Driven through the real route, the real request recorder and the real
// allowance gate, over the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000b6601';
const PARENT = '00000000-0000-4000-8000-0000000b6611';
const CHILD = '00000000-0000-4000-8000-0000000b6612';
const NOW = new Date('2026-10-14T15:00:00Z');

const h = vi.hoisted(() => ({ db: null as unknown, caller: 'parent' as 'parent' | 'child', complete: vi.fn() }));
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
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
}));
// The per-minute limit, the paywall and the closed-account gate have their own tests.
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseIfLocked: async () => null }));
vi.mock('@/lib/server/account-standing', () => ({ refuseClosedOrTrialEnded: async () => null }));

const { POST } = await import('@/app/api/ai/relationship/route');

const DIGEST = JSON.stringify({ headline: 'Plan something small this week.', prompts: [], giftIdeas: [] });
let db: InMemorySupabase;

/** `count` rows dated today, a minute apart, before NOW. */
function today<T extends Record<string, unknown>>(count: number, row: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => ({ ...row(i), created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString() }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase();
  h.db = db;
  h.caller = 'parent';
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: DIGEST, model: 'test-model' });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  // Family Basic: no monthly allowance, so the daily cap is the only limit in play.
  db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('relationship_profile', [{ id: 'profile-1', family_id: FAMILY, partner_name: 'Bea', partner_member_id: null, interests: [], love_languages: [], gift_budget_cents: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Relationship Helper’s daily cap counts only the server’s record of a digest', () => {
  it.each([
    ['a child’s own trail rows (0380 lets a member write them as themselves)', CHILD],
    ['trail rows with no actor (a member’s, once their login was deleted)', null],
  ])('twenty planted %s do not use up the parents’ day', async (_label, actor) => {
    db.seed('audit_logs', today(20, (i) => ({
      id: `00000000-0000-4000-8000-0000000b67${String(i).padStart(2, '0')}`, family_id: FAMILY, actor_id: actor,
      action: 'relationship_ai_digest', resource: 'relationship', metadata: { requested_by: PARENT },
    })));

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ digest: { headline: 'Plan something small this week.' } });
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('twenty requests of the kind a member may file (concierge, queued) do not use it up either', async () => {
    db.seed('ai_requests', today(20, (i) => ({
      id: `00000000-0000-4000-8000-0000000b68${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: CHILD,
      requested_by_member_id: 'member-child', kind: 'concierge', feature: 'relationship.digest', status: 'queued',
      request_text: 'Relationship suggestions',
    })));

    const res = await POST();

    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('control: twenty real digests, a parent’s and a child’s, use up the family’s day, and the twenty-first calls no model', async () => {
    for (let i = 0; i < 20; i++) {
      h.caller = i % 2 ? 'child' : 'parent';
      expect((await POST()).status).toBe(200);
    }
    expect(db.table('ai_requests')).toHaveLength(20);
    expect(db.table('ai_requests').every((r) => r.kind === 'feature' && r.feature === 'relationship.digest' && r.status === 'completed')).toBe(true);

    h.caller = 'parent';
    const res = await POST();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'relationship.suggestionDailyLimitReached' });
    expect(h.complete).toHaveBeenCalledTimes(20);
  });

  it('control: a call that produced no digest is not counted, as it never was', async () => {
    h.complete.mockResolvedValue({ text: '{}', model: 'test-model' });
    for (let i = 0; i < 20; i++) expect((await POST()).status).toBe(502);
    expect(db.table('ai_requests').filter((r) => r.status === 'failed')).toHaveLength(20);

    h.complete.mockResolvedValue({ text: DIGEST, model: 'test-model' });
    expect((await POST()).status).toBe(200);
  });
});
