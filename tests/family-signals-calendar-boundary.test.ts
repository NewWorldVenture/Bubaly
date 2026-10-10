import { beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { orPredicate, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as SupabaseClient<Database> | null, enabled: false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  if (!h.db) throw new Error('Missing synthetic client');
  return h.db;
} }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
import { gatherSignalsResult, signalWindow } from '@/lib/family/signals';

const FAMILY = '10000000-0000-4000-8000-000000000001';
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n = 1, patch: Row = {}): Row => ({ id: id(n), family_id: FAMILY, title: `Owned native ${n}`,
  description: null, location: null, starts_at: '2026-10-05T15:00:00.000Z', ends_at: '2026-10-05T16:00:00.000Z',
  all_day: false, recurrence: 'none', recurrence_until: null, category: 'general', assignee_id: null,
  feed_id: null, external_uid: null, onboarding_key: null, idempotency_key: null, created_by: null, source_recurrence: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...patch });
const date = (n = 1, day = '2026-10-05', next = '2026-10-06', patch: Row = {}) => native(n, {
  all_day: true, starts_at: `${day}T00:00:00.000Z`, ends_at: `${next}T00:00:00.000Z`, ...patch,
});
type Options = { cap?: number; missingCount?: boolean; drift?: boolean; fail?: boolean; laterError?: boolean; count?: number; ignoreFamily?: boolean };
function setup(events: Row[], options: Options = {}) {
  const calls: URL[] = [];
  h.db = createClient<Database>('https://signals.synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'; calls.push(url);
      expect(url.origin).toBe('https://signals.synthetic.invalid'); expect(['GET', 'HEAD']).toContain(method);
      const table = url.pathname.split('/').at(-1), calendar = table === 'calendar_events';
      if (calendar && options.fail) return Response.json({ message: 'Synthetic refused' }, { status: 403 });
      let rows = calendar ? [...events] : [];
      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'offset', 'limit'].includes(key) || calendar && key === 'family_id' && options.ignoreFamily) continue;
        rows = rows.filter(orPredicate(key === 'or' ? value.slice(1, -1) : `${key}.${value}`));
      }
      rows.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || String(a.id).localeCompare(String(b.id)));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (calendar && offset && options.laterError) return Response.json({ message: 'Synthetic later refusal' }, { status: 403 });
      const limit = Math.min(options.cap ?? 1000, Number(url.searchParams.get('limit') ?? 1000)), page = rows.slice(offset, offset + limit);
      const count = (calendar ? options.count ?? rows.length : rows.length) + (calendar && offset && options.drift ? 1 : 0);
      return new Response(method === 'HEAD' ? null : JSON.stringify(page), { headers: { 'Content-Type': 'application/json',
        ...(calendar && options.missingCount ? {} : { 'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${count}` }),
      } });
    } },
  });
  return calls;
}
beforeEach(() => { h.enabled = false; });
const NOW = new Date('2026-10-05T12:00:00Z');
async function read(tz = 'America/New_York', now = NOW) {
  const result = await gatherSignalsResult(FAMILY, tz, now);
  expect(result.error).toBeNull(); expect(result.data).not.toBeNull(); return result.data!;
}
async function refuse() {
  const result = await gatherSignalsResult(FAMILY, 'America/New_York', NOW);
  expect(result.error).not.toBeNull(); expect(result.data).toBeNull();
}

