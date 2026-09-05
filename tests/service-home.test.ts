// Home service: the trade inference is pure and must be explainable; the
// contractor and service-history reads must filter family and soft deletes;
// "who did we use last" must find the right record by contractor trade,
// asset category or text; and the writes must land in the 0036 columns.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  createMaintenanceTask, createServiceRecord, lastServiceByTrade, listContractors, listOpenMaintenance, normalizeTrade, saveContractor,
  scheduleRecommendedTasks, tradeFromIssue,
} from '@/lib/services/home';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter, in: filter,
      neq: (c: string, v: unknown) => filter(`neq:${c}`, v),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

const CONTRACTOR = {
  id: 'c-1', family_id: 'fam-1', name: 'Bob Pipes', trade: 'plumbing', company: null, phone: '555-0100', email: null, website: null, rating: 5,
  hourly_rate: null, is_preferred: true, last_used_on: '2026-03-01', notes: null, created_by: 'auth-1', updated_by: null, deleted_at: null, metadata: {},
  created_at: '', updated_at: '',
};

describe('tradeFromIssue (pure)', () => {
  it.each([
    ['the kitchen sink is leaking', 'plumbing'],
    ['toilet keeps running and the drain is clogged', 'plumbing'],
    ['outlet in the bedroom is sparking', 'electrical'],
    ['furnace is not heating the house', 'hvac'],
    ['shingles blew off the roof in the storm', 'roofing'],
    ['the dishwasher will not drain', 'appliance'],
    ['we have ants in the pantry', 'pest'],
    ['need the lawn mowed and hedges trimmed', 'landscaping'],
    ['garage door is stuck halfway', 'general'],
    ['water heater is making a banging noise', 'plumbing'],
  ])('%s → %s', (issue, trade) => {
    const out = tradeFromIssue(issue);
    expect(out.trade).toBe(trade);
    expect(out.matched.length).toBeGreaterThan(0);
    expect(out.confidence).toBeGreaterThan(0.4);
  });

  it('prefers the more specific trade when a shared word could go either way', () => {
    // "dishwasher will not drain": 'drain' is plumbing, 'dishwasher' is appliance — one hit each; appliance is the specific trade for the named machine.
    const out = tradeFromIssue('the dishwasher will not drain');
    expect(out.trade).toBe('appliance');
    expect(out.confidence).toBeLessThan(1);
  });

  it('returns null with zero confidence when nothing points at a trade', () => {
    expect(tradeFromIssue('help me plan dinner')).toEqual({ trade: null, label: null, confidence: 0, matched: [] });
    expect(tradeFromIssue('')).toEqual({ trade: null, label: null, confidence: 0, matched: [] });
  });

  it('normalises a trade value, label or issue text to the canonical value', () => {
    expect(normalizeTrade('plumbing')).toBe('plumbing');
    expect(normalizeTrade('Appliance Repair')).toBe('appliance');
    expect(normalizeTrade('HVAC')).toBe('hvac');
    expect(normalizeTrade('leaky faucet')).toBe('plumbing');
    expect(normalizeTrade('')).toBeNull();
  });
});

