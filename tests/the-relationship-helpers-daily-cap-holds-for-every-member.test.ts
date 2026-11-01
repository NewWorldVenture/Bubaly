// N7 — the Relationship Helper's 20-a-day family cap never applied to a teen,
// a child, a caregiver or a guest.
//
// The meter counts `audit_logs` rows, and it counted them through the caller's
// own client. `audit_logs` SELECT is managers-only (0118's `audit_select`), so
// for anyone else RLS returned a count of 0 with no error: the cap never
// tripped, every call was a paid model call (limited only to 10 a minute), and
// each one still inserted a row the parents' own count kept rising on.
//
// The count is now read with the service client, scoped to the family and the
// action. Driven through the real route over the in-memory database, with the
// member's own client hiding `audit_logs` the way RLS does.
//
// Since household-roles round 6 the meter's rows are the `ai_requests` rows the
// route files for each digest (kind 'feature', feature 'relationship.digest',
// settled 'completed'), not member-writable audit rows: see
// tests/the-relationship-helpers-cap-counts-only-the-servers-records.test.ts.
// The member's own client hides those from a non-manager here too (the held
// 0493 lets one read only their own), so the count still has to be the
// service client's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, ownClient: null as unknown, role: 'teen', complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${h.role}` },
    active: { familyId: FAMILY, role: h.role, member: { id: `member-${h.role}`, display_name: 'Sam' }, family: { timezone: 'UTC', name: 'Family A' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.ownClient, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseIfLocked: async () => null }));
vi.mock('@/lib/server/account-standing', () => ({ refuseClosedOrTrialEnded: async () => null }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }),
}));

const { POST } = await import('@/app/api/ai/relationship/route');

const FAMILY = '00000000-0000-4000-8000-0000000a7701';
const NOW = new Date('2026-10-14T15:00:00Z');

let db: InMemorySupabase;

/** The member's own client: `audit_logs` reads only for a manager (0118), and other members' `ai_requests` will (held 0493). */
function ownClientFor(role: string): SupabaseClient<Database> {
  const hidden = createInMemorySupabase();
  const manager = role === 'parent' || role === 'adult';
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'from') return Reflect.get(target, key, receiver);
      return (table: string) => ((table === 'audit_logs' || table === 'ai_requests') && !manager ? hidden.from(table) : target.from(table));
    },
  }) as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase();
  h.db = db;
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: JSON.stringify({ headline: 'A date night idea', prompts: [], giftIdeas: [] }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'Family A', timezone: 'UTC' }]);
  // Family Basic, so the Free plan's monthly allowance (its own tests) does not
  // refuse the control below over this month's twenty requests.
  db.seed('subscriptions', [{ id: 'sub-a', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('relationship_profile', [{ id: 'profile-1', family_id: FAMILY, partner_name: 'Bea', partner_member_id: null, interests: [], love_languages: [], gift_budget_cents: null }]);
  // Twenty digests already generated today — by the parents and anyone else:
  // the request row the route filed for each.
  db.seed('ai_requests', Array.from({ length: 20 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000a78${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: `user-${i % 2 ? 'parent' : 'teen'}`,
    kind: 'feature', feature: 'relationship.digest', status: 'completed', created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
  })));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Relationship Helper’s daily cap', () => {
  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses a %s once the family has used today’s twenty, and calls no model', async (role) => {
    h.role = role;
    h.ownClient = ownClientFor(role);

    const res = await POST();

    expect(res.status).toBe(429);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('control: refuses a parent the same way', async () => {
    h.role = 'parent';
    h.ownClient = ownClientFor('parent');

    const res = await POST();

    expect(res.status).toBe(429);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('control: counts only this family’s digests from today', async () => {
    h.role = 'teen';
    h.ownClient = ownClientFor('teen');
    // Yesterday's, and another family's, do not count.
    for (const row of db.table('ai_requests').slice(0, 10)) row.created_at = '2026-10-13T12:00:00.000Z';
    for (const row of db.table('ai_requests').slice(10, 11)) row.family_id = '00000000-0000-4000-8000-0000000a7702';

    const res = await POST();

    expect(res.status).not.toBe(429);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
