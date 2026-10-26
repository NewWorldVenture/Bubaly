// The AI Family Chef plans from what this family can actually eat.
//
// S3 — its only caller (the Kitchen page's "Ask the chef") sends `{ request }`,
//   and the route built the dietary rules from `body.dietary` alone, so a
//   household with a peanut allergy on its medical profile was planned a week
//   — and grocery adds — with no allergy in the prompt and nothing checking
//   the answer.
// S5 — pantry items already past their date, and fresh-status leftovers past
//   their use-by, were handed over as "expiring soon (use these)" and "use
//   first", sorted ahead of the food that really is about to turn; the
//   deterministic plan built "Something with chicken breast" on them.
// S17 — the calendar read was capped at the week's first 40 occurrences of any
//   hour before the evening filter ran, and "expiring" was computed from an
//   unordered 200-row pantry sample; both dropped real context at HTTP 200.
//
// Driven through the real route against an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, configured: true, complete: vi.fn(), zone: 'America/Los_Angeles' }));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  refuseOverAIAllowance: async () => null,
  withinAIAllowance: async () => true,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: h.zone, name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => h.configured, resolveProvider: async () => ({ complete: h.complete }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The plan gate is covered by the kitchen feature's own tests.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/chef/route';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const rpc: Record<string, (args: Record<string, unknown>) => unknown> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Tuesday 13 October, 9am in California.
  vi.setSystemTime(new Date('2026-10-13T16:00:00Z'));
  for (const key of Object.keys(rpc)) delete rpc[key];
  db = createInMemorySupabase<SupabaseClient<Database>>({ rpc: rpc as never });
  h.db = db;
  h.configured = true;
  h.zone = 'America/Los_Angeles';
  h.complete.mockReset().mockResolvedValue({ text: JSON.stringify({ message: 'Planned.', meals: [{ day: 'Wed', mealType: 'dinner', dish: 'Soup' }], groceryAdds: [], tips: [] }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Dana', role: 'parent', is_active: true, user_id: 'user-one', created_at: '2026-01-01T00:00:00Z' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ask = () => POST(new Request('https://fixture.invalid/api/ai/chef', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: 'Plan dinners this week' }),
}));
const prompt = () => String(h.complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '');
/** The fenced block that follows a heading in the prompt, or '' when the heading is absent. */
const section = (heading: string) => {
  const at = prompt().indexOf(heading);
  if (at < 0) return '';
  const rest = prompt().slice(at);
  return rest.slice(0, rest.indexOf('<<<END_') < 0 ? undefined : rest.indexOf('<<<END_'));
};

describe('S3: the chef reads and holds to the household\'s recorded allergies', () => {
  beforeEach(() => {
    db.seed('medical_profiles', [{ id: 'mp-1', family_id: FAMILY, member_id: 'member-one', allergies: 'Severe peanut allergy (EpiPen)' }]);
  });

  it('puts the allergy in the prompt although the dialog sent only the request', async () => {
    await ask();

    expect(section('Recorded household allergies')).toMatch(/severe peanut allergy/i);
  });

  it('leaves out a dish and swaps a grocery add that the model let the allergen into', async () => {
    h.complete.mockResolvedValue({ text: JSON.stringify({
      message: 'Here is your week.',
      meals: [
        { day: 'Wed', mealType: 'dinner', dish: 'Peanut noodles' },
        { day: 'Thu', mealType: 'dinner', dish: 'Chicken soup' },
      ],
      groceryAdds: ['peanut butter', 'rice'],
      tips: [],
    }) });

    const body = await (await ask()).json();

    expect(body.source).toBe('ai');
    expect(body.reply.meals.map((m: { dish: string }) => m.dish)).toEqual(['Chicken soup']);
    expect(body.reply.groceryAdds).toEqual(['sunflower seed butter', 'rice']);
    expect(body.reply.tips).toContain('chef.someSuggestionsLeftOutForAllergies');
  });

  it('screens the plan built without a model too: a saved recipe can carry the allergen', async () => {
    h.configured = false;
    db.seed('family_recipes', [
      { id: 'r1', family_id: FAMILY, name: 'Peanut satay', is_favorite: true },
      { id: 'r2', family_id: FAMILY, name: 'Lentil stew', is_favorite: false },
    ]);

    const body = await (await ask()).json();

    expect(body.source).toBe('fallback');
    expect(body.reply.meals.map((m: { dish: string }) => m.dish)).toEqual(['Lentil stew']);
  });

  it('fails closed when the allergies cannot be read', async () => {
    rpc.family_allergies = () => { throw new Error('Fixture allergy read refused'); };

    const response = await ask();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'chef.kitchenDataIsTemporarilyUnavailable' });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('S5: food past its date is not offered as something to cook', () => {
  beforeEach(() => {
    db.seed('pantry_items', [
      { id: 'p-old', family_id: FAMILY, name: 'chicken breast', expires_at: '2026-10-01' },
      { id: 'p-new', family_id: FAMILY, name: 'spinach', expires_at: '2026-10-15' },
    ]);
    db.seed('leftover_inventory', [
      { id: 'l-old', family_id: FAMILY, name: 'Lasagna', source_meal: 'Lasagna', use_by: '2026-10-08', status: 'fresh' },
      { id: 'l-new', family_id: FAMILY, name: 'Soup', source_meal: 'Soup', use_by: '2026-10-14', status: 'fresh' },
    ]);
  });

  it('hands the model only still-good expiring items and leftovers', async () => {
    const body = await (await ask()).json();

    expect(body.context.expiringItems).toEqual(['spinach']);
    expect(body.context.leftovers).toEqual(['Soup']);
    expect(section('Leftovers to use first:')).toContain('Soup');
    expect(section('Leftovers to use first:')).not.toContain('Lasagna');
    expect(section('Pantry items expiring soon (use these):')).toContain('spinach');
    expect(section('Pantry items expiring soon (use these):')).not.toContain('chicken breast');
  });

  it('the plan built without a model is not built on them either', async () => {
    h.configured = false;

    const body = await (await ask()).json();

    const dishes = body.reply.meals.map((m: { dish: string }) => m.dish);
    expect(dishes).toEqual(['Leftover Soup', 'Something with spinach']);
    expect(body.reply.tips).not.toContain('Use chicken breast soon so it doesn\'t go to waste.');
  });
});

describe('S17: the week the chef plans around is the whole week', () => {
  it('an evening late in the week is still a busy night when the week holds more than 40 events', async () => {
    // Forty-five daytime commitments on Wednesday, then Saturday's 6pm practice.
    db.seed('calendar_events', Array.from({ length: 45 }, (_, i) => ({
      id: `day-${String(i).padStart(2, '0')}`, family_id: FAMILY, title: `Standup ${i}`,
      starts_at: new Date(Date.parse('2026-10-14T16:00:00Z') + i * 60_000).toISOString(),
      ends_at: new Date(Date.parse('2026-10-14T16:30:00Z') + i * 60_000).toISOString(),
      all_day: false, category: 'general', recurrence: 'none', recurrence_until: null,
    })));
    db.seed('calendar_events', [{
      id: 'practice', family_id: FAMILY, title: 'Soccer practice', starts_at: '2026-10-18T01:00:00.000Z', ends_at: '2026-10-18T02:30:00.000Z',
      all_day: false, category: 'sports', recurrence: 'none', recurrence_until: null,
    }]);

    const body = await (await ask()).json();

    expect(body.context.busyNights).toEqual(['Sat: Soccer practice']);
  });

  it('an all-day event is not an evening commitment', async () => {
    db.seed('calendar_events', [{
      id: 'holiday', family_id: FAMILY, title: 'School holiday', starts_at: '2026-10-15T00:00:00.000Z', ends_at: '2026-10-16T00:00:00.000Z',
      all_day: true, category: 'school', recurrence: 'none', recurrence_until: null,
    }]);

    const body = await (await ask()).json();

    expect(body.context.busyNights).toEqual([]);
  });

  it('what expires this week is found however many pantry rows the family has', async () => {
    db.seed('pantry_items', Array.from({ length: 250 }, (_, i) => ({ id: `p-${String(i).padStart(3, '0')}`, family_id: FAMILY, name: `Tin ${i}`, expires_at: null })));
    db.seed('pantry_items', [{ id: 'p-zz', family_id: FAMILY, name: 'yogurt', expires_at: '2026-10-16' }]);

    const body = await (await ask()).json();

    expect(body.context.expiringItems).toEqual(['yogurt']);
  });
});
