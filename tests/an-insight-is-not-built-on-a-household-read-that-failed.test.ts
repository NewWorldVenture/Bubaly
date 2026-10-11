import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

// H16 — AI Assist (/api/ai/insights) dropped read errors for thirteen household
// kinds. supabase-js resolves every failure, PostgREST or transport, as
// `{ data: null, error }` rather than throwing, so `x.data ?? []` turned a
// refused inventory read into "Nothing catalogued yet." and a failed `moves`
// read into "No move planned yet." — answered at HTTP 200 and shown by the
// module's AI Assist button as a grounded answer about an empty household.
// For moving, projects, career and language a failed PARENT read emptied
// everything. The route already had `required()` for exactly this; only
// purchase_advisor called it.
//
// And the recipes kind could never read the pantry: it filtered on
// `pantry_items.is_out_of_stock`, a column no migration created, so PostgREST
// refused that read on every call and the prompt always said "Pantry items:
// none tracked."

const FAMILY = 'family-one';
const PANTRY_COLUMNS = new Set(['id', 'family_id', 'name', 'category', 'location', 'quantity', 'unit', 'low_threshold', 'expires_at', 'barcode', 'is_staple', 'notes', 'created_by', 'created_at', 'updated_at']);
const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike', 'contains', 'order']);

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The per-kind plan gate is covered by tests/insight-kinds-are-gated-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

/** PostgREST refuses a filter on a column the table does not have (42703). */
function schemaFault(table: string, calls: FaultCall[]) {
  if (table !== 'pantry_items') return null;
  const unknown = calls.find((call) => FILTERS.has(call.method) && typeof call.args[0] === 'string' && !PANTRY_COLUMNS.has(call.args[0] as string));
  return unknown ? { code: '42703', message: `column pantry_items.${String(unknown.args[0])} does not exist` } : null;
}

beforeEach(() => {
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table, calls) => (table === failing ? { message: 'Fixture read refused' } : schemaFault(table, calls)));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
  // A live parent row for each kind that reads children through one.
  base.seed('moves', [{ id: 'move-1', family_id: FAMILY, title: 'To Portland', status: 'planning', move_date: '2026-11-20' }]);
  base.seed('home_projects', [{ id: 'project-1', family_id: FAMILY, title: 'Fence', status: 'planning', priority: 'medium' }]);
  base.seed('career_profiles', [{ id: 'profile-1', family_id: FAMILY, title: 'Search', is_active: true }]);
  base.seed('language_goals', [{ id: 'goal-1', family_id: FAMILY, language_label: 'Spanish', is_active: true }]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));

const READS: [string, string][] = [
  ['closet', 'wardrobe_items'], ['closet', 'outfit_logs'],
  ['watchlist', 'watchlist_titles'], ['watchlist', 'watchlist_votes'], ['watchlist', 'watch_sessions'],
  ['inventory', 'home_locations'], ['inventory', 'inventory_items'], ['inventory', 'inventory_moves'],
  ['sleep', 'sleep_logs'], ['sleep', 'bedtime_routines'], ['sleep', 'sleep_checkins'],
  ['declutter', 'declutter_zones'], ['declutter', 'declutter_missions'], ['declutter', 'declutter_sessions'],
  ['moving', 'moves'], ['moving', 'move_tasks'], ['moving', 'move_boxes'],
  ['projects', 'home_projects'], ['projects', 'project_materials'], ['projects', 'project_quotes'],
  ['career', 'career_profiles'], ['career', 'job_applications'], ['career', 'resume_versions'],
  ['language', 'language_goals'], ['language', 'language_sessions'], ['language', 'vocab_cards'],
  ['grocery', 'grocery_items'], ['shopping', 'grocery_items'],
  ['meals', 'meal_plans'], ['meals', 'meals'],
  ['recipes', 'family_recipes'], ['recipes', 'pantry_items'],
  ['pantry', 'pantry_items'],
];

describe('an insight is not built on a household read that failed', () => {
  it.each(READS)('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each([...new Set(READS.map(([kind]) => kind))])('%s still answers when every read succeeds', async (kind) => {
    const response = await ask(kind);
    expect(response.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('the recipes insight is told what is actually in the pantry', async () => {
    base.seed('pantry_items', [
      { id: 'p1', family_id: FAMILY, name: 'Spinach', quantity: 2, location: 'fridge', is_staple: false },
      { id: 'p2', family_id: FAMILY, name: 'Used-up rice', quantity: 0, location: 'pantry', is_staple: true },
    ]);

    const response = await ask('recipes');

    expect(response.status).toBe(200);
    const prompt = (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;
    expect(prompt).toContain('Pantry items: Spinach.');
    expect(prompt).not.toContain('Used-up rice');
    expect(prompt).not.toContain('none tracked');
  });
});
