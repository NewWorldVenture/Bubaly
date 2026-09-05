// Trips: the service composes fifteen vacation tables plus the calendar,
// school, sports and family services, so it is tested against an in-memory
// table store rather than a scripted reply — the behaviours that matter are
// which rows END UP in which tables: per-traveler packing lists that skip what
// is already packed, an all-day calendar span in the trip's own timezone that
// is never duplicated, paperwork risks with the right severity, a plan that
// is persisted whole or rolled back whole, and reads that fail closed.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import {
  buildPlan, commitmentConflicts, computeReadiness, documentRisksFor, findOrCreateVacation, generatePackingList, getTrip, listTrips,
  syncToCalendar, type TripSnapshot,
} from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';

type Row = Record<string, unknown>;
type Op = { table: string; kind: 'select' | 'insert' | 'update' | 'delete' | 'upsert'; filters: Record<string, unknown>; payload?: unknown };

/**
 * A table store that honours the filters the services use, so a test can
 * seed rows and assert on what remains afterwards. `failTables` makes a read
 * of those tables return an error, for the fail-closed cases.
 */
function makeStore(seed: Record<string, Row[]> = {}, opts: { failTables?: string[]; failInsert?: string[] } = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  const ops: Op[] = [];
  let counter = 0;
  const rowsOf = (table: string) => { if (!tables.has(table)) tables.set(table, []); return tables.get(table)!; };
  const matches = (row: Row, filters: Record<string, unknown>) => Object.entries(filters).every(([key, value]) => {
    const [op, col] = key.includes(':') ? key.split(':') : ['eq', key];
    const actual = row[col] as string | number | null;
    switch (op) {
      case 'eq': return actual === value;
      case 'neq': return actual !== value;
      case 'in': return (value as unknown[]).includes(actual);
      case 'is': return actual === value;
      case 'gte': return actual != null && String(actual) >= String(value);
      case 'lte': return actual != null && String(actual) <= String(value);
      case 'notnull': return actual !== null && actual !== undefined;
      case 'ilike': return String(actual ?? '').toLowerCase().includes(String(value).replace(/%/g, '').replace(/\\/g, '').toLowerCase());
      default: return true;
    }
  });
  const from = (table: string) => {
    const op: Op = { table, kind: 'select', filters: {} };
    ops.push(op);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (key: string, value: unknown) => { op.filters[key] = value; return b; };
    const run = (): { data: unknown; error: unknown } => {
      if (opts.failTables?.includes(table) && op.kind === 'select') return { data: null, error: { message: `${table} unavailable` } };
      const rows = rowsOf(table);
      if (op.kind === 'select') return { data: rows.filter((r) => matches(r, op.filters)), error: null };
      if (op.kind === 'insert' || op.kind === 'upsert') {
        if (opts.failInsert?.includes(table)) return { data: null, error: { message: `${table} insert failed` } };
        const payload = (Array.isArray(op.payload) ? op.payload : [op.payload]) as Row[];
        const out: Row[] = [];
        for (const p of payload) {
          const existing = op.kind === 'upsert' ? rows.find((r) => r.vacation_id === p.vacation_id && r.category === p.category) : null;
          if (existing) { Object.assign(existing, p); out.push(existing); continue; }
          const row = { id: `${table}-${++counter}`, created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z', ...p };
          rows.push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      if (op.kind === 'update') {
        const hit = rows.filter((r) => matches(r, op.filters));
        for (const r of hit) Object.assign(r, op.payload as Row);
        return { data: hit, error: null };
      }
      const gone = rows.filter((r) => matches(r, op.filters));
      tables.set(table, rows.filter((r) => !gone.includes(r)));
      return { data: gone, error: null };
    };
    const single = () => { const res = run(); return Promise.resolve({ data: Array.isArray(res.data) ? res.data[0] ?? null : res.data, error: res.error }); };
    Object.assign(b, {
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      neq: (c: string, v: unknown) => filter(`neq:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      not: (c: string) => filter(`notnull:${c}`, true),
      insert: (payload: unknown) => { op.kind = 'insert'; op.payload = payload; return b; },
      upsert: (payload: unknown) => { op.kind = 'upsert'; op.payload = payload; return b; },
      update: (payload: unknown) => { op.kind = 'update'; op.payload = payload; return b; },
      delete: () => { op.kind = 'delete'; return b; },
      single, maybeSingle: single,
      then: (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(run()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, ops, rows: rowsOf };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW, ...extra };
}

const TRIP: Row = {
  id: 'v-1', family_id: 'fam-1', title: 'Lisbon', kind: 'international', status: 'planning', destination: 'Lisbon, Portugal',
  start_date: '2026-10-10', end_date: '2026-10-17', timezone: 'America/New_York', cover_image_url: null, description: null,
  budget_cents: 500000, currency: 'USD', is_international: true, notes: null, created_by: 'auth-1', created_at: '', updated_at: '',
};

const MEMBERS: Row[] = [
  { id: 'member-1', family_id: 'fam-1', user_id: 'auth-1', display_name: 'Dana', role: 'parent', birthday: '1985-04-02', is_active: true, color: null, avatar_url: null, created_at: '2026-01-01' },
  { id: 'member-2', family_id: 'fam-1', user_id: null, display_name: 'Ava', role: 'child', birthday: '2019-06-01', is_active: true, color: null, avatar_url: null, created_at: '2026-01-02' },
];
const TRAVELERS: Row[] = [
  { id: 'vm-1', family_id: 'fam-1', vacation_id: 'v-1', member_id: 'member-1', role: 'adult', guest_name: null },
  { id: 'vm-2', family_id: 'fam-1', vacation_id: 'v-1', member_id: 'member-2', role: 'child', guest_name: null },
];

const seedTrip = (extra: Record<string, Row[]> = {}) => ({ vacations: [TRIP], family_members: MEMBERS, vacation_members: TRAVELERS, ...extra });

describe('getTrip / listTrips', () => {
  it('reads every child table scoped by family and trip', async () => {
    const store = makeStore(seedTrip());
    const res = await getTrip(scopeWith(store.db), 'v-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.nights).toBe(7);
    expect(res.data.hasChildren).toBe(true);
    const childReads = store.ops.filter((o) => o.table.startsWith('vacation_'));
    expect(childReads).toHaveLength(15);
    expect(childReads.every((o) => o.filters.family_id === 'fam-1' && o.filters.vacation_id === 'v-1')).toBe(true);
  });

  it('reports a foreign trip as not found and fails closed when a child table fails', async () => {
    const missing = makeStore(seedTrip());
    expect(await getTrip(scopeWith(missing.db), 'v-other')).toMatchObject({ ok: false, code: 'not_found' });
    const broken = makeStore(seedTrip(), { failTables: ['vacation_flights'] });
    expect(await getTrip(scopeWith(broken.db), 'v-1')).toMatchObject({ ok: false, code: 'db' });
  });

  it('lists live trips only unless asked for finished ones', async () => {
    const store = makeStore({ vacations: [TRIP, { ...TRIP, id: 'v-old', status: 'completed' }] });
    const live = await listTrips(scopeWith(store.db));
    expect(live.ok && live.data.map((t) => t.id)).toEqual(['v-1']);
    const all = await listTrips(scopeWith(store.db), { includeFinished: true });
    expect(all.ok && all.data).toHaveLength(2);
  });
});

describe('findOrCreateVacation', () => {
  it('finds the live trip the request names when the dates do not contradict it', async () => {
    const store = makeStore({ vacations: [TRIP] });
    const res = await findOrCreateVacation(scopeWith(store.db), { destination: 'lisbon', startDate: '2026-10-12' });
    expect(res).toMatchObject({ ok: true, data: { created: false, vacation: { id: 'v-1' } } });
    expect(store.rows('vacations')).toHaveLength(1);
  });

  it('creates a trip with a sensible title, kind and cents when nothing matches', async () => {
    const store = makeStore({ vacations: [TRIP] });
    const res = await findOrCreateVacation(scopeWith(store.db), { destination: 'Tokyo', startDate: '2027-03-01', endDate: '2027-03-10', isInternational: true, budget: 4200.5 });
    expect(res).toMatchObject({ ok: true, data: { created: true, vacation: { title: 'Trip to Tokyo', kind: 'international', is_international: true, budget_cents: 420050, timezone: 'America/New_York', created_by: 'auth-1' } } });
    expect(store.rows('vacations')).toHaveLength(2);
    expect(store.rows('agent_activity')).toHaveLength(1);
  });

  it('does not match a same-named trip on different dates, and refuses bad input', async () => {
    const store = makeStore({ vacations: [TRIP] });
    const res = await findOrCreateVacation(scopeWith(store.db), { destination: 'Lisbon', startDate: '2027-06-01', endDate: '2027-06-05' });
    expect(res).toMatchObject({ ok: true, data: { created: true } });
    expect(await findOrCreateVacation(scopeWith(store.db), {})).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await findOrCreateVacation(scopeWith(store.db), { title: 'x', startDate: '2027-06-05', endDate: '2027-06-01' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await findOrCreateVacation(scopeWith(store.db), { title: 'x', startDate: 'June' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('generatePackingList', () => {
  it('builds one list per traveler, tailored by age, and skips what is already packed on a re-run', async () => {
    const store = makeStore(seedTrip({
      vacation_weather_snapshots: [{ id: 'w-1', family_id: 'fam-1', vacation_id: 'v-1', forecast_date: '2026-10-10', temp_high_c: 30, temp_low_c: 18, precip_prob: 70 }],
    }));
    const first = await generatePackingList(scopeWith(store.db), 'v-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.lists.map((l) => l.name)).toEqual(["Dana's list", "Ava's list"]);
    const dana = first.data.lists[0].items.map((i) => i.name);
    const ava = first.data.lists[1].items.map((i) => i.name);
    expect(dana).toEqual(expect.arrayContaining(['Passport', 'Travel adapter', 'Sunscreen', 'Umbrella', 'Deodorant']));
    expect(ava).toEqual(expect.arrayContaining(['Passport', 'Kids snacks', 'Activity / coloring books']));
    expect(ava).not.toContain('Deodorant');
    expect(ava).not.toContain('Travel adapter');
    expect(store.rows('vacation_packing_lists').map((l) => l.member_id)).toEqual(['member-1', 'member-2']);
    expect(store.rows('vacation_packing_items').every((i) => i.family_id === 'fam-1' && i.vacation_id === 'v-1' && i.ai_suggested === true)).toBe(true);

    const before = store.rows('vacation_packing_items').length;
    const again = await generatePackingList(scopeWith(store.db), 'v-1');
    expect(again.ok && again.data.lists.every((l) => l.added === 0 && l.skipped > 0)).toBe(true);
    expect(store.rows('vacation_packing_items')).toHaveLength(before);
    expect(store.rows('vacation_packing_lists')).toHaveLength(2);
  });

  it('falls back to one master list when the trip has no travelers, and honours a single member', async () => {
    const store = makeStore({ vacations: [TRIP], family_members: MEMBERS, vacation_members: [] });
    const master = await generatePackingList(scopeWith(store.db), 'v-1');
    expect(master.ok && master.data.lists.map((l) => [l.name, l.memberId])).toEqual([['Master list', null]]);
    expect(store.rows('vacation_packing_lists')[0]).toMatchObject({ is_master: true, member_id: null });

    const one = await generatePackingList(scopeWith(store.db), 'v-1', { memberId: 'member-2' });
    expect(one.ok && one.data.lists.map((l) => l.name)).toEqual(["Ava's list"]);
    expect(await generatePackingList(scopeWith(store.db), 'v-1', { memberId: 'nobody' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('documents and readiness', () => {
  const snapshotWith = (documents: Row[]): TripSnapshot => ({
    trip: TRIP as unknown as TripSnapshot['trip'],
    travelers: TRAVELERS as unknown as TripSnapshot['travelers'],
    documents: documents as unknown as TripSnapshot['documents'],
    lodging: [], flights: [], transport: [], activities: [], reservations: [], budgets: [], expenses: [], packingLists: [], packingItems: [],
    emergencyContacts: [], days: [], items: [], weather: [], nights: 7, hasChildren: true,
    budgetSummary: { planned_cents: 0, spent_cents: 0, remaining_cents: 0, pct: 0, over: false, categories: [] },
  });
  const members = MEMBERS.map((m) => ({ id: m.id as string, userId: null, displayName: m.display_name as string, role: 'parent' as const, birthday: null, age: null, isActive: true, canManage: true, hasLogin: false, color: null, avatarUrl: null }));

  it('flags a missing passport, one expiring within six months of return, and a ticket expiring mid-trip', () => {
    const risks = documentRisksFor(snapshotWith([
      { id: 'vd-1', vacation_id: 'v-1', kind: 'passport', title: 'Dana passport', member_id: 'member-1', expires_on: '2027-01-10' },
      { id: 'vd-2', vacation_id: 'v-1', kind: 'ticket', title: 'Museum pass', member_id: null, expires_on: '2026-10-12' },
    ]), members);
    expect(risks.map((r) => [r.kind, r.memberId, r.severity])).toEqual([
      ['missing_passport', 'member-2', 3],
      ['passport_expiring', 'member-1', 2],
      ['document_expiring', null, 2],
    ]);
    expect(risks[1].title).toMatch(/Dana's passport expires 2027-01-10/);
  });

  it('reports nothing for a domestic trip with valid documents', () => {
    const domestic = snapshotWith([]);
    domestic.trip = { ...domestic.trip, is_international: false };
    expect(documentRisksFor(domestic, members)).toEqual([]);
  });

  it('scores readiness from the rows and carries the document risks and budget through', async () => {
    const store = makeStore(seedTrip({
      vacation_lodging: [{ id: 'l-1', family_id: 'fam-1', vacation_id: 'v-1', name: 'Hotel', booked: true }],
      vacation_flights: [{ id: 'f-1', family_id: 'fam-1', vacation_id: 'v-1', booked: false, depart_at: null }],
      vacation_budgets: [{ id: 'b-1', family_id: 'fam-1', vacation_id: 'v-1', category: 'lodging', planned_cents: 100000 }],
      vacation_expenses: [{ id: 'e-1', family_id: 'fam-1', vacation_id: 'v-1', category: 'lodging', amount_cents: 120000 }],
      vacation_documents: [{ id: 'vd-1', family_id: 'fam-1', vacation_id: 'v-1', kind: 'passport', title: 'Dana passport', member_id: 'member-1', expires_on: '2030-01-01' }],
    }));
    const res = await computeReadiness(scopeWith(store.db), 'v-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.score).toBeGreaterThan(0);
    expect(res.data.score).toBeLessThan(100);
    expect(res.data.daysUntil).toBe(35);
    expect(res.data.factors.find((f) => f.key === 'lodging')?.score).toBe(100);
    expect(res.data.factors.find((f) => f.key === 'transport')?.score).toBe(0);
    expect(res.data.documentRisks.map((r) => r.kind)).toEqual(['missing_passport']);
    expect(res.data.budget).toEqual({ plannedCents: 100000, spentCents: 120000, over: true });
    expect(res.data.recommendations.length).toBeGreaterThan(0);
  });
});

describe('syncToCalendar', () => {
  it('adds the trip as an all-day span in the trip timezone plus flights and timed reservations, then skips them all on a second sync', async () => {
    const store = makeStore(seedTrip({
      vacation_flights: [{ id: 'f-1', family_id: 'fam-1', vacation_id: 'v-1', airline: 'TAP', flight_number: 'TP 210', depart_airport: 'JFK', arrive_airport: 'LIS', depart_at: '2026-10-10T22:00:00Z', arrive_at: '2026-10-11T09:30:00Z', confirmation_code: 'ABC123', booked: true }],
      vacation_reservations: [{ id: 'r-1', family_id: 'fam-1', vacation_id: 'v-1', name: 'Dinner at Belcanto', location: 'Chiado', reserved_at: '2026-10-12T19:30:00Z', confirmation_code: null, booked: true }],
    }));
    const res = await syncToCalendar(scopeWith(store.db), 'v-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.created.map((e) => e.title)).toEqual(['Lisbon', 'Flight TAP TP 210 JFK → LIS', 'Dinner at Belcanto']);
    const span = store.rows('calendar_events').find((e) => e.title === 'Lisbon');
    // Midnight Oct 10 in New York is 04:00Z; the span ends at the last instant of Oct 17 local.
    expect(span).toMatchObject({ all_day: true, category: 'holiday', starts_at: '2026-10-10T04:00:00.000Z', ends_at: '2026-10-18T03:59:59.999Z', location: 'Lisbon, Portugal', created_by: 'auth-1', family_id: 'fam-1' });
    expect(store.rows('calendar_events').find((e) => String(e.title).startsWith('Flight'))).toMatchObject({ description: 'Confirmation ABC123', starts_at: '2026-10-10T22:00:00.000Z' });

    const again = await syncToCalendar(scopeWith(store.db), 'v-1');
    expect(again.ok && again.data).toEqual({ created: [], skipped: ['Lisbon', 'Flight TAP TP 210 JFK → LIS', 'Dinner at Belcanto'] });
    expect(store.rows('calendar_events')).toHaveLength(3);
  });

  it('refuses a trip without dates', async () => {
    const store = makeStore(seedTrip({ vacations: [{ ...TRIP, start_date: null, end_date: null }] }));
    expect(await syncToCalendar(scopeWith(store.db), 'v-1')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(store.rows('calendar_events')).toHaveLength(0);
  });
});

describe('commitmentConflicts', () => {
  it('gathers calendar, school, sports, homework and bills inside the trip window, excluding the trip\'s own entries', async () => {
    const store = makeStore(seedTrip({
      calendar_events: [
        { id: 'ce-1', family_id: 'fam-1', title: 'Dentist', starts_at: '2026-10-12T14:00:00.000Z', ends_at: null, all_day: false, assignee_id: 'member-1', category: 'appointment' },
        { id: 'ce-2', family_id: 'fam-1', title: 'Lisbon', starts_at: '2026-10-10T04:00:00.000Z', ends_at: null, all_day: true, assignee_id: null, category: 'holiday' },
        { id: 'ce-3', family_id: 'fam-1', title: 'After trip', starts_at: '2026-10-20T14:00:00.000Z', ends_at: null, all_day: false, assignee_id: null, category: 'general' },
      ],
      school_events: [{ id: 'se-1', family_id: 'fam-1', title: 'Picture day', starts_at: '2026-10-13T13:00:00.000Z', member_id: 'member-2' }],
      sports_events: [{ id: 'sp-1', family_id: 'fam-1', title: 'Soccer', starts_at: '2026-10-14T21:00:00.000Z', ends_at: null, recurrence: 'none', recurrence_until: null, member_id: 'member-2' }],
      homework_assignments: [{ id: 'hw-1', family_id: 'fam-1', title: 'Book report', due_at: '2026-10-15T00:00:00.000Z', status: 'assigned', member_id: 'member-2' }],
      bills: [{ id: 'bill-1', family_id: 'fam-1', name: 'Electric', due_date: '2026-10-15', status: 'upcoming' }, { id: 'bill-2', family_id: 'fam-1', name: 'Paid one', due_date: '2026-10-15', status: 'paid' }],
    }));
    const res = await commitmentConflicts(scopeWith(store.db), 'v-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.total).toBe(5);
    expect(res.data.calendar.map((e) => e.id)).toEqual(['ce-1']);
    expect(res.data.school.map((e) => e.id)).toEqual(['se-1']);
    expect(res.data.sports.map((e) => e.id)).toEqual(['sp-1']);
    expect(res.data.homework.map((e) => e.id)).toEqual(['hw-1']);
    expect(res.data.bills.map((e) => e.id)).toEqual(['bill-1']);
    expect(res.data.window).toEqual({ from: '2026-10-10T04:00:00.000Z', to: '2026-10-18T03:59:59.999Z' });
  });
});

describe('buildPlan', () => {
  const PLAN = {
    activities: [{ name: 'Oceanário', category: 'attraction', location: 'Parque das Nações', family_friendly: true, cost_usd: 60 }, { name: 'Tram 28', category: 'tour', location: null, family_friendly: true, cost_usd: null }],
    itinerary: [
      { day: 1, day_part: 'morning', title: 'Arrive and settle in', kind: 'travel' },
      { day: 2, day_part: 'afternoon', title: 'Oceanário', kind: 'activity' },
      { day: 99, day_part: 'evening', title: 'Farewell dinner', kind: 'meal' },
    ],
    budget: [{ category: 'lodging', planned_usd: 1400 }, { category: 'food', planned_usd: 800 }, { category: 'food', planned_usd: 999 }],
  };
  const provider = (reply: unknown): AIProvider => ({
    id: 'fake', model: 'fake',
    structuredCompletion: async () => ({ text: JSON.stringify(reply), refusal: null, usage: null }),
  } as unknown as AIProvider);

  it('persists activities, itinerary days and items, budget lines and a packing list', async () => {
    const store = makeStore(seedTrip({ vacation_budgets: [{ id: 'b-old', family_id: 'fam-1', vacation_id: 'v-1', category: 'lodging', planned_cents: 100, notes: 'old' }] }));
    const res = await buildPlan(scopeWith(store.db), 'v-1', { provider: provider(PLAN), prompt: 'beaches and one museum' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.built).toBe(true);
    expect(res.data.added).toMatchObject({ activities: 2, items: 3, budget: 2 });
    expect(res.data.added.packing).toBeGreaterThan(0);
    expect(store.rows('vacation_activities').map((a) => [a.name, a.cost_cents])).toEqual([['Oceanário', 6000], ['Tram 28', null]]);
    // Eight trip days are materialised; day 99 is clamped onto the last one.
    expect(store.rows('vacation_itinerary_days')).toHaveLength(8);
    const lastDay = store.rows('vacation_itinerary_days').find((d) => d.day_date === '2026-10-17');
    expect(store.rows('vacation_itinerary_items').find((i) => i.title === 'Farewell dinner')).toMatchObject({ day_id: lastDay?.id, kind: 'meal', day_part: 'evening' });
    expect(store.rows('vacation_budgets').map((b) => [b.category, b.planned_cents])).toEqual([['lodging', 140000], ['food', 99900]]);
    expect(store.rows('vacation_packing_lists')).toHaveLength(1);
    expect(store.rows('vacation_activities').every((a) => a.family_id === 'fam-1' && a.created_by === 'auth-1')).toBe(true);
  });

  it('rolls back everything it wrote when a later insert fails', async () => {
    const store = makeStore(seedTrip(), { failInsert: ['vacation_itinerary_items'] });
    const res = await buildPlan(scopeWith(store.db), 'v-1', { provider: provider(PLAN) });
    expect(res).toMatchObject({ ok: false, code: 'db' });
    expect(store.rows('vacation_activities')).toHaveLength(0);
    expect(store.rows('vacation_itinerary_days')).toHaveLength(0);
    expect(store.rows('vacation_budgets')).toHaveLength(0);
    expect(store.rows('vacation_packing_items')).toHaveLength(0);
    const deletes = store.ops.filter((o) => o.kind === 'delete');
    expect(deletes.every((o) => o.filters.family_id === 'fam-1' && o.filters.vacation_id === 'v-1')).toBe(true);
  });

  it('leaves an existing plan alone unless told to rebuild, and writes nothing when the model fails', async () => {
    const planned = makeStore(seedTrip({ vacation_itinerary_items: [{ id: 'it-1', family_id: 'fam-1', vacation_id: 'v-1', title: 'x', day_id: null, kind: 'activity', day_part: 'morning' }] }));
    const skip = await buildPlan(scopeWith(planned.db), 'v-1', { provider: provider(PLAN) });
    expect(skip).toMatchObject({ ok: true, data: { built: false } });
    expect(planned.rows('vacation_activities')).toHaveLength(0);

    const failing = makeStore(seedTrip());
    const bad = await buildPlan(scopeWith(failing.db), 'v-1', { provider: provider({ nonsense: true }) });
    expect(bad.ok).toBe(false);
    expect(failing.rows('vacation_activities')).toHaveLength(0);
    expect(failing.ops.some((o) => o.kind === 'insert')).toBe(false);
  });
});
