import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// H1 — the AI meal planner's write path skipped the guest refusal the manual
// meal-plan actions enforce (planMealAction and removeMealPlanAction refuse a
// guest: tests/meal-guest-placement-actions.test.ts). An invited grandparent —
// view-only per lib/constants/roles.ts — could open /dashboard/meals, run the
// AI planner (it always sends write:true) and replace a week of the family's
// dinners whenever every pick was an existing dish, charged to the family's AI
// allowance. meal_plans has no guest trigger (0464 covers `meals`), so nothing
// below the route refused it.

const mocks = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), complete: vi.fn(), limit: vi.fn(), gate: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: mocks.complete }),
  describeAIError: () => ({ message: 'Generation unavailable' }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.limit }));
// The Free plan's AI allowance (N18) has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts, and F19's in
// every-ai-route-counts-against-the-allowance; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  refuseOverAIAllowance: async () => null,
  withinAIAllowance: async () => true,
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: mocks.gate }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_scope: unknown, _feature: unknown, run: (observer: { used: () => void }) => Promise<string>) => run({ used: vi.fn() }),
}));

import { POST } from '@/app/api/ai/meals/plan/route';

const FAMILY = 'family-one';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const request = (write: boolean) => new Request('https://fixture.invalid/api/ai/meals/plan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ weekStart: '2026-09-14', mealTypes: ['dinner'], useExpiring: false, write }),
});
const as = (role: string) => mocks.context.mockResolvedValue({ user: { id: 'user-one' }, active: {
  familyId: FAMILY, role, member: { id: 'member-one' }, family: { timezone: 'UTC' },
} });

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    meals: { ingredients: [], recipe_url: null, image_url: null, meal_type: 'dinner' },
    meal_plans: { idempotency_key: null },
  } });
  db.seed('meals', [{ id: 'soup', family_id: FAMILY, name: 'Soup' }, { id: 'pasta', family_id: FAMILY, name: 'Pasta' }]);
  db.seed('meal_plans', [{ id: 'monday-dinner', family_id: FAMILY, meal_id: 'pasta', plan_date: '2026-09-14', meal_type: 'dinner', created_by: 'user-two' }]);
  mocks.server.mockResolvedValue(db);
  mocks.limit.mockResolvedValue({ ok: true });
  mocks.gate.mockResolvedValue(null);
  // Every pick is an existing dish — the case the meals trigger never sees.
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ assignments: [{ date: '2026-09-14', meal_type: 'dinner', ref: 'meal:soup', name: 'Soup' }] }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a guest cannot replan the family\'s week with the AI planner', () => {
  it('refuses a guest\'s write before the model is asked or the allowance is spent', async () => {
    as('guest');
    const before = structuredClone(db.table('meal_plans'));

    const response = await POST(request(true));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Your account can’t make that change.' });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(db.table('meal_plans')).toEqual(before);
  });

  it('still lets a guest preview a plan, which writes nothing', async () => {
    as('guest');
    const before = structuredClone(db.table('meal_plans'));

    const response = await POST(request(false));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ written: false });
    expect(db.table('meal_plans')).toEqual(before);
  });

  it('a parent\'s write still replaces the slot (the control)', async () => {
    as('parent');

    const response = await POST(request(true));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ written: true, count: 1 });
    expect(db.table('meal_plans').map((row) => row.meal_id)).toEqual(['soup']);
  });
});
