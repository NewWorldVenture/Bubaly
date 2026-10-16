import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listEventsBetween, listHomeworkDue } from '@/lib/services/school';
import { listPracticesBetween } from '@/lib/services/sports';
import type { ServiceScope } from '@/lib/services/types';

// The installed SDK builds every request. This local transport models only the
// SQL predicates used here, at PostgreSQL's microsecond timestamp precision.
// It is not a database/RLS/Auth integration test. Date.parse alone (or lexical
// comparison of .999Z with .999500Z) would conceal this boundary regression.
type Kind = 'events' | 'homework' | 'sports';
type Row = { id: string; family_id: string; member_id: string; [key: string]: unknown };
const table: Record<Kind, string> = { events: 'school_events', homework: 'homework_assignments', sports: 'sports_events' };
const column = (kind: Kind) => kind === 'homework' ? 'due_at' : 'starts_at';
function micros(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match) throw new Error(`Unsupported synthetic timestamp: ${value}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}
function timestamp(value: bigint): string {
  const seconds = value / 1_000_000n;
  return new Date(Number(seconds) * 1000).toISOString().replace('.000Z', `.${String(value % 1_000_000n).padStart(6, '0')}Z`);
}
function row(kind: Kind, id: string, at: string | null, extra: Partial<Row> = {}): Row {
  return { id, family_id: 'family', member_id: 'child', title: id, [column(kind)]: at,
    status: 'assigned', event_type: 'practice', recurrence: 'none', recurrence_until: null,
    ends_at: null, ...extra };
}
type Fault = 'denied' | 'second-page' | 'changed-count' | 'missing-count' | 'empty-page' | 'duplicate-page';
function fixture(kind: Kind, tz: string, rows: Row[], fault?: Fault) {
  const requests: URL[] = [];
  const transportErrors: string[] = [];
  const db = createClient('https://school-precision.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => 'synthetic-actor-token',
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      requests.push(url);
      try {
        expect(request.method).toBe('GET');
        expect(url.origin).toBe('https://school-precision.invalid');
        expect(url.pathname).toBe(`/rest/v1/${table[kind]}`);
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-actor-token');
        expect(request.headers.get('prefer')).toContain('count=exact');
        expect(url.searchParams.get('family_id')).toBe('eq.family');
        expect(url.searchParams.get('member_id')).toBe('eq.child');
        expect(url.searchParams.get('order')).toBe(`${column(kind)}.asc,id.asc`);
        if (kind === 'sports') expect(url.searchParams.get('event_type')).toBe('eq.practice');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (fault === 'denied' || (fault === 'second-page' && offset > 0)) {
          return new Response(JSON.stringify({ code: '42501', message: 'Synthetic refused read' }), { status: 403, headers: { 'content-type': 'application/json' } });
        }
        const matching = rows.filter(item => [...url.searchParams].every(([key, predicate]) => {
          if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
          if (key === 'or') {
            const cutoff = /^\(recurrence_until\.is\.null,recurrence_until\.gt\.(.+)\)$/.exec(predicate)?.[1];
            if (!cutoff) throw new Error('Unsupported synthetic OR predicate');
            return item.recurrence_until === null || micros(String(item.recurrence_until)) > micros(cutoff);
          }
          if (predicate === 'not.is.null') return item[key] !== null;
          if (predicate.startsWith('in.(')) return predicate.slice(4, -1).split(',').includes(String(item[key]));
          const dot = predicate.indexOf('.'), op = predicate.slice(0, dot), wanted = predicate.slice(dot + 1);
          if (op === 'eq') return item[key] === wanted;
          if (op === 'neq') return item[key] !== wanted;
          if (item[key] === null) return false;
          const actual = micros(String(item[key])), boundary = micros(wanted);
          if (op === 'gte') return actual >= boundary;
          if (op === 'lte') return actual <= boundary;
          if (op === 'lt') return actual < boundary;
          throw new Error(`Unsupported synthetic predicate: ${predicate}`);
        })).sort((a, b) => {
          const difference = micros(String(a[column(kind)])) - micros(String(b[column(kind)]));
          return difference < 0n ? -1 : difference > 0n ? 1 : a.id.localeCompare(b.id);
        });
        const start = fault === 'duplicate-page' ? 0 : offset;
        const page = fault === 'empty-page' && offset > 0 ? [] : matching.slice(start, start + Math.min(2, Number(url.searchParams.get('limit') ?? 200)));
        const count = matching.length + (fault === 'changed-count' && offset > 0 ? 1 : 0);
        return new Response(JSON.stringify(page), { headers: {
          'content-type': 'application/json',
          ...(fault === 'missing-count' ? {} : { 'content-range': `${offset}-${offset + Math.max(0, page.length - 1)}/${count}` }),
        } });
      } catch (cause) {
        // The SDK catches fetch errors; check these separately so a fixture
        // assertion can never masquerade as an expected service db failure.
        transportErrors.push(String(cause));
        throw cause;
      }
    } },
  });
  const scope: ServiceScope = { db, familyId: 'family', memberId: 'child', userId: 'user', role: 'parent', actorKind: 'member', tz, now: new Date('2026-10-12T12:00:00Z') };
  return { scope, requests, transportErrors };
}
async function read(kind: Kind, scope: ServiceScope, input: { from?: string; to?: string; limit?: number; includeDone?: boolean } = {}) {
  const options = { ...input, memberId: 'child', eventType: 'practice' };
  if (kind === 'events') return listEventsBetween(scope, options);
  if (kind === 'homework') return listHomeworkDue(scope, options);
  return listPracticesBetween(scope, options);
}
function ids(result: Awaited<ReturnType<typeof read>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data.map(item => item.id);
}
afterEach(() => vi.restoreAllMocks());

const days = [
  { tz: 'UTC', day: '2026-10-12', start: '2026-10-12T00:00:00.000Z', end: '2026-10-13T00:00:00.000Z' },
  { tz: 'Asia/Tokyo', day: '2026-10-12', start: '2026-10-11T15:00:00.000Z', end: '2026-10-12T15:00:00.000Z' },
  { tz: 'America/Los_Angeles', day: '2026-03-08', start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z' },
  { tz: 'America/Los_Angeles', day: '2026-11-01', start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' },
  { tz: 'America/Santiago', day: '2026-09-06', start: '2026-09-06T04:00:00.000Z', end: '2026-09-07T03:00:00.000Z' },
];

describe.each<Kind>(['events', 'homework', 'sports'])('%s whole civil-day precision through the installed SDK', kind => {
  it.each(days)('includes the final microseconds of $day in $tz and excludes next midnight', async ({ tz, day, start, end }) => {
    const last = micros(end);
    const rows = [row(kind, 'start', start),
      row(kind, 'last-ms', timestamp(last - 1000n)), row(kind, 'tail-001', timestamp(last - 999n)),
      row(kind, 'tail-500', timestamp(last - 500n)), row(kind, 'tail-999', timestamp(last - 1n)),
      row(kind, 'previous', timestamp(micros(start) - 1n)), row(kind, 'next-midnight', end),
      row(kind, 'foreign-family', timestamp(last - 500n), { family_id: 'other-family' }),
      row(kind, 'other-child', timestamp(last - 500n), { member_id: 'other-child' })];
    if (kind === 'homework') rows.push(row(kind, 'done', timestamp(last - 500n), { status: 'done' }), row(kind, 'no-due', null));
    if (kind === 'sports') rows.push(row(kind, 'game', timestamp(last - 500n), { event_type: 'game' }));
    const f = fixture(kind, tz, rows);
    const result = await read(kind, f.scope, { from: day, to: day });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['start', 'last-ms', 'tail-001', 'tail-500', 'tail-999']);
    expect(f.requests.filter(url => url.searchParams.has('offset')).map(url => url.searchParams.get('offset'))).toEqual(['2', '4']);
    for (const url of f.requests) {
      expect(url.searchParams.getAll(column(kind))).toContain(`lt.${end}`);
      expect(url.searchParams.getAll(column(kind)).some(value => value.startsWith('lte.'))).toBe(false);
      if (kind === 'homework') expect(url.searchParams.get('status')).toBe('in.(assigned,in_progress)');
    }
  });

  it.each(['2026-10-12T12:00:00.500Z', '2026-10-12T14:00:00.500+02:00', '2026-10-12T12:00:00.500'])('keeps the explicit timed end inclusive: %s', async to => {
    const end = '2026-10-12T12:00:00.500Z';
    const f = fixture(kind, 'UTC', [row(kind, 'before', timestamp(micros(end) - 1n)), row(kind, 'exact', end), row(kind, 'after', timestamp(micros(end) + 1n))]);
    const result = await read(kind, f.scope, { from: '2026-10-12T12:00:00Z', to });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['before', 'exact']);
    expect(f.requests.every(url => url.searchParams.getAll(column(kind)).includes(`lte.${end}`))).toBe(true);
  });

  it('retains the default inclusive week and the caller limit', async () => {
    const end = '2026-10-19T12:00:00.000Z';
    const f = fixture(kind, 'UTC', [row(kind, 'end', end), row(kind, 'after', timestamp(micros(end) + 1n))]);
    const result = await read(kind, f.scope, { limit: 1 });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['end']);
    expect(f.requests.every(url => url.searchParams.getAll(column(kind)).includes(`lte.${end}`))).toBe(true);
  });

  it('retains a genuine empty result', async () => {
    const f = fixture(kind, 'UTC', []);
    expect(ids(await read(kind, f.scope, { from: '2026-10-12', to: '2026-10-12' }))).toEqual([]);
    expect(f.transportErrors).toEqual([]);
  });

  it.each<Fault>(['denied', 'second-page', 'changed-count', 'missing-count', 'empty-page', 'duplicate-page'])('refuses %s without returning partial or empty success', async fault => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture(kind, 'UTC', [0, 1, 2, 3, 4].map(n => row(kind, `event-${n}`, `2026-10-12T12:00:0${n}.000Z`)), fault);
    expect(await read(kind, f.scope, { from: '2026-10-12', to: '2026-10-12' })).toMatchObject({ ok: false, code: 'db' });
    expect(f.transportErrors).toEqual([]);
  });

  it('refuses an impossible day before requesting the database', async () => {
    const f = fixture(kind, 'UTC', []);
    expect(await read(kind, f.scope, { from: '2026-02-30', to: '2026-03-01' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.requests).toEqual([]);
    expect(f.transportErrors).toEqual([]);
  });
});

describe('sports recurrence and homework controls', () => {
  it.each(['2026-10-12T12:00:00.500Z', '2026-10-12T14:00:00.500+02:00', '2026-10-12T12:00:00.500'])('applies the same inclusive timed end to recurring and single rows: %s', async to => {
    const f = fixture('sports', 'UTC', [
      row('sports', 'recurring-exact', '2026-10-05T12:00:00.500000Z', { recurrence: 'weekly' }),
      row('sports', 'recurring-after', '2026-10-05T12:00:00.500001Z', { recurrence: 'weekly' }),
      row('sports', 'single-exact', '2026-10-12T12:00:00.500Z'),
      row('sports', 'single-after', '2026-10-12T12:00:00.500001Z'),
    ]);
    const result = await read('sports', f.scope, { from: '2026-10-12T12:00:00Z', to });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['recurring-exact', 'single-exact']);
  });

  it('does not fill limit one with an occurrence one microsecond after the timed end', async () => {
    const f = fixture('sports', 'UTC', [row('sports', 'after-only', '2026-10-05T12:00:00.500001Z', { recurrence: 'weekly' })]);
    const result = await read('sports', f.scope, { from: '2026-10-12T12:00:00Z', to: '2026-10-12T12:00:00.500Z', limit: 1 });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual([]);
  });

  it('keeps final-millisecond singles in chronological order when IDs sort the other way', async () => {
    const f = fixture('sports', 'UTC', [
      row('sports', 'z-earlier', '2026-10-12T23:59:59.999001Z'),
      row('sports', 'a-later', '2026-10-12T23:59:59.999999Z'),
    ]);
    const result = await read('sports', f.scope, { from: '2026-10-12', to: '2026-10-12', limit: 2 });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['z-earlier', 'a-later']);
  });

  it('selects the earlier recurring occurrence before a later singleton at limit one', async () => {
    const f = fixture('sports', 'UTC', [
      row('sports', 'z-earlier-recurring', '2026-10-05T12:00:00.999001Z', { recurrence: 'weekly' }),
      row('sports', 'a-later-single', '2026-10-12T12:00:00.999999Z'),
    ]);
    const result = await read('sports', f.scope, { from: '2026-10-12T12:00:00Z', to: '2026-10-12T12:01:00Z', limit: 1 });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['z-earlier-recurring']);
    if (result.ok) expect(result.data[0]).toMatchObject({ starts_at: '2026-10-12T12:00:00.999001Z' });
  });

  it('uses the ID tie-break only for equal instants, including different fraction spellings', async () => {
    const f = fixture('sports', 'UTC', [
      row('sports', 'b-equal', '2026-10-12T12:00:00.999000Z'),
      row('sports', 'a-equal', '2026-10-12T12:00:00.999Z'),
    ]);
    const result = await read('sports', f.scope, { from: '2026-10-12', to: '2026-10-12', limit: 2 });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['a-equal', 'b-equal']);
  });

  it('keeps a weekly occurrence on the 25-hour family day and excludes the next-day master', async () => {
    const f = fixture('sports', 'America/Los_Angeles', [
      row('sports', 'old-weekly', '2026-10-25T07:30:00.000Z', { recurrence: 'weekly' }),
      row('sports', 'next-day-weekly', '2026-11-02T08:00:00.000Z', { recurrence: 'weekly' }),
      row('sports', 'ended', '2026-10-25T07:30:00.000Z', { recurrence: 'weekly', recurrence_until: '2026-11-01T07:30:00.000Z' }),
    ]);
    const result = await read('sports', f.scope, { from: '2026-11-01', to: '2026-11-01' });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['old-weekly']);
    if (result.ok) expect(result.data[0]).toMatchObject({ starts_at: '2026-11-01T07:30:00.000Z' });
    expect(f.requests.every(url => url.searchParams.getAll('starts_at').includes('lt.2026-11-02T08:00:00.000Z'))).toBe(true);
  });

  it('keeps a recurring occurrence exactly at an explicit timed end', async () => {
    const f = fixture('sports', 'UTC', [row('sports', 'weekly', '2026-10-05T12:00:00.000Z', { recurrence: 'weekly' })]);
    const result = await read('sports', f.scope, { from: '2026-10-12T11:00:00Z', to: '2026-10-12T12:00:00Z' });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['weekly']);
    if (result.ok) expect(result.data[0]).toMatchObject({ starts_at: '2026-10-12T12:00:00.000Z' });
  });

  it('keeps includeDone opt-in without dropping family/member or due-date filters', async () => {
    const f = fixture('homework', 'UTC', [row('homework', 'done-tail', '2026-10-12T23:59:59.999999Z', { status: 'done' }), row('homework', 'foreign', '2026-10-12T12:00:00Z', { status: 'done', family_id: 'other' }), row('homework', 'no-due', null, { status: 'done' })]);
    const result = await read('homework', f.scope, { from: '2026-10-12', to: '2026-10-12', includeDone: true });
    expect(f.transportErrors).toEqual([]);
    expect(ids(result)).toEqual(['done-tail']);
    expect(f.requests.every(url => !url.searchParams.has('status') && url.searchParams.getAll('due_at').includes('not.is.null'))).toBe(true);
  });
});
