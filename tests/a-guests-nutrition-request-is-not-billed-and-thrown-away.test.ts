// N10 / N11 — a guest reaches the meal planner (meals stay open to a guest,
// lib/auth/guest-scope.ts) and its Nutrition Overview's "Analyze week". On a
// cache miss, or any Re-analyze, the route passed the allowance, asked the
// model inside withAiRequest (a metered ai_requests row), and only then
// upserted the estimate on the guest's own session, which 0481's
// meal_nutrition insert and update policies refuse a guest. The route answered
// 500 "Could not save the nutrition details.", the estimate was thrown away,
// and every retry billed another call. A guest is now answered before anything
// is spent; a saved estimate is still served to them, as before.
//
// Driven through the real route, the real allowance and the real request
// recorder, over the in-memory database; the guest's refused upsert is
// answered the way RLS answers it (42501).
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000f2801';
const GUEST_USER = '00000000-0000-4000-8000-0000000f2811';
const PARENT_USER = '00000000-0000-4000-8000-0000000f2812';
const WEEK = '2026-10-12';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), caller: null as unknown }));
const as = (role: 'guest' | 'parent') => ({
  user: { id: role === 'guest' ? GUEST_USER : PARENT_USER, email: `${role}@example.test` },
  memberships: [],
  active: { familyId: FAMILY, role, member: { id: `m-${role}`, display_name: role }, family: { id: FAMILY, name: 'The Okafors', timezone: 'UTC' } },
});
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => h.caller,
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));

const { POST: nutrition } = await import('@/app/api/ai/meals/nutrition/route');

let db: InMemorySupabase;
const post = (body: unknown) => nutrition(new NextRequest('http://localhost/api/ai/meals/nutrition', { method: 'POST', body: JSON.stringify(body) }));
const ESTIMATE = '{"calories":1850,"protein_g":80,"carbs_g":220,"fat_g":60,"fiber_g":30,"sugar_g":40,"sodium_mg":2100,"summary":"Balanced week."}';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T15:00:00Z'));
  const memory = createInMemorySupabase({ rpc: { count_family_ai_requests_month: () => 0 } });
  db = memory;
  // 0481: meal_nutrition_insert / _update need a non-guest member.
  h.db = withFaults(memory, (table, calls) => (table === 'meal_nutrition' && calls.some((c) => c.method === 'upsert')
    && (h.caller as ReturnType<typeof as>).active.role === 'guest'
    ? { code: '42501', message: 'new row violates row-level security policy for table "meal_nutrition"' } : null));
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: ESTIMATE, model: 'gpt-test', usage: { input_tokens: 10, output_tokens: 10 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Okafors', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-guest', family_id: FAMILY, user_id: GUEST_USER, role: 'guest', is_active: true, display_name: 'Grandma' },
    { id: 'm-parent', family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true, display_name: 'Ada' },
  ]);
  db.seed('meals', [{ id: 'meal-1', family_id: FAMILY, name: 'Lentil soup', meal_type: 'dinner', ingredients: [], notes: null }]);
  db.seed('meal_plans', [{ id: 'plan-1', family_id: FAMILY, plan_date: '2026-10-13', meal_type: 'dinner', meal_id: 'meal-1' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a guest asking for the week\'s nutrition', () => {
  it.each([false, true])('is answered 403 before any model call or metered request (refresh: %s)', async (refresh) => {
    h.caller = as('guest');

    const res = await post({ subjectType: 'week', subjectId: WEEK, refresh });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'nutrition.aGuestSeesSavedEstimatesOnly' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(0);
  });

  it('is still served the estimate a family member saved', async () => {
    h.caller = as('guest');
    db.seed('meal_nutrition', [{ id: 'n-1', family_id: FAMILY, subject_type: 'week', subject_id: WEEK, calories: 1700, summary: 'Saved.' }]);

    const res = await post({ subjectType: 'week', subjectId: WEEK });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cached: true, nutrition: { calories: 1700 } });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('control: a parent', () => {
  it('gets a computed estimate, saved for the family', async () => {
    h.caller = as('parent');

    const res = await post({ subjectType: 'week', subjectId: WEEK });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cached: false, nutrition: { calories: 1850 } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(db.table('meal_nutrition')).toEqual([expect.objectContaining({ subject_type: 'week', subject_id: WEEK, calories: 1850 })]);
  });
});
