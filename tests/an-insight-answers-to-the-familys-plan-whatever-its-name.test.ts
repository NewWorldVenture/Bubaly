// An AI insight answers to the family's plan whatever kind it is asked for.
//
// `/api/ai/insights` gated a kind only when INSIGHT_FEATURE_HREFS listed it.
// `grocery` is an alias of `shopping` — it reads the same open grocery items —
// but no page renders it, so it was absent from the derived map: a family
// whose Groceries feature an admin switched Off, or whose trial ended unpaid,
// or whose account is closed, was refused `shopping` and answered `grocery` by
// the model. And no kind the map leaves out (calendar, todos, notes…) ever met
// the family's lock at all.
//
// The real route and the real gate (route-feature-gate → feature-entitlement)
// are driven; only the plan read and the tier table under them are fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({
  db: null as unknown,
  entitlement: { effectiveLevel: 2, locked: false, closed: false, inTrial: false, trialEndsAt: null } as Record<string, unknown>,
  tiers: {} as Record<string, string>,
  complete: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/server/plan', async (original) => ({
  ...(await original<typeof import('@/lib/server/plan')>()),
  resolveFamilyEntitlement: async () => h.entitlement,
}));
// By href for the route's own gate; by key (none overridden) for the AI
// allowance gate (`assertAIAccess`), which every kind now also answers to.
vi.mock('@/lib/server/feature-tiers', () => ({ getFeatureTiersByHref: async () => h.tiers, getResolvedFeatureTiers: async () => ({}) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
  describeAIError: () => ({ message: 'unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

beforeEach(() => {
  const db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: { grocery_lists: { is_archived: false, archived_at: null } } });
  db.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Dana', role: 'parent', is_active: true }]);
  db.seed('grocery_lists', [{ id: 'list-1', family_id: FAMILY, name: 'Groceries' }]);
  db.seed('grocery_items', [{ id: 'i-1', family_id: FAMILY, list_id: 'list-1', name: 'Milk', is_checked: false }]);
  h.db = db;
  h.entitlement = { effectiveLevel: 2, locked: false, closed: false, inTrial: false, trialEndsAt: null };
  h.tiers = { '/dashboard/grocery': 'free' };
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded answer.', model: 'fixture-model' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));

describe('the grocery alias answers to the Groceries feature', () => {
  it.each(['shopping', 'grocery'])('%s is refused when an admin switched Groceries off, before the model', async (kind) => {
    h.tiers = { '/dashboard/grocery': 'off' };

    const response = await ask(kind);

    expect(response.status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('and answers when Groceries is on', async () => {
    expect((await ask('grocery')).status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe('every kind answers to the family\'s lock', () => {
  it.each([
    ['grocery', 'trial_expired', { locked: true }],
    ['calendar', 'trial_expired', { locked: true }],
    ['todos', 'account_closed', { closed: true }],
  ])('%s is refused for a %s family before the model', async (kind, code, state) => {
    h.entitlement = { ...h.entitlement, effectiveLevel: 0, ...state };

    const response = await ask(kind);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('an unlocked family is answered for a kind no gated page renders', async () => {
    expect((await ask('calendar')).status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
