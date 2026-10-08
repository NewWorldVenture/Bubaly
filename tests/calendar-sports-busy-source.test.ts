import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readCalendarBusySource } from '@/lib/calendar/occurrences';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { orPredicate } from './helpers/in-memory-supabase';
import { POST } from '@/app/api/ai/schedule/route';

const seams = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => seams.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ active: { familyId: 'synthetic-family', family: { timezone: 'America/New_York' } } }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const family = 'synthetic-family';
type Row = { id: string; family_id: string; starts_at: string; ends_at: string | null; member_id: string | null; recurrence: string | null; recurrence_until: string | null };
const row = (id: string, starts_at: string, ends_at: string | null, extra: Partial<Row> = {}): Row => ({ id, family_id: family, starts_at, ends_at, member_id: null, recurrence: 'none', recurrence_until: null, ...extra });
type Fault = 'missing-count' | 'count-drift' | 'duplicate-page' | 'empty-page' | 'transport' | 'query-error' | 'unavailable-page';

// Real SDK serialization, filtered synthetic PostgREST replies, a server cap of
// two, and exact counts. This never contacts a provider or production database.
function transport(rows: Row[], fault?: Fault, count?: number, table = 'sports_events') {
  const calls: URL[] = [];
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      expect(url.origin).toBe('https://synthetic.invalid');
      expect(init?.method).not.toBe('HEAD');
      expect(url.searchParams.get('family_id')).toBe(`eq.${family}`);
      expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      const series = url.pathname.endsWith('/sports_events') && url.searchParams.get('recurrence') === 'neq.none';
      if (series && fault === 'transport') throw new Error('Synthetic unavailable transport');
      if (series && fault === 'query-error') return new Response(JSON.stringify({ message: 'Synthetic query error', code: 'XX000' }), { status: 500 });
      const matches = url.pathname.endsWith(`/${table}`) ? rows.filter(r => [...url.searchParams].every(([key, value]) => {
        if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
        if (key === 'or') return orPredicate(value.slice(1, -1))(r);
        const field = r[key as keyof Row];
        if (value.startsWith('eq.')) return field === value.slice(3);
        if (value.startsWith('neq.')) return field !== null && field !== value.slice(4);
        if (value.startsWith('lt.')) return field != null && String(field) < value.slice(3);
        throw new Error(`Unexpected filter ${key}=${value}`);
      })).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id)) : [];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const total = series && count !== undefined ? count : matches.length + (series && offset > 0 && fault === 'count-drift' ? 1 : 0);
      const page = matches.slice(series && fault === 'duplicate-page' ? 0 : offset, (series && fault === 'duplicate-page' ? 0 : offset) + 2);
      return new Response(JSON.stringify(series && fault === 'unavailable-page' ? null : series && offset > 0 && fault === 'empty-page' ? [] : page), { headers: {
        'Content-Type': 'application/json',
        ...(series && fault === 'missing-count' ? {} : { 'Content-Range': page.length ? `${offset}-${offset + page.length - 1}/${total}` : `*/${total}` }),
      } });
    } },
  });
  return { db, calls };
}
const weekly = (id: string, extra: Partial<Row> = {}) => row(id, '2023-10-07T10:00:00.000Z', '2023-10-07T11:00:00.000Z', { recurrence: 'weekly', ...extra });
const read = (rows: Row[], from = '2026-10-10T00:00:00.000Z', to = '2026-10-11T00:00:00.000Z', zone = 'UTC') => {
  const { db } = transport(rows); return readCalendarBusySource(db, family, 'sports_events', from, to, zone);
};

