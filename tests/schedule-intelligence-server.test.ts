// lib/schedule/intelligence-server — the family-scoped, fail-closed loader in
// front of the pure per-event model. A chainable query stub mirrors the
// PostgREST builder so the test can pin the scope filter on every read and
// the read boundary: one failed source is an error the caller renders with a
// retry, never a partial model presented as "no conflicts".
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadScheduleIntelligence } from '@/lib/schedule/intelligence-server';

type Reply = { data: unknown; error: unknown };

/** Every builder method returns the chain; awaiting it (or `Promise.all`) resolves the reply. */
function queryChain(reply: Reply, record: (method: string, args: unknown[]) => void) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => { record(method, args); return chain; };
  }
  chain.then = (resolve: (v: Reply) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
  return chain;
}

function fakeSupabase(replies: Record<string, Reply>) {
  const calls: Record<string, { method: string; args: unknown[] }[]> = {};
  const db = {
    from: (table: string) => {
      calls[table] ??= [];
      return queryChain(replies[table] ?? { data: [], error: null }, (method, args) => calls[table].push({ method, args }));
    },
  } as unknown as SupabaseClient<Database>;
  return { db, calls };
}

const TZ = 'America/New_York';
const NOW = new Date('2026-09-05T14:00:00Z');
const FAMILY = 'fam-1';
const TABLES = ['calendar_events', 'family_members', 'rides', 'vehicles', 'meal_plans', 'babysitter_payments', 'departure_plans'];

const soccer = { id: 'A', title: 'Soccer game', category: 'sports', location: 'City Fields', starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:30:00Z', all_day: false, assignee_id: 'kid', description: null };
const momBusy = { id: 'M', title: 'Work call', category: 'general', location: null, starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:00:00Z', all_day: false, assignee_id: 'mom', description: null };
const members = [
  { id: 'mom', display_name: 'Maria Rivera', role: 'parent', is_active: true },
  { id: 'kid', display_name: 'Emma Rivera', role: 'child', is_active: true },
];

describe('loadScheduleIntelligence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('scopes every read to the family and composes the model from the rows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, calls } = fakeSupabase({
      calendar_events: { data: [soccer, momBusy], error: null },
      family_members: { data: members, error: null },
      vehicles: { data: [{ id: 'v1', nickname: 'Odyssey', primary_driver: null }], error: null },
      meal_plans: { data: [{ plan_date: '2026-09-05', meal_type: 'dinner', meal_id: 'm1' }], error: null },
      departure_plans: { data: [{ event_id: 'A', drive_seconds: 1200, traffic_factor: 1, weather_delay_minutes: 0, prep_minutes: 15, park_minutes: 5, buffer_minutes: 5, updated_at: '2026-09-04T00:00:00Z' }], error: null },
    });

    const res = await loadScheduleIntelligence(db, { familyId: FAMILY, tz: TZ, now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const table of TABLES) {
      expect(calls[table], table).toBeDefined();
      expect(calls[table].some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === FAMILY), `${table} is family-scoped`).toBe(true);
    }
    // The persisted departure plan is the drive-time source: 15:00 − 5 − 5 − 20 = 14:30 local.
    expect(res.data.departures.A).toEqual({ leaveByISO: '2026-09-05T18:30:00.000Z', travelMinutes: 30, source: 'drive_time' });
    // Mom is busy and no sitter is booked → the child's game is a care gap.
    expect(res.data.byEvent.A?.map((i) => i.kind)).toEqual(['care_gap', 'leave_by']);
    expect(err).not.toHaveBeenCalled();
  });

  it('turns a sitter booked for the event into coverage', async () => {
    const { db } = fakeSupabase({
      calendar_events: { data: [soccer, momBusy], error: null },
      family_members: { data: members, error: null },
      babysitter_payments: { data: [{ id: 'p1', babysitter_id: 's1', event_id: 'A' }, { id: 'p2', babysitter_id: 's2', event_id: 'elsewhere' }], error: null },
    });
    const res = await loadScheduleIntelligence(db, { familyId: FAMILY, tz: TZ, now: NOW });
    expect(res.ok && res.data.byEvent.A?.map((i) => i.kind)).toEqual(['leave_by']);
  });

  it('tries an injected drive-time fetcher before the persisted plans', async () => {
    const { db } = fakeSupabase({
      calendar_events: { data: [soccer], error: null },
      family_members: { data: members, error: null },
      departure_plans: { data: [{ event_id: 'A', drive_seconds: 1200, updated_at: '2026-09-04T00:00:00Z' }], error: null },
    });
    const live = vi.fn(async () => ({ driveSeconds: 600, source: 'routed' as const }));
    const res = await loadScheduleIntelligence(db, { familyId: FAMILY, tz: TZ, now: NOW, driveTime: live });
    expect(live).toHaveBeenCalledTimes(1);
    // 15:00 − 5 − 5 − 10 = 14:40 local, from the live source rather than the saved 20-minute plan.
    expect(res.ok && res.data.departures.A).toEqual({ leaveByISO: '2026-09-05T18:40:00.000Z', travelMinutes: 20, source: 'drive_time' });
  });

  it('fails closed on any read error, naming the source, instead of answering with a partial model', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readError = { message: 'permission denied for table rides', code: '42501' };
    const { db } = fakeSupabase({
      calendar_events: { data: [soccer, momBusy], error: null },
      family_members: { data: members, error: null },
      rides: { data: null, error: readError },
    });
    const res = await loadScheduleIntelligence(db, { familyId: FAMILY, tz: TZ, now: NOW });
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect(res.ok ? '' : res.error).toBeTruthy();
    expect(err.mock.calls.map((c) => c[0])).toContain('[schedule] rides read failed');
  });
});
