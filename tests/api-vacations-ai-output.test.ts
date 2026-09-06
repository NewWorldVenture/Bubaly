import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(), createServer: vi.fn(), enforceAIRateLimit: vi.fn(),
  resolveProvider: vi.fn(), complete: vi.fn(), suggestPacking: vi.fn(),
  writes: [] as { table: string; operation: string; rows: unknown }[],
  filters: [] as { table: string; column: string; value: unknown }[],
  trip: {} as Record<string, unknown>,
  failTable: null as string | null,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: mocks.enforceAIRateLimit }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: mocks.resolveProvider }));
vi.mock('@/lib/vacations/packing', () => ({ suggestPacking: mocks.suggestPacking }));

import { POST } from '@/app/api/vacations/ai/route';

function validPlan() {
  return {
    activities: [{ name: 'Museum', category: 'culture', location: 'Downtown', family_friendly: false, cost: 12.5 }, { name: 'Park', cost: 0 }],
    itinerary: [{ day: 1, title: 'Museum' }, { day: 3, title: 'Check bags', day_part: 'all_day', kind: 'reminder' }],
    budget: [{ category: 'food', planned: 25.5 }],
  };
}

function from(table: string) {
  let operation: string | null = null;
  let payload: unknown;
  let single = false;
  const query: Record<string, unknown> = {};
  const write = (kind: string, rows?: unknown) => {
    operation = kind;
    payload = rows;
    mocks.writes.push({ table, operation: kind, rows });
    return query;
  };
  const reply = () => {
    if (operation && table === mocks.failTable && operation !== 'delete') return { data: null, error: { message: 'Mock persistence failure' } };
    if (!operation) return { data: table === 'vacations' ? mocks.trip : [], error: null };
    if (operation === 'delete' || operation === 'update') return { data: [], error: null };
    const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    const data = rows.map((row, index) => ({ ...row, id: `${table}-${index + 1}` }));
    return { data: single ? data[0] : data, error: null };
  };
  Object.assign(query, {
    select: () => query,
    eq: (column: string, value: unknown) => { mocks.filters.push({ table, column, value }); return query; },
    in: () => query,
    single: () => { single = true; return query; },
    maybeSingle: () => { single = true; return query; },
    insert: (rows: unknown) => write('insert', rows),
    upsert: (rows: unknown) => write('upsert', rows),
    update: (rows: unknown) => write('update', rows),
    delete: () => write('delete'),
    then: (resolve: (value: ReturnType<typeof reply>) => unknown) => Promise.resolve(reply()).then(resolve),
  });
  return query;
}

