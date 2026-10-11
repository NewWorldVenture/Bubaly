import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  db: null as unknown,
  zone: 'America/Los_Angeles' as unknown,
  advanceAtRateLimit: null as string | null,
  writes: [] as { table: string; body: Record<string, unknown> }[],
  forbidden: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'synthetic-user' }, active: { familyId: 'synthetic-family', family: { timezone: h.zone } } }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => { h.forbidden(); throw Error('Service/provider path forbidden'); },
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => {
  if (h.advanceAtRateLimit) vi.setSystemTime(new Date(h.advanceAtRateLimit));
  return { ok: true };
} }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: h.forbidden }));
vi.mock('@/lib/services/groceries', () => ({ ensureDefaultGroceryListId: h.forbidden }));
// The route's Smart Kitchen gate and AI allowance are covered by
// tests/fridge-chef-is-a-kitchen-feature.test.ts; this file is about the date.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: h.forbidden, accessDeniedResponse: h.forbidden }));
import { POST } from '@/app/api/ai/pantry-chef/route';

beforeEach(() => {
  h.writes = []; h.forbidden.mockClear(); h.zone = 'America/Los_Angeles'; h.advanceAtRateLimit = null;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T02:30:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('External network forbidden'); }));
  h.db = createClient('https://synthetic-pantry-date.invalid', 'synthetic-not-secret', {
    accessToken: async () => null,
    global: { fetch: async (input, init) => {
      const u = new URL(String(input));
      expect(u.origin).toBe('https://synthetic-pantry-date.invalid');
      expect(init?.method).toBe('POST');
      const table = u.pathname.split('/').pop()!;
      expect(['meals', 'meal_plans']).toContain(table);
      const body = JSON.parse(String(init?.body));
      expect(body.family_id).toBe('synthetic-family'); expect(body.created_by).toBe('synthetic-user');
      h.writes.push({ table, body });
      return Response.json(table === 'meals' ? { id: 'synthetic-dish' } : null);
    } },
  });
});
afterEach(() => {
  expect(h.forbidden).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function request(planDate?: unknown, title = 'Synthetic supper') {
  return new NextRequest('https://synthetic.invalid/api/ai/pantry-chef', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // This matches FridgeChef's actual default action: it omits planDate.
    body: JSON.stringify({ addToPlan: { title, have: ['Synthetic beans'], need: [], ...(planDate === undefined ? {} : { planDate }) } }),
  });
}
async function assertPlanned(expected: string, planDate?: unknown) {
  const response = await POST(request(planDate));
  expect(response.status).toBe(200);
  expect(h.writes.map(write => write.table)).toEqual(['meals', 'meal_plans']);
  expect(h.writes[0].body.name).toBe('Synthetic supper');
  expect(h.writes[1].body).toMatchObject({ meal_id: 'synthetic-dish', meal_type: 'dinner', plan_date: expected });
  expect(await response.json()).toEqual({ planned: true, planDate: expected });
}

describe('actual pantry route and SDK save the household dinner day', () => {
  it.each([
    ['America/Los_Angeles', '2026-10-09T02:30:00Z', '2026-10-08'],
    ['Pacific/Kiritimati', '2026-10-08T12:30:00Z', '2026-10-09'],
    ['UTC', '2026-10-09T02:30:00Z', '2026-10-09'],
    ['Asia/Tokyo', '2026-10-08T15:01:00Z', '2026-10-09'],
    ['America/Los_Angeles', '2026-03-08T09:59:59Z', '2026-03-08'],
    ['America/Los_Angeles', '2026-03-08T10:00:00Z', '2026-03-08'],
    ['America/Los_Angeles', '2026-11-01T08:30:00Z', '2026-11-01'],
    ['America/Los_Angeles', '2026-11-01T09:30:00Z', '2026-11-01'],
    ['America/Los_Angeles', '2026-11-02T07:59:59Z', '2026-11-01'],
    ['America/Los_Angeles', '2026-11-02T08:00:00Z', '2026-11-02'],
  ])('uses %s at %s', async (zone, now, expected) => {
    h.zone = zone; vi.setSystemTime(new Date(now));
    await assertPlanned(expected);
  });
  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])('preserves an explicit civil date in %s', async zone => {
    h.zone = zone;
    await assertPlanned('2028-02-29', '2028-02-29');
  });
  it.each(['tomorrow', '2026-02-30', '2026-7-2', null, 20261009, false, {}])('invalid supplied date %j retains the existing fallback policy in the household zone', async value => {
    await assertPlanned('2026-10-08', value);
  });
  it('captures the household day before an awaited boundary crosses midnight', async () => {
    vi.setSystemTime(new Date('2026-10-09T06:59:59Z')); // Thursday23:59:59 in California.
    h.advanceAtRateLimit = '2026-10-09T07:00:01Z';
    await assertPlanned('2026-10-08');
  });
  it.each(['Invalid/Zone', '', ' ', null, undefined, 7])('refuses unknown household timezone %j before either write', async zone => {
    h.zone = zone;
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'pantryChef.fridgeChefIsUnavailableRight' });
    expect(h.writes).toEqual([]);
  });
  it('refuses unknown household timezone even when an explicit date was supplied', async () => {
    h.zone = 'Invalid/Zone';
    expect((await POST(request('2028-02-29'))).status).toBe(503); expect(h.writes).toEqual([]);
  });
  it('retains the empty-title refusal before any synthetic write', async () => {
    expect((await POST(request(undefined, ' '))).status).toBe(400); expect(h.writes).toEqual([]);
  });
});
