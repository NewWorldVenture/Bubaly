// /api/vacations/ai, three writes that could land twice or land wrong:
//
//   • 'build' read the trip's activities and items for prompt context only and
//     wrote a whole new plan regardless — a lost response and a retry, or two
//     tabs, stacked two itineraries and overwrote the family's edited budget
//     lines. The service path (`buildPlan`) refuses unless `force`; the route
//     now refuses with 409 unless `rebuild`.
//   • 'recommendations' deleted the open rule recommendations BEFORE inserting
//     the new set, so a failed insert wiped them. Insert first, delete by id.
//   • 'concierge' persisted the user's message before the model call and stored
//     a canned apology as a successful reply. Nothing is persisted until the
//     model answered with text; an empty answer is a 502.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entitledServiceClient } from './helpers/entitled-service-client';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  writes: [] as { table: string; operation: string; rows: unknown; filters: Record<string, unknown>; order: number }[],
  rowsFor: {} as Record<string, unknown[]>,
  failTable: null as string | null,
  trip: {} as Record<string, unknown>,
  sequence: 0,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'family-1', role: 'parent', family: { name: 'Family One', timezone: 'America/Chicago' }, member: { id: 'member-1' } },
})) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({ from }), createServiceClient: () => entitledServiceClient() }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: async () => ({ complete: mocks.complete, model: 'test-model' }), isAIConfigured: async () => true }));
vi.mock('@/lib/vacations/packing', () => ({ suggestPacking: () => [{ name: 'Socks', category: 'clothes', quantity: 2 }] }));