const request = () => new NextRequest('http://localhost/api/vacations/ai', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'build', vacationId: 'trip-1' }),
});
const withPlan = (overrides: Record<string, unknown>) => JSON.stringify({ ...validPlan(), ...overrides });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.writes = [];
  mocks.filters = [];
  mocks.failTable = null;
  mocks.trip = { id: 'trip-1', family_id: 'family-1', title: 'Family break', destination: 'Boston', kind: 'domestic', start_date: '2026-10-01', end_date: '2026-10-03', is_international: false, budget_cents: null };
  // `role`, `family` and `member` are what `scopeFromUserContext` reads to build
  // the scope the route now opens its `ai_requests` row through. All three are
  // required fields on `FamilyMembership`, so production always has them; this
  // stub was simply thinner than the type. Without them the scope build throws
  // INSIDE the route's try, and every case below — success included — comes back
  // as the catch's 502.
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: {
      familyId: 'family-1', role: 'parent',
      family: { name: 'Family One', timezone: 'America/Chicago' },
      member: { id: 'member-1' },
    },
  });
  mocks.createServer.mockResolvedValue({ from });
  mocks.enforceAIRateLimit.mockResolvedValue({ ok: true });
  mocks.resolveProvider.mockResolvedValue({ complete: mocks.complete });
  mocks.complete.mockResolvedValue({ text: JSON.stringify(validPlan()) });
  mocks.suggestPacking.mockReturnValue([{ name: 'Socks', category: 'clothes', quantity: 2 }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The writes that would change the family's trip.
 *
 * The route now also opens an `ai_requests` row, which is the assistant's own
 * bookkeeping about the attempt and not trip data — the same class as
 * `ai_messages` elsewhere. Filtering it out here keeps the assertion saying what
 * it always meant: an invalid plan touches NOTHING the family would see.
 * Widening this set is deliberate; anything not named still fails the test.
 */
const OWN_BOOKKEEPING = new Set(['ai_requests']);
const builderWrites = () => mocks.writes.filter((w) => !OWN_BOOKKEEPING.has(w.table));

describe('vacation builder validates before persistence', () => {
  const invalid: [string, string][] = [
    ['broken JSON', '{'], ['null', 'null'], ['scalar', 'true'], ['array-wrapped plan', `[${JSON.stringify(validPlan())}]`],
    ['null section', withPlan({ activities: null })], ['object section', withPlan({ itinerary: {} })],
    ['null activity', withPlan({ activities: [null] })], ['array activity', withPlan({ activities: [[]] })],
    ['object name', withPlan({ activities: [{ name: {} }] })], ['oversized name', withPlan({ activities: [{ name: 'x'.repeat(201) }] })],
    ['invalid boolean', withPlan({ activities: [{ name: 'Park', family_friendly: 'true' }] })],
    ['negative cost', withPlan({ activities: [{ name: 'Park', cost: -1 }] })],
    ['unsafe cost', withPlan({ activities: [{ name: 'Park', cost: Number.MAX_SAFE_INTEGER }] })],
    ['day zero', withPlan({ itinerary: [{ day: 0, title: 'Rest' }] })],
    ['fractional day', withPlan({ itinerary: [{ day: 1.5, title: 'Rest' }] })],
    ['day beyond trip', withPlan({ itinerary: [{ day: 4, title: 'Rest' }] })],
    ['string day', withPlan({ itinerary: [{ day: '1', title: 'Rest' }] })],
    ['invalid day part', withPlan({ itinerary: [{ day: 1, title: 'Rest', day_part: 'midnight' }] })],
    ['invalid item kind', withPlan({ itinerary: [{ day: 1, title: 'Rest', kind: 'flight' }] })],
    ['null budget entry after valid activities', withPlan({ budget: [null] })],
    ['invalid budget enum after valid itinerary', withPlan({ budget: [{ category: 'hotel', planned: 5 }] })],
    ['negative budget after valid itinerary', withPlan({ budget: [{ category: 'food', planned: -1 }] })],
    ['string budget', withPlan({ budget: [{ category: 'food', planned: '10' }] })],
    ['overflowed JSON number', withPlan({ budget: [{ category: 'food', planned: 'OVERFLOW' }] }).replace('"OVERFLOW"', '1e309')],
    ['too many activities', withPlan({ activities: Array.from({ length: 31 }, () => ({ name: 'Park' })) })],
    ['too many itinerary items', withPlan({ itinerary: Array.from({ length: 61 }, () => ({ day: 1, title: 'Rest' })) })],
    ['too many budget rows', withPlan({ budget: Array.from({ length: 10 }, () => ({ category: 'food', planned: 0 })) })],
    ['oversized raw response', `${' '.repeat(65_536)}{}`],
    ['fabricated booking field', withPlan({ activities: [{ name: 'Park', booked: true }] })],
  ];

  it.each(invalid)('rejects %s with zero builder writes', async (_name, text) => {
    mocks.complete.mockResolvedValue({ text });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI builder returned an invalid trip plan. Please try again.' });
    expect(builderWrites()).toEqual([]);
    expect(mocks.suggestPacking).not.toHaveBeenCalled();
  });

  it('persists a valid complete plan with defaults, zero cost, last trip day, packing, and the same envelope', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, added: { activities: 2, items: 2, budget: 1, packing: 1 } });
    expect(mocks.writes.find((w) => w.table === 'vacation_activities')?.rows).toEqual([
      { family_id: 'family-1', vacation_id: 'trip-1', name: 'Museum', category: 'culture', location: 'Downtown', family_friendly: false, cost_cents: 1250, created_by: 'user-1' },
      { family_id: 'family-1', vacation_id: 'trip-1', name: 'Park', category: null, location: null, family_friendly: true, cost_cents: 0, created_by: 'user-1' },
    ]);
    expect(mocks.writes.find((w) => w.table === 'vacation_itinerary_items')?.rows).toEqual([
      { family_id: 'family-1', vacation_id: 'trip-1', day_id: 'vacation_itinerary_days-1', day_part: 'morning', kind: 'activity', title: 'Museum', created_by: 'user-1' },
      { family_id: 'family-1', vacation_id: 'trip-1', day_id: 'vacation_itinerary_days-3', day_part: 'all_day', kind: 'reminder', title: 'Check bags', created_by: 'user-1' },
    ]);
    expect(mocks.writes.find((w) => w.table === 'vacation_budgets')?.rows).toEqual([
      { family_id: 'family-1', vacation_id: 'trip-1', category: 'food', planned_cents: 2550, created_by: 'user-1' },
    ]);
    expect(mocks.filters).toContainEqual({ table: 'vacations', column: 'family_id', value: 'family-1' });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ tools: [], maxTokens: 2000 }));
  });

  it('retains last-entry-wins budget handling after validating every entry', async () => {
    mocks.complete.mockResolvedValue({ text: withPlan({ budget: [{ category: 'food', planned: 10 }, { category: 'food', planned: 12.345 }] }) });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.writes.find((w) => w.table === 'vacation_budgets')?.rows).toEqual([
      { family_id: 'family-1', vacation_id: 'trip-1', category: 'food', planned_cents: 1235, created_by: 'user-1' },
    ]);
  });

  it('preserves optional sections and rule-based packing for an empty object plan', async () => {
    mocks.complete.mockResolvedValue({ text: '{}' });
    expect(await (await POST(request())).json()).toEqual({ ok: true, added: { activities: 0, items: 0, budget: 0, packing: 1 } });
    expect(builderWrites().map((w) => w.table)).toEqual(['vacation_packing_lists', 'vacation_packing_items']);
  });

  it('rejects itinerary entries on an undated trip before any activity write', async () => {
    mocks.trip.start_date = null;
    mocks.trip.end_date = null;
    expect((await POST(request())).status).toBe(502);
    expect(builderWrites()).toEqual([]);
  });

  it('still allows an undated activity-only plan with omitted cost', async () => {
    mocks.trip.start_date = null;
    mocks.trip.end_date = null;
    mocks.complete.mockResolvedValue({ text: '{"activities":[{"name":"Park"}]}' });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.writes.find((w) => w.table === 'vacation_activities')?.rows).toEqual([
      { family_id: 'family-1', vacation_id: 'trip-1', name: 'Park', category: null, location: null, family_friendly: true, cost_cents: null, created_by: 'user-1' },
    ]);
  });

  it('keeps compensating earlier writes when valid output hits a persistence failure', async () => {
    mocks.failTable = 'vacation_itinerary_items';
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Could not save the generated trip plan.' });
    expect(mocks.writes.filter((w) => w.operation === 'delete').map((w) => w.table)).toEqual(['vacation_itinerary_days', 'vacation_activities']);
    expect(mocks.writes.some((w) => w.table === 'vacation_budgets')).toBe(false);
  });

  it('keeps provider failures write-free with the existing unavailable error', async () => {
    mocks.complete.mockRejectedValue(new Error('Mock provider failure'));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI builder is temporarily unavailable.' });
    expect(builderWrites()).toEqual([]);
  });

  it('preserves authentication before provider calls or writes', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('Unauthorized'));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(builderWrites()).toEqual([]);
  });

  it('preserves rate limiting before provider calls or writes', async () => {
    mocks.enforceAIRateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(builderWrites()).toEqual([]);
  });
});
