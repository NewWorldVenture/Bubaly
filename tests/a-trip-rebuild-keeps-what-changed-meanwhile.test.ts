// /api/vacations/ai 'build', driven against an in-memory database that applies
// real filters, with a model call held open so other tabs can act during it.
//
//   • A rebuild chose the rows to delete BEFORE the model call and deleted
//     them by id alone. A suggestion another tab booked meanwhile (tickets and
//     all), one a parent un-stamped to make it theirs, or one they edited, was
//     deleted anyway — and a failure after that put the stale, unbooked copy
//     back. Each delete is now fenced at write time: still unbooked, still
//     stamped, `updated_at` unchanged.
//   • "Already has a plan" was one read before the model call, so two tabs (or
//     a retry and its original) both passed it and both wrote: two plans, two
//     master packing lists. A compare-and-set claim on the trip row, taken once
//     the plan exists, lets exactly one of them write.
//   • The claim is not a lock. A request that READ the trip after another's
//     claim, while that other was still writing, passes it; the pinned case at
//     the end is that remaining window, which needs SQL to close.
//   • A plan the assistant's `trips.buildPlan` drafted carried no stamp, so a
//     confirmed "Replace it?" replaced nothing and stacked a second plan; the
//     409 now says whether a rebuild would replace anything at all.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import type { ServiceScope } from '@/lib/services/types';
import { CONCIERGE_PLAN_MARKER } from '@/lib/vacations/ai-output';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { entitledServiceClient } from './helpers/entitled-service-client';

const holder = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: vi.fn(async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'family-1', role: 'parent', family: { name: 'Family One', timezone: 'America/Chicago' }, member: { id: 'member-1' } },
})) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => entitledServiceClient() }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  resolveProvider: async () => ({ complete: holder.complete, model: 'test-model' }),
  isAIConfigured: async () => true,
}));
vi.mock('@/lib/vacations/packing', () => ({ suggestPacking: () => [{ name: 'Socks', category: 'clothes', quantity: 2 }] }));

import { POST } from '@/app/api/vacations/ai/route';
import { buildPlan } from '@/lib/services/trips';

const FAMILY = 'family-1';
const TRIP = 'trip-1';
const READ_AT = '2026-09-01T09:00:00.000000+00:00';
// One builder insert is one statement: its rows share one `updated_at`.
const BUILT_AT = '2026-09-01T10:00:00.123456+00:00';

const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/vacations/ai', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vacationId: TRIP, ...body }),
}));
const planNamed = (name: string) => JSON.stringify({
  activities: [{ name, cost: 0 }],
  itinerary: [{ day: 1, title: `${name} morning` }, { day: 2, title: `${name} afternoon` }],
  budget: [{ category: 'food', planned: 25 }],
});

/**
 * The 0070 `set_updated_at` trigger: every update to a vacation table moves
 * `updated_at`. The in-memory store applies only the patch, so it is modelled
 * here — the claim and the write-time fences are about exactly this column.
 */
let tick = 0;
type Builder = ReturnType<InMemorySupabase['from']>;
type Hook = (name: string, builder: Builder) => void;
/** Per-test interference with the store: the trigger below, a failing write, a write held open. */
let hooks: Hook[] = [];
const updatedAtTrigger: Hook = (name, builder) => {
  if (!name.startsWith('vacation')) return;
  const update = builder.update.bind(builder);
  builder.update = ((patch: Row) => update({ ...patch, updated_at: `2026-10-11T00:00:${String(++tick).padStart(2, '0')}.000000+00:00` })) as never;
};
function instrument(db: InMemorySupabase) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    for (const hook of hooks) hook(name, builder);
    return builder;
  }) as typeof db.from);
}