describe('complete sports series busy intervals through actual SDK', () => {
  it('expands years-old masters, pages all tied starts, excludes foreign rows and does not double-count a seed', async () => {
    const { db, calls } = transport([
      ...Array.from({ length: 5 }, (_, n) => weekly(`series-${n}`)),
      weekly('seed today', { starts_at: '2026-10-10T10:00:00.000Z', ends_at: '2026-10-10T11:00:00.000Z' }),
      weekly('foreign', { family_id: 'foreign' }),
      row('single', '2026-10-10T12:00:00.000Z', '2026-10-10T13:00:00.000Z'),
    ]);
    const result = await readCalendarBusySource(db, family, 'sports_events', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'UTC');
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(7);
    expect(result.data?.filter(r => r.id === 'seed today')).toHaveLength(1);
    expect(result.data?.every(r => r.starts_at.startsWith('2026-10-10'))).toBe(true);
    const masters = calls.filter(url => url.searchParams.get('recurrence') === 'neq.none');
    expect(masters.map(url => Number(url.searchParams.get('offset') ?? 0))).toEqual([0, 2, 4]);
    expect(masters.every(url => !url.searchParams.has('recurrence_until'))).toBe(true);
  });
  it.each([
    ['fall-back', '2026-10-25T13:00:00.000Z', '2026-10-25T14:00:00.000Z', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-01T14:00:00.000Z'],
    ['spring gap', '2026-03-01T07:30:00.000Z', '2026-03-01T08:30:00.000Z', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', '2026-03-08T07:30:00.000Z'],
    ['first fold instant', '2026-10-25T05:30:00.000Z', '2026-10-25T06:30:00.000Z', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-01T05:30:00.000Z'],
    ['saved second fold instant', '2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T08:00:00.000Z', '2026-11-01T06:30:00.000Z'],
  ])('uses family wall time and saved seed instants across %s', async (_name, start, end, from, to, expected) => {
    const result = await read([row('practice', start, end, { recurrence: 'weekly' })], from, to, 'America/New_York');
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(1);
    expect(result.data?.[0].starts_at).toBe(expected);
    expect(Date.parse(result.data![0].ends_at!) - Date.parse(expected)).toBe(3_600_000);
  });
  it('keeps an ongoing last occurrence past its exclusive cutoff and excludes occurrences at the cutoff', async () => {
    const result = await read([
      weekly('ongoing last', { starts_at: '2026-10-03T23:30:00.000Z', ends_at: '2026-10-04T02:00:00.000Z', recurrence_until: '2026-10-10T23:45:00.000Z' }),
      weekly('at cutoff', { recurrence_until: '2026-10-17T10:00:00.000Z' }),
      weekly('expired', { recurrence_until: '2025-01-01T00:00:00.000Z' }),
    ], '2026-10-11T00:00:00.000Z', '2026-10-18T00:00:00.000Z');
    expect(result.error).toBeNull();
    expect(result.data?.map(r => r.id)).toEqual(['ongoing last']);
    expect(result.data?.[0]).toMatchObject({ starts_at: '2026-10-10T23:30:00.000Z', ends_at: '2026-10-11T02:00:00.000Z' });
  });
  it('preserves month-end skip and leap-year recurrence semantics', async () => {
    const monthly = await read([row('31st', '2026-01-31T10:00:00.000Z', '2026-01-31T11:00:00.000Z', { recurrence: 'monthly' })], '2026-02-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z');
    expect(monthly.error).toBeNull(); expect(monthly.data?.map(r => r.starts_at)).toEqual(['2026-03-31T10:00:00.000Z']);
    const yearly = await read([row('Leap', '2024-02-29T10:00:00.000Z', '2024-02-29T11:00:00.000Z', { recurrence: 'yearly' })], '2025-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z');
    expect(yearly.error).toBeNull(); expect(yearly.data?.map(r => r.starts_at)).toEqual(['2028-02-29T10:00:00.000Z']);
  });
  it('includes boundary points once, excludes old points and exact ended intervals, and retains missing-end overlap', async () => {
    const result = await read([
      row('point at start', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      weekly('series point at start', { starts_at: '2026-10-03T00:00:00.000Z', ends_at: '2026-10-03T00:00:00.000Z' }),
      row('old point', '2026-10-09T23:30:00.000Z', '2026-10-09T23:30:00.000Z'),
      weekly('old series point', { starts_at: '2026-10-02T23:30:00.000Z', ends_at: '2026-10-02T23:30:00.000Z' }),
      row('ended', '2026-10-09T23:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      weekly('series ended', { starts_at: '2026-10-02T23:00:00.000Z', ends_at: '2026-10-03T00:00:00.000Z' }),
      weekly('missing end', { starts_at: '2026-10-02T23:30:00.000Z', ends_at: null }),
      row('point at end', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z'),
    ]);
    expect(result.error).toBeNull(); expect(result.data?.map(r => r.id).sort()).toEqual(['missing end', 'point at start', 'series point at start']);
    expect(result.data?.find(r => r.id === 'missing end')?.ends_at).toBeNull();
  });
  it('school shares the same point and exclusive overlap boundary without a recurrence query', async () => {
    const { db, calls } = transport([
      row('point at start', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      row('old point', '2026-10-09T23:30:00.000Z', '2026-10-09T23:30:00.000Z'),
      row('ended', '2026-10-09T23:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      row('ongoing', '2026-10-09T23:30:00.000Z', null),
    ], undefined, undefined, 'school_events');
    const result = await readCalendarBusySource(db, family, 'school_events', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'UTC');
    expect(result.error).toBeNull(); expect(result.data?.map(r => r.id).sort()).toEqual(['ongoing', 'point at start']);
    expect(calls.every(url => !url.searchParams.has('recurrence'))).toBe(true);
  });
  it.each(['missing-count', 'count-drift', 'duplicate-page', 'empty-page', 'transport', 'query-error', 'unavailable-page'] as const)('refuses partial series data: %s', async fault => {
    const { db } = transport(Array.from({ length: 5 }, (_, n) => weekly(`series-${n}`)), fault);
    const result = await readCalendarBusySource(db, family, 'sports_events', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'UTC');
    expect(result.error).not.toBeNull(); expect(result.data).toBeNull();
  });
  it('refuses a master count above the complete-read ceiling', async () => {
    const { db } = transport([weekly('master')], undefined, 2001);
    const result = await readCalendarBusySource(db, family, 'sports_events', '2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'UTC');
    expect(result.data).toBeNull(); expect(result.error?.message).toContain('2000');
  });
  it('refuses an over-budget expansion instead of returning a prefix', async () => {
    const result = await read([weekly('daily', { recurrence: 'daily' })], '2026-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z');
    expect(result.data).toBeNull(); expect(result.error?.message).toContain('500');
  });
  it('refuses an aggregate occurrence count above its ceiling even when each master is complete', async () => {
    const result = await read(Array.from({ length: 51 }, (_, n) => weekly(`daily-${n}`, { recurrence: 'daily' })), '2026-01-01T00:00:00.000Z', '2027-02-06T00:00:00.000Z');
    expect(result.data).toBeNull(); expect(result.error?.message).toContain('20000');
  });
  it.each([
    { recurrence: 'fortnightly' }, { starts_at: 'invalid' }, { ends_at: 'invalid' },
    { ends_at: '2020-01-01T00:00:00.000Z' }, { recurrence_until: 'invalid' },
  ])('refuses invalid recurring data %j', async extra => {
    // Invalid starts must still be answered to prove validation, rather than
    // removed by the transport's typed comparison before reaching the reader.
    const result = await read([weekly('invalid master', { ...extra, ...(extra.starts_at ? { starts_at: '0000-invalid' } : {}) })]);
    expect(result.data).toBeNull(); expect(result.error).not.toBeNull();
  });
  it.each([
    ['invalid', '2026-10-11T00:00:00.000Z', 'UTC'],
    ['2026-10-11T00:00:00.000Z', '2026-10-10T00:00:00.000Z', 'UTC'],
    ['2026-10-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', 'Invalid/Zone'],
  ])('refuses invalid bounds or family timezone without HTTP', async (from, to, zone) => {
    const { db, calls } = transport([]);
    const result = await readCalendarBusySource(db, family, 'sports_events', from, to, zone);
    expect(result.data).toBeNull(); expect(result.error).not.toBeNull(); expect(calls).toHaveLength(0);
  });
  it('returns no occupancy for an empty timed window without querying', async () => {
    const { db, calls } = transport([weekly('old master')]);
    expect(await readCalendarBusySource(db, family, 'sports_events', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 'Pacific/Apia')).toEqual({ data: [], error: null });
    expect(calls).toHaveLength(0);
  });
  it('assistant expands selected and family series while excluding other members and expired masters', async () => {
    const { db } = transport([
      weekly('selected', { member_id: 'sam' }), weekly('family'), weekly('other', { member_id: 'alex' }),
      weekly('expired', { member_id: 'sam', recurrence_until: '2025-01-01T00:00:00.000Z' }),
    ]);
    const tool = buildAssistantTools(db, { familyId: family, userId: 'synthetic-user', memberId: null, members: [{ id: 'sam', display_name: 'Sam' }, { id: 'alex', display_name: 'Alex' }], tz: 'UTC' }).find(t => t.name === 'find_free_time')!;
    const result = await tool.execute({ date: '2026-10-10', assignee: 'Sam' }) as { ok: boolean; busy: unknown[]; note: string };
    expect(result.ok).toBe(true); expect(result.busy).toHaveLength(2);
    expect(result.busy).toMatchObject([{ title: 'Sports event', starts_at: '2026-10-10T10:00:00.000Z' }, { title: 'Sports event', starts_at: '2026-10-10T10:00:00.000Z' }]);
    expect(result.note).not.toContain('whole day is free');
  });
  it.each(['duration', 'missing-end', 'point'] as const)('AI scheduling HTTP consumes qualified sports recurrence: %s', async mode => {
    const starts_at = mode === 'point' ? '2026-10-25T13:00:00.000Z' : '2026-10-25T12:00:00.000Z';
    const { db } = transport([weekly('practice', { starts_at, ends_at: mode === 'missing-end' ? null : mode === 'point' ? starts_at : '2026-10-25T13:00:00.000Z', member_id: 'sam' })]);
    seams.db = db;
    const response = await POST(new NextRequest('https://synthetic.invalid/api/ai/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      windowStartISO: '2026-11-01T13:00:00.000Z', windowEndISO: '2026-11-01T15:00:00.000Z', durationMin: mode === 'point' ? 120 : 60,
      memberIds: ['sam'], workingHours: { startHour: 8, endHour: 10 }, maxSuggestions: 1,
    }) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.busyCount).toBe(1);
    expect(result.slots).toEqual([{ startISO: mode === 'point' ? '2026-11-01T13:00:00.000Z' : '2026-11-01T14:00:00.000Z', endISO: '2026-11-01T15:00:00.000Z' }]);
  });
});
