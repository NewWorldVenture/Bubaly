import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

// POST /api/ai/insights, the REAL route and its REAL plan gate
// (refuseUnlessEntitled), with the family's plan and the model scripted.
//
//   S5   'home' was missing from INSIGHT_FEATURE_HREFS — /dashboard/home gates
//        in its LAYOUT, which the map's derivation never read — so a Free
//        family could POST {"kind":"home"} for a Plus feature's paid answer
//   S15  'home', 'weather' and 'chores' built the prompt from reads whose
//        errors were dropped: a failed read reached the model as "none" and
//        came back as a confident answer at 200

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), entitled: new Set<string>() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));
// The family's plan: entitled to exactly the hrefs in `h.entitled`.
vi.mock('@/lib/server/feature-entitlement', () => ({
  resolveFeatureEntitlement: async (_db: unknown, _family: string, href: string) => (h.entitled.has(href)
    ? { allowed: true, planLevel: 2 }
    : { allowed: false, reason: 'plan', needLevel: 2, planLevel: 0 }),
}));

const { POST } = await import('@/app/api/ai/insights/route');

let failing: string | null;

beforeEach(() => {
  const base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  h.entitled = new Set(['/dashboard/home']);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
  base.seed('home_assets', [{ id: 'asset-1', family_id: FAMILY, name: 'Furnace', category: 'hvac', last_serviced_on: '2025-10-01' }]);
  base.seed('maintenance_tasks', [{ id: 'task-1', family_id: FAMILY, title: 'Replace the furnace filter', status: 'todo', due_at: '2026-10-01T00:00:00Z' }]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));

describe('S5 — the home insight answers to the home page\'s plan', () => {
  it('refuses a family whose plan does not include Home, and asks no model', async () => {
    h.entitled = new Set();

    const res = await ask('home');

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('plan_required');
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('answers a family whose plan does', async () => {
    const res = await ask('home');

    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe('S15 — an insight is not built on a read that failed', () => {
  it.each([
    ['home', 'home_assets'], ['home', 'maintenance_tasks'],
    ['weather', 'weather_locations'],
    ['chores', 'chores'], ['chores', 'chore_assignments'],
  ])('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const res = await ask(kind);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['home', 'weather', 'chores'])('%s still answers when every read succeeds', async (kind) => {
    const res = await ask(kind);
    expect(res.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