function seeded(opts: { plan?: 'stamped' | 'unstamped' | 'none'; days?: boolean } = {}) {
  // The column defaults 0070 gives these tables, which a builder insert relies on.
  const db = createInMemorySupabase({ defaults: {
    vacation_activities: { booked: false, notes: null },
    vacation_itinerary_items: { booked: false, notes: null, sort_order: 0, member_ids: [] },
  } });
  db.seed('vacations', [{
    id: TRIP, family_id: FAMILY, title: 'Family break', destination: 'Boston', kind: 'domestic', status: 'planning',
    start_date: '2026-10-01', end_date: '2026-10-03', timezone: 'America/New_York', is_international: false,
    budget_cents: null, currency: 'USD', updated_at: READ_AT,
  }]);
  if (opts.days !== false) {
    db.seed('vacation_itinerary_days', ['2026-10-01', '2026-10-02', '2026-10-03'].map((day, i) => ({
      id: `day-${i + 1}`, family_id: FAMILY, vacation_id: TRIP, day_date: day,
    })));
  }
  const plan = opts.plan ?? 'stamped';
  if (plan !== 'none') {
    const notes = plan === 'stamped' ? CONCIERGE_PLAN_MARKER : null;
    db.seed('vacation_activities', [
      { id: 'act-ai-1', family_id: FAMILY, vacation_id: TRIP, name: 'Aquarium', booked: false, notes, updated_at: BUILT_AT },
      { id: 'act-ai-2', family_id: FAMILY, vacation_id: TRIP, name: 'Harbour cruise', booked: false, notes, updated_at: BUILT_AT },
      { id: 'act-hand', family_id: FAMILY, vacation_id: TRIP, name: 'Visit grandma', booked: false, notes: null, updated_at: READ_AT },
    ]);
    db.seed('vacation_itinerary_items', [
      { id: 'item-ai-1', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Aquarium', booked: false, notes, updated_at: BUILT_AT },
      { id: 'item-ai-2', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-2', kind: 'activity', day_part: 'morning', title: 'Harbour cruise', booked: false, notes, updated_at: BUILT_AT },
      { id: 'item-ai-3', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-3', kind: 'meal', day_part: 'evening', title: 'Lobster dinner', booked: false, notes, updated_at: BUILT_AT },
      { id: 'item-hand', family_id: FAMILY, vacation_id: TRIP, day_id: 'day-1', kind: 'meal', day_part: 'evening', title: 'Dinner with cousins', booked: false, notes: 'Table for six', updated_at: READ_AT },
    ]);
  }
  hooks = [updatedAtTrigger];
  instrument(db);
  holder.db = db;
  return db;
}

/** A model call that answers only when the test says so. */
function heldModel() {
  const pending: ((value: { text: string }) => void)[] = [];
  holder.complete.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  return {
    pending,
    answer: (i: number, name: string) => pending[i]({ text: planNamed(name) }),
    waitFor: (n: number) => vi.waitFor(() => expect(pending).toHaveLength(n)),
  };
}

const rows = (db: InMemorySupabase, table: string) => db.table(table) as Row[];
const ids = (db: InMemorySupabase, table: string) => rows(db, table).map((r) => r.id).sort();
const named = (db: InMemorySupabase, name: string) => rows(db, 'vacation_activities').filter((r) => r.name === name);
/** Another tab, writing through the same database while the model is busy. */
const otherTab = (db: InMemorySupabase, table: string, id: string, patch: Row) => db.from(table).update(patch).eq('id', id).eq('family_id', FAMILY).select('id');

beforeEach(() => {
  vi.restoreAllMocks();
  holder.complete.mockReset();
  tick = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a rebuild keeps what another tab changed while the model was writing', () => {
  it('a suggestion booked, un-stamped or edited during generation survives; the untouched ones are replaced', async () => {
    const db = seeded();
    const model = heldModel();
    const rebuild = post({ action: 'build', rebuild: true });
    await model.waitFor(1);

    // While the model drafts: one parent books the aquarium (a commitment now,
    // with tickets to follow), another makes the harbour cruise item their own
    // by clearing the stamp, and someone pencils a time onto the dinner.
    await otherTab(db, 'vacation_activities', 'act-ai-1', { booked: true });
    await otherTab(db, 'vacation_itinerary_items', 'item-ai-2', { notes: 'Our own plan now' });
    await otherTab(db, 'vacation_itinerary_items', 'item-ai-3', { title: 'Lobster dinner at 7' });

    model.answer(0, 'Park');
    expect((await rebuild).status).toBe(200);

    expect(rows(db, 'vacation_activities').find((r) => r.id === 'act-ai-1')).toMatchObject({ booked: true, notes: CONCIERGE_PLAN_MARKER });
    expect(rows(db, 'vacation_itinerary_items').find((r) => r.id === 'item-ai-2')).toMatchObject({ notes: 'Our own plan now' });
    expect(rows(db, 'vacation_itinerary_items').find((r) => r.id === 'item-ai-3')).toMatchObject({ title: 'Lobster dinner at 7' });
    // What nobody touched was the builder's to replace, and it was.
    expect(ids(db, 'vacation_activities')).not.toContain('act-ai-2');
    expect(ids(db, 'vacation_itinerary_items')).not.toContain('item-ai-1');
    // Hand-made rows are never the builder's.
    expect(ids(db, 'vacation_activities')).toContain('act-hand');
    expect(ids(db, 'vacation_itinerary_items')).toContain('item-hand');
    expect(named(db, 'Park')).toHaveLength(1);
  });

  it('a suggestion booked after the plan was re-read, while the new plan is being written, is still not deleted', async () => {
    const db = seeded();
    // The last plan write before the replace: the budget upsert. A booking
    // that lands here was not visible to any read this request made.
    hooks.push((name, builder) => {
      if (name !== 'vacation_budgets') return;
      const upsert = builder.upsert.bind(builder);
      builder.upsert = ((value: Row[], options?: { onConflict?: string }) => {
        const row = rows(db, 'vacation_activities').find((r) => r.id === 'act-ai-2');
        if (row) Object.assign(row, { booked: true, updated_at: '2026-10-11T00:59:59.000000+00:00' });
        return upsert(value, options);
      }) as never;
    });
    holder.complete.mockResolvedValue({ text: planNamed('Park') });

    expect((await post({ action: 'build', rebuild: true })).status).toBe(200);
    expect(rows(db, 'vacation_activities').find((r) => r.id === 'act-ai-2')).toMatchObject({ booked: true });
    expect(ids(db, 'vacation_activities')).not.toContain('act-ai-1');
  });

  it('a rebuild that fails after the replace restores what its delete removed, never a stale copy over a booking', async () => {
    const db = seeded();
    const model = heldModel();
    // The master packing list is the write after the replace; it fails.
    hooks.push((name, builder) => {
      if (name !== 'vacation_packing_lists') return;
      builder.insert = (() => ({ select: () => ({ single: async () => ({ data: null, error: { code: 'XX000', message: 'write rejected' } }) }) })) as never;
    });
    const rebuild = post({ action: 'build', rebuild: true });
    await model.waitFor(1);
    await otherTab(db, 'vacation_activities', 'act-ai-1', { booked: true });
    model.answer(0, 'Park');

    expect((await rebuild).status).toBe(503);
    // The booked one was never deleted, so it is never "restored" unbooked.
    expect(rows(db, 'vacation_activities').filter((r) => r.id === 'act-ai-1')).toEqual([expect.objectContaining({ booked: true })]);
    // The one the replace did delete is back as it was, and the new plan is gone.
    expect(rows(db, 'vacation_activities').find((r) => r.id === 'act-ai-2')).toMatchObject({ name: 'Harbour cruise', booked: false, notes: CONCIERGE_PLAN_MARKER });
    expect(ids(db, 'vacation_itinerary_items')).toEqual(['item-ai-1', 'item-ai-2', 'item-ai-3', 'item-hand']);
    expect(named(db, 'Park')).toHaveLength(0);
  });
});

/**
 * A plan write that hangs and then fails — a lock wait that ends in a
 * statement timeout. Until the test releases it, other tabs act on what this
 * request has already written: its rows are the family's from the moment
 * their insert commits. `only` picks the build's own write out of the writes
 * to the same table, so another tab's insert there is not held with it.
 */
function stalledThenFails(table: string, op: 'insert' | 'upsert', only: (value: Row | Row[]) => boolean = () => true) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const reachedWrite = new Promise<void>((resolve) => { reached = resolve; });
  const timedOut = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
  hooks.push((name, builder) => {
    if (name !== table) return;
    const write = (builder[op] as (...args: unknown[]) => unknown).bind(builder);
    Object.assign(builder, { [op]: (value: Row | Row[], ...rest: unknown[]) => {
      if (!only(value)) return write(value, ...rest);
      reached();
      const query: Record<string, unknown> = {};
      Object.assign(query, {
        select: () => query, single: () => query,
        then: (ok: never, ko: never) => released.then(() => timedOut).then(ok, ko),
      });
      return query;
    } });
  });
  return { reachedWrite, release };
}

/** 0070: `vacation_itinerary_items.day_id` is ON DELETE CASCADE. The store does not model it; this does. */
const dayCascade = (db: InMemorySupabase): Hook => (name, builder) => {
  if (name !== 'vacation_itinerary_days') return;
  const remove = builder.delete.bind(builder);
  builder.delete = (() => {
    const query = remove();
    const run = query.then.bind(query);
    Object.assign(query, { then: (ok: never, ko: never) => run((reply: unknown) => {
      const days = new Set(rows(db, 'vacation_itinerary_days').map((d) => d.id));
      db.replace('vacation_itinerary_items', rows(db, 'vacation_itinerary_items').filter((item) => item.day_id == null || days.has(item.day_id)));
      return reply;
    }).then(ok, ko) });
    return query;
  }) as never;
};

/** 0070: `vacation_packing_items.list_id` is ON DELETE CASCADE. Modelled as `dayCascade` is. */
const listCascade = (db: InMemorySupabase): Hook => (name, builder) => {
  if (name !== 'vacation_packing_lists') return;
  const remove = builder.delete.bind(builder);
  builder.delete = (() => {
    const query = remove();
    const run = query.then.bind(query);
    Object.assign(query, { then: (ok: never, ko: never) => run((reply: unknown) => {
      const lists = new Set(rows(db, 'vacation_packing_lists').map((l) => l.id));
      db.replace('vacation_packing_items', rows(db, 'vacation_packing_items').filter((item) => item.list_id == null || lists.has(item.list_id)));
      return reply;
    }).then(ok, ko) });
    return query;
  }) as never;
};

describe('a build that fails takes back only what is still as it wrote it', () => {
  it('first build: the new suggestion a parent booked, and the one they edited, while a later write hung, survive its rollback', async () => {
    const db = seeded({ plan: 'none' });
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    const stalled = stalledThenFails('vacation_budgets', 'upsert');
    const build = post({ action: 'build' });
    await stalled.reachedWrite;

    // The activities and itinerary are in; the budget write hangs. A parent
    // books the park and pencils a time onto the first morning, through the
    // same update the trip screens make.
    const park = named(db, 'Park')[0];
    const morning = rows(db, 'vacation_itinerary_items').find((r) => r.title === 'Park morning')!;
    await otherTab(db, 'vacation_activities', String(park.id), { booked: true });
    await otherTab(db, 'vacation_itinerary_items', String(morning.id), { start_time: '09:30' });
    stalled.release();

    expect((await build).status).toBe(503);
    expect(named(db, 'Park')).toEqual([expect.objectContaining({ id: park.id, booked: true })]);
    // The edited item is theirs now; the untouched one was the failed build's, and went.
    expect(rows(db, 'vacation_itinerary_items')).toEqual([expect.objectContaining({ id: morning.id, start_time: '09:30' })]);
  });

  it('rebuild: a new suggestion booked while the packing write hung survives, and the replaced plan is still put back', async () => {
    const db = seeded();
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    // The master packing list is the write after the replace.
    const stalled = stalledThenFails('vacation_packing_lists', 'insert');
    const rebuild = post({ action: 'build', rebuild: true });
    await stalled.reachedWrite;
    const park = named(db, 'Park')[0];
    await otherTab(db, 'vacation_activities', String(park.id), { booked: true });
    stalled.release();

    expect((await rebuild).status).toBe(503);
    expect(named(db, 'Park')).toEqual([expect.objectContaining({ id: park.id, booked: true })]);
    // The rows the replace deleted are back exactly as it removed them.
    expect(ids(db, 'vacation_activities')).toEqual(['act-ai-1', 'act-ai-2', 'act-hand', String(park.id)].sort());
    expect(ids(db, 'vacation_itinerary_items')).toEqual(['item-ai-1', 'item-ai-2', 'item-ai-3', 'item-hand']);
  });

  it('a day the failed build created is kept while an item sits on it, so the item is not cascaded away', async () => {
    const db = seeded({ plan: 'none', days: false });
    hooks.push(dayCascade(db));
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    const stalled = stalledThenFails('vacation_budgets', 'upsert');
    const build = post({ action: 'build' });
    await stalled.reachedWrite;
    // A parent adds dinner by hand to the first day, which this build created.
    const firstDay = rows(db, 'vacation_itinerary_days').find((d) => d.day_date === '2026-10-01')!;
    await db.from('vacation_itinerary_items').insert({
      family_id: FAMILY, vacation_id: TRIP, day_id: firstDay.id, kind: 'meal', day_part: 'evening', title: 'Dinner with cousins', booked: true, confirmation_code: 'TBL-6',
    }).select('id');
    stalled.release();

    expect((await build).status).toBe(503);
    expect(rows(db, 'vacation_itinerary_items')).toEqual([expect.objectContaining({ title: 'Dinner with cousins', day_id: firstDay.id, confirmation_code: 'TBL-6' })]);
    // The days nothing sits on were the failed build's, and went.
    expect(ids(db, 'vacation_itinerary_days')).toEqual([firstDay.id]);
    expect(named(db, 'Park')).toHaveLength(0);
  });

  it('the master packing list the failed build created is kept while an item sits on it, so the item is not cascaded away', async () => {
    const db = seeded({ plan: 'none', days: false });
    hooks.push(dayCascade(db), listCascade(db));
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    // The build's own suggestions (the mocked suggestPacking gives Socks) hang
    // and then time out; the packing screen's insert goes straight through.
    const stalled = stalledThenFails('vacation_packing_items', 'insert', (value) => [value].flat().some((row) => row.name === 'Socks'));
    const build = post({ action: 'build' });
    await stalled.reachedWrite;
    // The packing screen (trip-packing.tsx ensureMasterList) finds the master
    // list this build created, and a parent adds to it by hand.
    const master = rows(db, 'vacation_packing_lists').find((l) => l.is_master)!;
    expect(master).toBeDefined();
    await db.from('vacation_packing_items').insert({
      family_id: FAMILY, vacation_id: TRIP, list_id: master.id, name: 'Passports', category: 'documents', quantity: 4, created_by: 'user-2',
    }).select('id');
    stalled.release();

    expect((await build).status).toBe(503);
    expect(rows(db, 'vacation_packing_items')).toEqual([expect.objectContaining({ name: 'Passports', list_id: master.id })]);
    expect(ids(db, 'vacation_packing_lists')).toEqual([master.id]);
    // Everything else the failed build wrote was its own, and went.
    expect(named(db, 'Park')).toHaveLength(0);
    expect(rows(db, 'vacation_itinerary_items')).toHaveLength(0);
    expect(rows(db, 'vacation_itinerary_days')).toHaveLength(0);
    expect(rows(db, 'vacation_budgets')).toHaveLength(0);
  });

  it('a master packing list the failed build created, with nothing on it, still goes', async () => {
    const db = seeded({ plan: 'none', days: false });
    hooks.push(dayCascade(db), listCascade(db));
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    const stalled = stalledThenFails('vacation_packing_items', 'insert');
    const build = post({ action: 'build' });
    await stalled.reachedWrite;
    expect(rows(db, 'vacation_packing_lists')).toHaveLength(1);
    stalled.release();

    expect((await build).status).toBe(503);
    for (const table of ['vacation_activities', 'vacation_itinerary_items', 'vacation_itinerary_days', 'vacation_budgets', 'vacation_packing_lists', 'vacation_packing_items']) {
      expect([table, rows(db, table)]).toEqual([table, []]);
    }
  });

  it('trips.buildPlan: what a parent booked or put on a new day while the budget write hung survives its rollback', async () => {
    const db = seeded({ plan: 'none', days: false });
    hooks.push(dayCascade(db));
    const stalled = stalledThenFails('vacation_budgets', 'upsert');
    const drafting = buildPlan(scope(db), TRIP, { provider: structured({
      activities: [
        { name: 'Fenway tour', category: 'tour', location: null, family_friendly: true, cost_usd: 30 },
        { name: 'Swan boats', category: 'outdoors', location: null, family_friendly: true, cost_usd: 10 },
      ],
      itinerary: [
        { day: 1, day_part: 'morning', title: 'Fenway tour', kind: 'activity' },
        { day: 2, day_part: 'afternoon', title: 'Swan boats', kind: 'activity' },
      ],
      budget: [{ category: 'food', planned_usd: 25 }],
    }) });
    await stalled.reachedWrite;
    const fenway = rows(db, 'vacation_activities').find((r) => r.name === 'Fenway tour')!;
    await otherTab(db, 'vacation_activities', String(fenway.id), { booked: true });
    const firstDay = rows(db, 'vacation_itinerary_days').find((d) => d.day_date === '2026-10-01')!;
    await db.from('vacation_itinerary_items').insert({
      family_id: FAMILY, vacation_id: TRIP, day_id: firstDay.id, kind: 'meal', day_part: 'evening', title: 'Dinner with cousins', booked: true,
    }).select('id');
    stalled.release();

    expect(await drafting).toMatchObject({ ok: false });
    expect(rows(db, 'vacation_activities')).toEqual([expect.objectContaining({ id: fenway.id, booked: true })]);
    expect(rows(db, 'vacation_itinerary_items').map((r) => r.title)).toEqual(['Dinner with cousins']);
    expect(ids(db, 'vacation_itinerary_days')).toEqual([firstDay.id]);
  });
});

describe('two tabs building at once: one plan, not two', () => {
  it('two rebuilds started from the same read — the second is refused and writes nothing', async () => {
    const db = seeded();
    const model = heldModel();
    const first = post({ action: 'build', rebuild: true });
    const second = post({ action: 'build', rebuild: true });
    await model.waitFor(2);

    model.answer(0, 'Park');
    expect((await first).status).toBe(200);
    model.answer(1, 'Zoo');
    const refused = await second;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'trip_changed' });

    expect(named(db, 'Park')).toHaveLength(1);
    expect(named(db, 'Zoo')).toHaveLength(0);
    expect(ids(db, 'vacation_activities')).toEqual(['act-hand', named(db, 'Park')[0].id].sort());
  });

  it('two first builds — one plan and one master packing list', async () => {
    const db = seeded({ plan: 'none' });
    const model = heldModel();
    const first = post({ action: 'build' });
    const second = post({ action: 'build' });
    await model.waitFor(2);

    model.answer(0, 'Park');
    expect((await first).status).toBe(200);
    model.answer(1, 'Zoo');
    expect((await second).status).toBe(409);

    expect(rows(db, 'vacation_activities').map((r) => r.name)).toEqual(['Park']);
    expect(rows(db, 'vacation_itinerary_items')).toHaveLength(2);
    expect(rows(db, 'vacation_packing_lists')).toHaveLength(1);
  });

  it('a build that starts after another has finished sees its plan (the ordinary 409)', async () => {
    const db = seeded({ plan: 'none' });
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    expect((await post({ action: 'build' })).status).toBe(200);
    const again = await post({ action: 'build' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'has_plan', replaces: true });
    expect(rows(db, 'vacation_activities')).toHaveLength(1);
  });

  it('PINNED LIMIT: a request that read the trip after another\'s claim, while that other was still writing, is not fenced', async () => {
    // The claim is a compare-and-set, not a lock held for the whole write. B
    // reads the trip after A has claimed it; A's itinerary insert is still in
    // flight when B claims (nothing has moved `updated_at` since A did), so B
    // passes, replaces A's activities, and A's items then land beside B's
    // plan. Closing this needs the replace in ONE transaction (SQL: see the
    // fix report). Until then this is the behaviour, stated rather than hidden.
    const db = seeded({ plan: 'none' });
    let releaseA!: () => void;
    const aWriting = new Promise<void>((resolve) => { releaseA = resolve; });
    let aReachedItems!: () => void;
    const aAtItems = new Promise<void>((resolve) => { aReachedItems = resolve; });
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const insert = builder.insert.bind(builder);
      builder.insert = ((value: Row[]) => {
        const query = insert(value);
        if (!value.some((row) => String(row.title).startsWith('A '))) return query;
        const run = query.then.bind(query);
        aReachedItems();
        Object.assign(query, { then: (ok: never, ko: never) => aWriting.then(() => run(ok, ko)) });
        return query;
      }) as never;
    });

    const model = heldModel();
    const a = post({ action: 'build', rebuild: true });
    await model.waitFor(1);
    model.answer(0, 'A');
    await aAtItems;
    // B starts now: after A's claim, before A's items are in.
    const b = post({ action: 'build', rebuild: true });
    await model.waitFor(2);
    model.answer(1, 'B');
    expect((await b).status).toBe(200);
    releaseA();
    expect((await a).status).toBe(200);

    expect(rows(db, 'vacation_activities').map((r) => r.name)).toEqual(['B']);
    const titles = rows(db, 'vacation_itinerary_items').map((r) => String(r.title)).sort();
    expect(titles).toEqual(['A afternoon', 'A morning', 'B afternoon', 'B morning']);
  });
});

