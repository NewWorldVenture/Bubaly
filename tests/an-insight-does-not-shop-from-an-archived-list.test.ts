// AI Assist on the shopping and grocery pages does not shop from an archived list.
//
// The follow-up to tests/an-archived-shopping-list-is-not-counted.test.ts.
// Archiving a list takes it off the shopping page, but /api/ai/insights read
// every unchecked `grocery_items` row in the family for its `grocery` and
// `shopping` kinds. So "AI organize & suggest" grouped last month's party shop
// into this week's aisles, and "Items to buy" told the family to buy it. The
// read went through the route's `eq(sb, table, familyId)` helper, so the source
// guard in that test, which only matched `from('grocery_items')`, never saw it.
//
// The route now reads only lists the family has not archived
// (`readOnOpenGroceryLists`, lib/services/groceries), and a failed list read
// fails the insight like any other required read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';

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

beforeEach(() => {
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Ada', is_active: true }]);
  base.seed('grocery_lists', [
    { id: 'l-open', family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null },
    { id: 'l-archived', family_id: FAMILY, name: 'Party shop', is_archived: false, archived_at: '2026-09-01T10:00:00Z' },
    { id: 'l-legacy', family_id: FAMILY, name: 'Old list', is_archived: true, archived_at: null },
  ]);
  base.seed('grocery_items', [
    { id: 'g-milk', family_id: FAMILY, list_id: 'l-open', name: 'Milk', is_checked: false },
    { id: 'g-balloons', family_id: FAMILY, list_id: 'l-archived', name: 'Balloons', is_checked: false },
    { id: 'g-candles', family_id: FAMILY, list_id: 'l-legacy', name: 'Candles', is_checked: false },
    { id: 'g-bread', family_id: FAMILY, list_id: 'l-open', name: 'Bread', is_checked: true },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('AI Assist does not shop from an archived list', () => {
  it.each(['grocery', 'shopping'])('the %s insight is told only what is still needed on an open list', async (kind) => {
    const response = await ask(kind);

    expect(response.status).toBe(200);
    expect(prompt()).toContain('- Milk');
    expect(prompt()).not.toContain('Balloons');
    expect(prompt()).not.toContain('Candles');
    expect(prompt()).not.toContain('Bread');
  });

  it.each(['grocery', 'shopping'])('a failed list read fails the %s insight instead of reading as an empty list', async (kind) => {
    failing = 'grocery_lists';

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });
});
