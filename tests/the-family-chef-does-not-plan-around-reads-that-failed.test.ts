import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';

// H17 — the AI Family Chef (/api/ai/chef) read recipes, the pantry, the week's
// calendar and leftovers, used only `.data ?? []`, and answered 200. A failed
// pantry read was "nothing expiring", a failed calendar read "no busy nights",
// and the chef planned a long braise for the night of the away game.
// /api/ai/meals/plan already failed closed on exactly this.
//
// Separately, a provider error or an unreadable reply ended at
// `source: 'fallback'` — the same value as "no AI configured" — so the kitchen
// screen told a family whose AI was configured to "Connect a provider".

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, configured: true, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => h.configured, resolveProvider: async () => ({ complete: h.complete }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The plan gate is covered by the kitchen feature's own tests.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); this one is the failed-read boundary.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/server/ai-access')>()), refuseOverAIAllowance: async () => null, withinAIAllowance: async () => true }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/chef/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: (table: string, calls: FaultCall[]) => { code?: string; message: string } | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-14T09:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = () => null;
  h.db = withFaults(base, (table, calls) => failing(table, calls));
  h.configured = true;
  h.complete.mockReset().mockResolvedValue({ text: JSON.stringify({ message: 'Planned.', meals: [{ day: 'Mon', mealType: 'dinner', dish: 'Soup' }], groceryAdds: [], tips: [] }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_recipes', [{ id: 'r1', family_id: FAMILY, name: 'Stew', is_favorite: true }]);
  base.seed('pantry_items', [{ id: 'p1', family_id: FAMILY, name: 'Spinach', expires_at: '2026-09-15' }]);
  base.seed('calendar_events', [{ id: 'game', family_id: FAMILY, title: 'Away game', starts_at: '2026-09-15T18:00:00.000Z', ends_at: '2026-09-15T21:00:00.000Z', all_day: false, category: 'general', recurrence: 'none', recurrence_until: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = () => POST(new Request('https://fixture.invalid/api/ai/chef', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'Plan dinners this week' }),
}));

describe('the family chef does not plan around a read that failed', () => {
  it.each(['family_recipes', 'pantry_items', 'calendar_events'])('a failed %s read is a 503, and the model is not asked', async (table) => {
    failing = (name) => (name === table ? { message: 'Fixture read refused' } : null);

    const response = await ask();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'chef.kitchenDataIsTemporarilyUnavailable' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('a leftovers read that fails for any reason but a missing table is a 503 too', async () => {
    failing = (name) => (name === 'leftover_inventory' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);
    expect((await ask()).status).toBe(503);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('a leftovers table that is not migrated yet is a genuine absence, and the chef answers', async () => {
    failing = (name) => (name === 'leftover_inventory' ? { code: '42P01', message: 'relation "public.leftover_inventory" does not exist' } : null);

    const response = await ask();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'ai', context: { busyNights: ['Tue: Away game'], expiringItems: ['Spinach'], recipeCount: 1 } });
  });
});

describe('a provider that failed is not reported as one that is not configured', () => {
  it('a thrown provider error answers source "unavailable", with the plan built from the kitchen', async () => {
    h.complete.mockRejectedValue(new Error('upstream 500'));

    const body = await (await ask()).json();

    expect(body.source).toBe('unavailable');
    expect(body.reply.meals.length).toBeGreaterThan(0);
    expect(body.reply.message).not.toMatch(/Connect an AI provider/);
  });

  it('a reply the chef cannot read answers "unavailable" too', async () => {
    h.complete.mockResolvedValue({ text: 'I would love to help, but here is some prose.' });
    expect((await (await ask()).json()).source).toBe('unavailable');
  });

  it('only a deployment with no AI says "fallback" — and that is when the screen says "not configured"', async () => {
    h.configured = false;

    const body = await (await ask()).json();

    expect(body.source).toBe('fallback');
    expect(h.complete).not.toHaveBeenCalled();
    const screen = readFileSync('components/modules/kitchen-dashboard.tsx', 'utf8');
    expect(screen).toMatch(/source === 'fallback' && \(\s*<p[^>]*>\s*\{i18nT\('kitchenDashboard\.aiIsntConfiguredShowingAPlan'\)\}/);
    expect(screen).toMatch(/source === 'unavailable' && \(\s*<p[^>]*>\s*\{i18nT\('kitchenDashboard\.aiChefUnavailableShowingAPlan'\)\}/);
  });
});