/** The assistant's `trips.buildPlan`, with a model that answers `reply`. */
const structured = (reply: unknown): AIProvider => ({
  id: 'fake', model: 'fake',
  structuredCompletion: async () => ({ text: JSON.stringify(reply), refusal: null, usage: null }),
} as unknown as AIProvider);
const scope = (db: InMemorySupabase): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/Chicago',
});

describe('whether a rebuild would replace anything is said, not promised', () => {
  it('a plan the assistant drafted (trips.buildPlan) is stamped, so "Replace it?" is offered and a confirmed rebuild replaces it', async () => {
    const db = seeded({ plan: 'none' });
    const drafted = await buildPlan(scope(db), TRIP, { provider: structured({
      activities: [{ name: 'Fenway tour', category: 'tour', location: null, family_friendly: true, cost_usd: 30 }],
      itinerary: [{ day: 1, day_part: 'morning', title: 'Fenway tour', kind: 'activity' }],
      budget: [],
    }) });
    expect(drafted).toMatchObject({ ok: true, data: { built: true } });
    expect([...rows(db, 'vacation_activities'), ...rows(db, 'vacation_itinerary_items')].every((r) => r.notes === CONCIERGE_PLAN_MARKER)).toBe(true);

    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    const asked = await post({ action: 'build' });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ code: 'has_plan', replaces: true });

    expect((await post({ action: 'build', rebuild: true })).status).toBe(200);
    expect(rows(db, 'vacation_activities').map((r) => r.name)).toEqual(['Park']);
    expect(rows(db, 'vacation_itinerary_items').map((r) => r.title)).not.toContain('Fenway tour');
  });

  it('a plan with no stamp (by hand, or built before the stamp) is not offered as a replacement, and a confirmed build adds alongside it', async () => {
    const db = seeded({ plan: 'unstamped' });
    holder.complete.mockResolvedValue({ text: planNamed('Park') });
    const asked = await post({ action: 'build' });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ code: 'has_plan', replaces: false });

    expect((await post({ action: 'build', rebuild: true })).status).toBe(200);
    // Nothing was removed: the new plan sits beside the old one, which is
    // exactly what the "add alongside" question told the parent.
    expect(ids(db, 'vacation_activities')).toEqual(expect.arrayContaining(['act-ai-1', 'act-ai-2', 'act-hand']));
    expect(ids(db, 'vacation_itinerary_items')).toEqual(expect.arrayContaining(['item-ai-1', 'item-ai-2', 'item-ai-3', 'item-hand']));
    expect(named(db, 'Park')).toHaveLength(1);
  });

  it('a stamped suggestion that has since been booked is not something a rebuild would remove', async () => {
    const db = seeded();
    for (const id of ['act-ai-1', 'act-ai-2']) await otherTab(db, 'vacation_activities', id, { booked: true });
    for (const id of ['item-ai-1', 'item-ai-2', 'item-ai-3']) await otherTab(db, 'vacation_itinerary_items', id, { booked: true });
    const asked = await post({ action: 'build' });
    expect(await asked.json()).toMatchObject({ code: 'has_plan', replaces: false });
  });
});
