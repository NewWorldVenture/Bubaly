// School and sports reads: family-scoped windows, open-homework filtering,
// A/B-week timetable resolution, and — the one piece of real logic — weekly
// practice series expanded into the occurrences a week plan actually sees.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { listClasses, listEventsBetween, listHomeworkDue, resolveWindow } from '@/lib/services/school';
import { listPracticesBetween, listTeams } from '@/lib/services/sports';
import { weekParity } from '@/lib/school/timetable';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select'; filters: Record<string, unknown> };
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
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter, in: filter,
      neq: (c: string, v: unknown) => filter(`neq:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z'); // a Saturday

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

describe('resolveWindow', () => {
  it('defaults to the coming week and refuses an inverted or unreadable window', () => {
    const scope = scopeWith({} as SupabaseClient<Database>);
    expect(resolveWindow(scope)).toMatchObject({ ok: true, data: { from: NOW.toISOString(), to: '2026-09-12T12:00:00.000Z' } });
    expect(resolveWindow(scope, { from: '2026-09-10T00:00:00Z', to: '2026-09-01T00:00:00Z' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(resolveWindow(scope, { from: 'tuesday' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('school', () => {
  it('reads school events in the window for the family and optionally one child', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    const res = await listEventsBetween(scopeWith(db), { from: '2026-09-07T00:00:00Z', to: '2026-09-14T00:00:00Z', memberId: 'member-2' });
    expect(res).toMatchObject({ ok: true, data: [] });
    expect(calls[0]).toMatchObject({ table: 'school_events', filters: { family_id: 'fam-1', 'gte:starts_at': '2026-09-07T00:00:00.000Z', 'lte:starts_at': '2026-09-14T00:00:00.000Z', member_id: 'member-2' } });
  });

  it('lists only open homework with a due date by default', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listHomeworkDue(scopeWith(db));
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', 'not:due_at:is': null, status: ['assigned', 'in_progress'] });
    const { db: db2, calls: calls2 } = makeDb(() => ({ data: [], error: null }));
    await listHomeworkDue(scopeWith(db2), { includeDone: true });
    expect(calls2[0].filters.status).toBeUndefined();
  });

  it('resolves A/B weeks and sorts the timetable by day then start time', async () => {
    const week = weekParity(NOW);
    const other = week === 'a' ? 'b' : 'a';
    const cls = (id: string, day: number | null, slot: string | null, pattern: string) => ({
      id, family_id: 'fam-1', member_id: 'member-2', subject: id, teacher: null, room: null, time_slot: slot, day_of_week: day, school_name: null, week_pattern: pattern, created_by: null, created_at: '', updated_at: '',
    });
    const { db, calls } = makeDb(() => ({ data: [cls('late', 1, '1:30 PM', 'all'), cls('early', 1, '9:00', 'all'), cls('other-week', 1, '10:00', other), cls('this-week', 2, '10:00', week), cls('daily', null, null, 'all')], error: null }));
    const res = await listClasses(scopeWith(db), { memberId: 'member-2' });
    expect(res.ok && res.data.map((c) => c.id)).toEqual(['daily', 'early', 'late', 'this-week']);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', member_id: 'member-2' });

    const monday = await listClasses(scopeWith(db), { dayOfWeek: 1 });
    expect(monday.ok && monday.data.map((c) => c.id)).toEqual(['daily', 'early', 'late']);
    expect(await listClasses(scopeWith(db), { dayOfWeek: 9 })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('fails closed on a database error', async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: 'boom' } }));
    expect(await listEventsBetween(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
    expect(await listHomeworkDue(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
    expect(await listClasses(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
  });
});

describe('sports', () => {
  const event = (over: Partial<{ id: string; starts_at: string; ends_at: string | null; recurrence: string; recurrence_until: string | null; title: string }>) => ({
    id: over.id ?? 'e-1', family_id: 'fam-1', member_id: 'member-2', sport: 'soccer', team: 'Tigers', title: over.title ?? 'Practice', event_type: 'practice', location: null,
    starts_at: over.starts_at ?? '2026-08-04T21:00:00.000Z', ends_at: over.ends_at ?? '2026-08-04T22:00:00.000Z',
    recurrence: over.recurrence ?? 'none', recurrence_until: over.recurrence_until ?? null, created_by: null, created_at: '', updated_at: '',
  });

  it('lists active teams for the family', async () => {
    const { db, calls } = makeDb(() => ({ data: [], error: null }));
    await listTeams(scopeWith(db), { memberId: 'member-2' });
    expect(calls[0]).toMatchObject({ table: 'teams', filters: { family_id: 'fam-1', is_active: true, member_id: 'member-2' } });
    const { db: db2, calls: calls2 } = makeDb(() => ({ data: [], error: null }));
    await listTeams(scopeWith(db2), { activeOnly: false });
    expect(calls2[0].filters.is_active).toBeUndefined();
  });

  it('expands a weekly practice into every occurrence inside the window, keeping the source id', async () => {
    const weekly = event({ id: 'series', starts_at: '2026-08-04T21:00:00.000Z', recurrence: 'weekly' });
    const single = event({ id: 'game', title: 'Game', starts_at: '2026-09-12T14:00:00.000Z' });
    const { db, calls } = makeDb((call) => (call.filters.recurrence === 'none' ? { data: [single], error: null } : { data: [weekly], error: null }));
    const res = await listPracticesBetween(scopeWith(db), { from: '2026-09-07T00:00:00Z', to: '2026-09-21T00:00:00Z' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((e) => `${e.id}@${e.starts_at}`)).toEqual([
      'series@2026-09-08T21:00:00.000Z',
      'game@2026-09-12T14:00:00.000Z',
      'series@2026-09-15T21:00:00.000Z',
    ]);
    expect(res.data[0].ends_at).toBe('2026-09-08T22:00:00.000Z');
    // Both reads are family-scoped; the series read looks back a year so an old start still repeats.
    expect(calls.every((c) => c.filters.family_id === 'fam-1')).toBe(true);
    expect(calls.find((c) => c.filters['neq:recurrence'] === 'none')?.filters['gte:starts_at']).toBe('2025-09-20T00:00:00.000Z');
  });

  it('stops a series at recurrence_until', async () => {
    const weekly = event({ id: 'series', starts_at: '2026-08-04T21:00:00.000Z', recurrence: 'weekly', recurrence_until: '2026-09-10T00:00:00.000Z' });
    const { db } = makeDb((call) => (call.filters.recurrence === 'none' ? { data: [], error: null } : { data: [weekly], error: null }));
    const res = await listPracticesBetween(scopeWith(db), { from: '2026-09-07T00:00:00Z', to: '2026-09-21T00:00:00Z' });
    expect(res.ok && res.data.map((e) => e.starts_at)).toEqual(['2026-09-08T21:00:00.000Z']);
  });

  it('fails closed when either read fails', async () => {
    const { db } = makeDb((call) => (call.filters.recurrence === 'none' ? { data: [], error: null } : { data: null, error: { message: 'boom' } }));
    expect(await listPracticesBetween(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
  });
});