describe('contractors', () => {
  it('lists live contractors for the family, filtered by a normalised trade', async () => {
    const { db, calls } = makeDb(() => ({ data: [CONTRACTOR], error: null }));
    const res = await listContractors(scopeWith(db), { trade: 'Plumbing' });
    expect(res).toMatchObject({ ok: true, data: [{ id: 'c-1' }] });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', deleted_at: null, trade: 'plumbing' });
  });

  it('refuses an unknown trade rather than returning everyone', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    expect(await listContractors(scopeWith(db), { trade: 'wizardry' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('saves a new contractor with the 0036 columns and the auth user id', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: CONTRACTOR, error: null } : { data: null, error: null }));
    const res = await saveContractor(scopeWith(db), { name: ' Bob Pipes ', trade: 'plumber', phone: '555-0100', rating: 5, isPreferred: true });
    expect(res).toMatchObject({ ok: true, data: { created: true } });
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('home_contractors');
    expect(insert?.payload).toMatchObject({ family_id: 'fam-1', name: 'Bob Pipes', trade: 'plumbing', phone: '555-0100', rating: 5, is_preferred: true, created_by: 'auth-1', updated_by: 'auth-1' });
  });

  it('updates rather than duplicates when a live contractor has the same name', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'update' ? { data: { ...CONTRACTOR, phone: '555-0199' }, error: null } : { data: { id: 'c-1' }, error: null }));
    const res = await saveContractor(scopeWith(db), { name: 'bob pipes', phone: '555-0199' });
    expect(res).toMatchObject({ ok: true, data: { created: false } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls.find((c) => c.kind === 'update')?.filters).toMatchObject({ id: 'c-1', family_id: 'fam-1' });
  });

  it('rejects a rating outside 1–5', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await saveContractor(scopeWith(db), { name: 'Bob', rating: 7 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('lastServiceByTrade', () => {
  const RECORDS = [
    { id: 'r-3', family_id: 'fam-1', home_id: null, asset_id: null, contractor_id: null, title: 'Gutter cleaning', service_date: '2026-08-01', provider: 'Leaf Guys', cost: 150, description: null, next_due_on: null, created_by: null, updated_by: null, deleted_at: null, metadata: {}, created_at: '', updated_at: '' },
    { id: 'r-2', family_id: 'fam-1', home_id: null, asset_id: 'a-1', contractor_id: null, title: 'Annual flush', service_date: '2026-05-01', provider: null, cost: 120, description: null, next_due_on: null, created_by: null, updated_by: null, deleted_at: null, metadata: {}, created_at: '', updated_at: '' },
    { id: 'r-1', family_id: 'fam-1', home_id: null, asset_id: null, contractor_id: 'c-1', title: 'Fixed leak under sink', service_date: '2026-03-01', provider: null, cost: 200, description: null, next_due_on: null, created_by: null, updated_by: null, deleted_at: null, metadata: {}, created_at: '', updated_at: '' },
  ];
  const respond = (call: Call): Reply => {
    if (call.table === 'home_service_records') return { data: RECORDS, error: null };
    if (call.table === 'home_contractors') return { data: [CONTRACTOR], error: null };
    if (call.table === 'home_assets') return { data: [{ id: 'a-1', category: 'water_heater' }], error: null };
    return { data: null, error: null };
  };

  it('finds the most recent plumbing service via the asset category before the older contractor-linked one', async () => {
    const { db, calls } = makeDb(respond);
    const res = await lastServiceByTrade(scopeWith(db), 'plumbing');
    expect(res).toMatchObject({ ok: true, data: { record: { id: 'r-2' }, matchedBy: 'asset_category' } });
    expect(calls.every((c) => c.filters.family_id === 'fam-1')).toBe(true);
    expect(calls.filter((c) => c.table !== 'home_assets').every((c) => c.filters.deleted_at === null)).toBe(true);
  });

  it('matches by the linked contractor and returns them', async () => {
    const { db } = makeDb((call) => (call.table === 'home_assets' ? { data: [], error: null } : respond(call)));
    const res = await lastServiceByTrade(scopeWith(db), 'sink is leaking');
    expect(res).toMatchObject({ ok: true, data: { record: { id: 'r-1' }, contractor: { name: 'Bob Pipes' }, matchedBy: 'contractor_trade' } });
  });

  it('falls back to the record text and returns null honestly when nothing matches', async () => {
    const { db } = makeDb(respond);
    expect(await lastServiceByTrade(scopeWith(db), 'general')).toMatchObject({ ok: true, data: { record: { id: 'r-3' }, matchedBy: 'text' } });
    expect(await lastServiceByTrade(scopeWith(db), 'pest')).toMatchObject({ ok: true, data: null });
  });

  it('fails closed when any read fails', async () => {
    const { db } = makeDb((call) => (call.table === 'home_contractors' ? { data: null, error: { message: 'boom' } } : respond(call)));
    expect(await lastServiceByTrade(scopeWith(db), 'plumbing')).toMatchObject({ ok: false, code: 'db' });
  });
});

describe('service records and maintenance tasks', () => {
  it('logs a service record and refreshes the asset and contractor dates best-effort', async () => {
    const record = { id: 'r-9', family_id: 'fam-1', home_id: null, asset_id: 'a-1', contractor_id: 'c-1', title: 'Flushed heater', service_date: '2026-09-05', provider: null, cost: 100, description: null, next_due_on: null, created_by: 'auth-1', updated_by: null, deleted_at: null, metadata: {}, created_at: '', updated_at: '' };
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: record, error: null } : { data: null, error: null }));
    const res = await createServiceRecord(scopeWith(db), { title: 'Flushed heater', assetId: 'a-1', contractorId: 'c-1', cost: 100 });
    expect(res).toMatchObject({ ok: true, data: { id: 'r-9' } });
    expect(calls.find((c) => c.kind === 'insert')?.payload).toMatchObject({ family_id: 'fam-1', title: 'Flushed heater', service_date: '2026-09-05', asset_id: 'a-1', contractor_id: 'c-1', cost: 100, created_by: 'auth-1' });
    const updates = calls.filter((c) => c.kind === 'update');
    expect(updates.map((u) => u.table).sort()).toEqual(['home_assets', 'home_contractors']);
    expect(updates.every((u) => u.filters.family_id === 'fam-1')).toBe(true);
  });

  it('creates a maintenance task with a normalised due instant and the assignee', async () => {
    const task = { id: 'm-1', family_id: 'fam-1', asset_id: null, title: 'Replace air filter', description: null, status: 'todo', priority: 'medium', recurrence: 'none', interval_days: 90, due_at: '2026-09-12T13:00:00.000Z', completed_at: null, assignee_id: 'member-2', created_by: 'auth-1', created_at: '', updated_at: '' };
    const { db, calls } = makeDb((call) => (call.kind === 'insert' ? { data: task, error: null } : { data: null, error: null }));
    const res = await createMaintenanceTask(scopeWith(db), { title: 'Replace air filter', dueAt: '2026-09-12T09:00:00-04:00', assigneeId: 'member-2', intervalDays: 90 });
    expect(res).toMatchObject({ ok: true, data: { id: 'm-1' } });
    expect(calls.find((c) => c.kind === 'insert')?.payload).toMatchObject({ family_id: 'fam-1', title: 'Replace air filter', due_at: '2026-09-12T13:00:00.000Z', assignee_id: 'member-2', interval_days: 90, priority: 'medium', created_by: 'auth-1' });
  });

  it('returns the open task with the same title instead of a second one on a retry', async () => {
    const task = { id: 'm-1', family_id: 'fam-1', asset_id: null, title: 'Clean gutters', description: null, status: 'todo', priority: 'medium', recurrence: 'none', interval_days: null, due_at: null, completed_at: null, assignee_id: null, created_by: 'auth-1', created_at: '', updated_at: '' };
    const { db, calls } = makeDb(() => ({ data: task, error: null }));
    const res = await createMaintenanceTask(scopeWith(db, { runId: 'run-1' }), { title: 'clean gutters' });
    expect(res).toMatchObject({ ok: true, data: { id: 'm-1' } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', 'neq:status': 'done', asset_id: null });
  });

  it('rejects an unparseable due date and a bad interval before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await createMaintenanceTask(scopeWith(db), { title: 'x', dueAt: 'soonish' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await createMaintenanceTask(scopeWith(db), { title: 'x', intervalDays: 0 })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('lists open tasks scoped to the family and an optional due bound', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    const res = await listOpenMaintenance(scopeWith(db), { dueBefore: '2026-09-30T00:00:00Z' });
    expect(res).toMatchObject({ ok: true, data: [] });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', 'neq:status': 'done', 'lte:due_at': '2026-09-30T00:00:00.000Z' });
  });

  it('schedules only the recommended tasks the asset does not already have', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'home_assets') return { data: { id: 'a-1', name: 'Furnace', category: 'hvac', last_serviced_on: '2026-06-01' }, error: null };
      if (call.table === 'maintenance_tasks' && call.kind === 'select') return { data: [{ title: 'Replace air filter' }], error: null };
      if (call.table === 'maintenance_tasks' && call.kind === 'insert') return { data: (call.payload as unknown[]).map((row, i) => ({ ...(row as object), id: `m-${i}` })), error: null };
      return { data: null, error: null };
    });
    const res = await scheduleRecommendedTasks(scopeWith(db), 'a-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skipped).toEqual(['Replace air filter']);
    expect(res.data.created.map((t) => t.title)).toEqual(['Professional HVAC service / tune-up']);
    const insert = calls.find((c) => c.kind === 'insert');
    expect((insert?.payload as { due_at: string }[])[0].due_at.slice(0, 10)).toBe('2027-06-01');
  });
});