function from(table: string) {
  let operation: string | null = null;
  let payload: unknown;
  let single = false;
  const filters: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const write = (kind: string, rows?: unknown) => {
    operation = kind;
    payload = rows;
    const entry = { table, operation: kind, rows, filters, order: ++mocks.sequence };
    mocks.writes.push(entry);
    return query;
  };
  const reply = () => {
    if (operation && table === mocks.failTable) return { data: null, error: { message: 'Mock persistence failure' } };
    if (!operation) {
      if (table === 'vacations') return { data: mocks.trip, error: null };
      const rows = mocks.rowsFor[table] ?? [];
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    if (operation === 'delete' || operation === 'update') return { data: [], error: null };
    const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
    const data = rows.map((row, index) => ({ ...row, id: `${table}-${index + 1}` }));
    return { data: single ? data[0] : data, error: null };
  };
  Object.assign(query, {
    select: () => query,
    eq: (column: string, value: unknown) => { filters[column] = value; return query; },
    in: (column: string, value: unknown) => { filters[`in:${column}`] = value; return query; },
    order: () => query, limit: () => query, abortSignal: () => query,
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

import { POST } from '@/app/api/vacations/ai/route';

const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/vacations/ai', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vacationId: 'trip-1', ...body }),
}));
const plan = () => JSON.stringify({ activities: [{ name: 'Park', cost: 0 }], itinerary: [{ day: 1, title: 'Park' }], budget: [{ category: 'food', planned: 25 }] });
const OWN_BOOKKEEPING = new Set(['ai_requests']);
const familyWrites = () => mocks.writes.filter((w) => !OWN_BOOKKEEPING.has(w.table));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.writes = [];
  mocks.rowsFor = {};
  mocks.failTable = null;
  mocks.sequence = 0;
  mocks.trip = { id: 'trip-1', family_id: 'family-1', title: 'Family break', destination: 'Boston', kind: 'domestic', start_date: '2026-10-01', end_date: '2026-10-03', is_international: false, budget_cents: null };
  mocks.complete.mockResolvedValue({ text: plan() });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('build does not stack a second plan', () => {
  it('refuses with 409 when the trip already has itinerary items, before the model is called', async () => {
    mocks.rowsFor.vacation_itinerary_items = [{ id: 'item-1', day_id: 'day-1', title: 'Museum' }];
    const res = await post({ action: 'build' });
    expect(res.status).toBe(409);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(familyWrites()).toEqual([]);
  });

  it('refuses when the trip already has activities', async () => {
    mocks.rowsFor.vacation_activities = [{ id: 'act-1', name: 'Museum' }];
    expect((await post({ action: 'build' })).status).toBe(409);
    expect(familyWrites()).toEqual([]);
  });

  it('rebuilds only when asked to', async () => {
    mocks.rowsFor.vacation_itinerary_items = [{ id: 'item-1', day_id: 'day-1', title: 'Museum' }];
    const res = await post({ action: 'build', rebuild: true });
    expect(res.status).toBe(200);
    expect(familyWrites().some((w) => w.table === 'vacation_activities' && w.operation === 'insert')).toBe(true);
  });

  it('builds a trip that has no plan yet', async () => {
    expect((await post({ action: 'build' })).status).toBe(200);
  });
});

describe('recommendations are replaced, never wiped', () => {
  beforeEach(() => {
    mocks.rowsFor.vacation_ai_recommendations = [{ id: 'old-1' }, { id: 'old-2' }];
  });

  it('inserts the new set before deleting the old one, and deletes exactly the rows it read', async () => {
    const res = await post({ action: 'recommendations' });
    expect(res.status).toBe(200);
    const writes = familyWrites().filter((w) => w.table === 'vacation_ai_recommendations');
    expect(writes.map((w) => w.operation)).toEqual(['insert', 'delete']);
    expect(writes[1].filters).toMatchObject({ family_id: 'family-1', vacation_id: 'trip-1', source: 'rules', status: 'open', 'in:id': ['old-1', 'old-2'] });
  });

  it('a failed insert leaves the family\'s existing recommendations in place', async () => {
    mocks.failTable = 'vacation_ai_recommendations';
    const res = await post({ action: 'recommendations' });
    expect(res.status).toBe(503);
    expect(familyWrites().filter((w) => w.table === 'vacation_ai_recommendations' && w.operation === 'delete')).toEqual([]);
  });

  it('a first run with nothing prior inserts and deletes nothing', async () => {
    mocks.rowsFor.vacation_ai_recommendations = [];
    expect((await post({ action: 'recommendations' })).status).toBe(200);
    expect(familyWrites().filter((w) => w.table === 'vacation_ai_recommendations').map((w) => w.operation)).toEqual(['insert']);
  });
});

describe('the concierge persists a turn only once it has an answer', () => {
  const messages = () => familyWrites().filter((w) => w.table === 'vacation_ai_messages');

  beforeEach(() => {
    mocks.rowsFor.vacation_ai_conversations = [{ id: 'convo-1' }];
    mocks.rowsFor.vacation_ai_messages = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];
  });

  it('an empty answer is a 502 and nothing is written', async () => {
    mocks.complete.mockResolvedValue({ text: '' });
    const res = await post({ action: 'concierge', conversationId: 'convo-1', message: 'Where should we eat?' });
    expect(res.status).toBe(502);
    expect(messages()).toEqual([]);
  });

  it('a provider failure is a 502 and the question is not left in the conversation', async () => {
    mocks.complete.mockRejectedValue(new Error('provider down'));
    const res = await post({ action: 'concierge', conversationId: 'convo-1', message: 'Where should we eat?' });
    expect(res.status).toBe(502);
    expect(messages()).toEqual([]);
  });

  it('a real answer writes the question then the reply, and the model saw the question', async () => {
    mocks.complete.mockResolvedValue({ text: 'Try the North End.' });
    const res = await post({ action: 'concierge', conversationId: 'convo-1', message: 'Where should we eat?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: 'convo-1', reply: 'Try the North End.' });
    expect(messages().map((w) => (w.rows as { role: string; content: string }).role)).toEqual(['user', 'assistant']);
    expect(messages().map((w) => (w.rows as { content: string }).content)).toEqual(['Where should we eat?', 'Try the North End.']);
    const sent = mocks.complete.mock.calls[0][0].messages as { role: string; content: string }[];
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Where should we eat?' });
    expect(sent).toHaveLength(3);
  });
});