it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])('preserves native civil DATE histogram in %s', async tz => {
  setup([date(), date(2, '2026-10-06', '2026-10-07')]);
  const result = await read(tz); expect(result.counts.eventsToday).toBe(1); expect(result.counts.maxEventsPerDay).toBe(1);
});
it.each(['UTC', 'America/New_York'])('preserves actual timed today in %s', async tz => {
  setup([native()]); expect((await read(tz)).counts.eventsToday).toBe(1);
});
it.each([['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02']])('preserves NY DST DATE %s', async (day, next) => {
  setup([date(1, day, next)]); expect((await read('America/New_York', new Date(`${day}T12:00:00Z`))).counts.eventsToday).toBe(1);
});
it('counts native daily occurrences anchored before the week', async () => {
  setup([native(1, { starts_at: '2026-10-04T15:00:00.000Z', ends_at: '2026-10-04T16:00:00.000Z', recurrence: 'daily' })]);
  const result = await read(); expect(result.counts.eventsToday).toBe(1); expect(result.counts.maxEventsPerDay).toBe(1);
});
it('counts recurring DATEs on their own civil days', async () => {
  setup([date(1, '2026-10-04', '2026-10-05', { recurrence: 'daily' })]);
  const result = await read(); expect(result.counts.eventsToday).toBe(1); expect(result.counts.maxEventsPerDay).toBe(1);
});
it.each([3, 201])('completes %i native rows under provider cap2 before histogram', async count => {
  const calls = setup(Array.from({ length: count }, (_, i) => native(i + 1)), { cap: 2 });
  expect((await read()).counts.eventsToday).toBe(count);
  expect(calls.some(url => url.pathname.endsWith('/calendar_events') && Number(url.searchParams.get('offset')) >= count - 1)).toBe(true);
});
it('accepts a qualified true empty calendar', async () => {
  setup([]); const result = await read(); expect(result.counts.eventsToday).toBe(0); expect(result.counts.maxEventsPerDay).toBe(0);
});
it('keeps the histogram start-based while qualifying ongoing rows', async () => {
  setup([date(1, '2026-10-04', '2026-10-07'), native(2, { starts_at: '2026-10-04T15:00:00.000Z', ends_at: '2026-10-06T16:00:00.000Z' }), native(3)]);
  const result = await read(); expect(result.counts.eventsToday).toBe(1); expect(result.counts.maxEventsPerDay).toBe(1);
});
it('preserves the inclusive seventh-day instant but excludes its next millisecond', async () => {
  const end = signalWindow('America/New_York', NOW).in7Iso;
  setup([native(1, { starts_at: end, ends_at: null }), native(2, { starts_at: new Date(Date.parse(end) + 1).toISOString(), ends_at: null })]);
  const result = await read(); expect(result.counts.eventsToday).toBe(0); expect(result.counts.maxEventsPerDay).toBe(1);
});
it('includes final civil DATE and excludes the next day', async () => {
  setup([date(1, '2026-10-12', '2026-10-13'), date(2, '2026-10-13', '2026-10-14')]);
  const result = await read(); expect(result.counts.eventsToday).toBe(0); expect(result.counts.maxEventsPerDay).toBe(1);
});
it('does not invent back-to-back clocks for all-day DATEs', async () => {
  setup([date(1), date(2), native(3, { starts_at: '2026-10-05T00:10:00Z', ends_at: '2026-10-05T01:00:00Z' })]);
  const result = await read('UTC'); expect(result.counts.eventsToday).toBe(3); expect(result.stress.factors.some(factor => factor.label === 'Back-to-back events')).toBe(false);
});
it('retains actual timed start-based back-to-back scoring', async () => {
  setup([native(1), native(2, { starts_at: '2026-10-05T15:20:00Z', ends_at: '2026-10-05T16:20:00Z' })]);
  expect((await read()).stress.factors).toContainEqual({ label: 'Back-to-back events', points: 7, detail: '1 tightly packed transitions' });
});
it.each([{ missingCount: true }, { drift: true }, { fail: true }, { laterError: true }, { count: 20001 }, { count: 0 }])('refuses unqualified completion %j', async options => {
  setup([native(1), native(2), native(3)], { cap: 2, ...options }); await refuse();
});
it.each([{ title: null }, { updated_at: 'bad-clock' }, { onboarding_key: undefined }, { source_recurrence: { unsafe: true } }])('qualifies malformed row201 before counting %j', async patch => {
  setup([...Array.from({ length: 200 }, (_, i) => native(i + 1)), native(201, patch)], { cap: 2 }); await refuse();
});
it('qualifies malformed ongoing rows before excluding their starts', async () => {
  setup([date(1, '2026-10-04', '2026-10-07', { updated_at: undefined }), native(2)]); await refuse();
});
it('refuses noncanonical all-day clocks instead of normalizing', async () => {
  setup([date(1, '2026-10-05', '2026-10-06', { starts_at: '2026-10-05T04:00:00Z' })]); await refuse();
});
it('refuses duplicate identity before histogram', async () => {
  setup([native(1), native(2, { id: id(1) })], { cap: 1 }); await refuse();
});
it('refuses foreign-family projection despite transport filter', async () => {
  setup([native(1, { family_id: id(99) })], { ignoreFamily: true }); await refuse();
});
it('holds source-enabled signals before calendar transport', async () => {
  const calls = setup([native()]); h.enabled = true; await refuse(); expect(calls.some(url => url.pathname.endsWith('/calendar_events'))).toBe(false);
});
