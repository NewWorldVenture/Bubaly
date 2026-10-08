import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from '@/lib/database.types';
import { orPredicate, type Row } from './helpers/in-memory-supabase';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';

type DigestProps = ComponentProps<typeof WeeklyDigestEmail>;
const h = vi.hoisted(() => ({ db: null as SupabaseClient<Database> | null, mail: [] as ReactElement<DigestProps>[], enabled: false }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { if (!h.db) throw new Error('Synthetic client missing'); return h.db; } }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://synthetic.invalid', sendReactEmail: async (input: { react: ReactElement<DigestProps> }) => { h.mail.push(input.react); return { ok: true }; } }));
import { GET } from '@/app/api/cron/weekly-digest/route';

const FAMILY = '10000000-0000-4000-8000-000000000001', USER = '20000000-0000-4000-8000-000000000001';
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n = 1, patch: Row = {}): Row => ({ id: id(n), family_id: FAMILY, title: `Synthetic event ${n}`, description: null, location: null,
  starts_at: '2026-10-05T00:00:00.000Z', ends_at: '2026-10-06T00:00:00.000Z', all_day: true, recurrence: 'none', recurrence_until: null,
  category: 'general', assignee_id: null, feed_id: null, external_uid: null, onboarding_key: null, idempotency_key: null, created_by: null,
  source_recurrence: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...patch });
type Options = { tz?: string; cap?: number; missingCount?: boolean; drift?: boolean; laterError?: boolean; count?: number; ignoreFamily?: boolean };
function setup(events: Row[] = [native()], options: Options = {}) {
  const calls: URL[] = [];
  const tables: Record<string, Row[]> = { families: [{ id: FAMILY, name: 'Synthetic family', timezone: options.tz ?? 'America/New_York' }],
    family_members: [{ id: id(999), family_id: FAMILY, user_id: USER, display_name: 'Synthetic manager', role: 'parent', is_active: true }], calendar_events: events };
  h.db = createClient<Database>('https://digest.synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'; calls.push(url);
    expect(url.origin).toBe('https://digest.synthetic.invalid'); expect(['GET', 'HEAD']).toContain(method);
    if (url.pathname === '/auth/v1/admin/users') return Response.json({ users: Number(url.searchParams.get('page')) === 1 ? [{ id: USER, email: 'synthetic@example.invalid' }] : [] });
    const table = url.pathname.split('/').at(-1)!;
    let rows = [...(tables[table] ?? [])];
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'offset', 'limit'].includes(key) || (table === 'calendar_events' && key === 'family_id' && options.ignoreFamily)) continue;
      rows = value === 'not.is.null' ? rows.filter(row => row[key] != null) : rows.filter(orPredicate(key === 'or' ? value.slice(1, -1) : `${key}.${value}`));
    }
    rows.sort((a, b) => String(a.starts_at ?? a.id).localeCompare(String(b.starts_at ?? b.id)) || String(a.id).localeCompare(String(b.id)));
    if (new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object')) return Response.json(rows[0] ?? null);
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Math.min(options.cap ?? 1000, Number(url.searchParams.get('limit') ?? 1000));
    if (table === 'calendar_events' && offset && options.laterError) return Response.json({ message: 'Synthetic later-page error' }, { status: 403 });
    const page = rows.slice(offset, offset + limit), count = table === 'calendar_events' ? (options.count ?? rows.length) + (offset && options.drift ? 1 : 0) : rows.length;
    return new Response(method === 'HEAD' ? null : JSON.stringify(page), { headers: { 'Content-Type': 'application/json', ...(table === 'calendar_events' && options.missingCount ? {} : { 'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${count}` }) } });
  } } });
  return { calls, tables };
}
beforeEach(() => { h.mail = []; h.enabled = false; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function send() {
  const response = await GET(new NextRequest('https://local.synthetic.invalid/api/cron/weekly-digest'));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sent: 1, failed: 0 }); expect(h.mail).toHaveLength(1);
  return h.mail[0];
}
async function refuse() {
  const response = await GET(new NextRequest('https://local.synthetic.invalid/api/cron/weekly-digest'));
  expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ sent: 0, failed: 1 }); expect(h.mail).toHaveLength(0);
}

it.each(['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])('preserves canonical DATE through actual SDK, route and real email in %s', async tz => {
  setup([native()], { tz }); const email = await send();
  expect(email.props.events).toEqual([{ title: 'Synthetic event 1', date: '2026-10-05' }]); expect(renderToStaticMarkup(email)).toContain('Mon, Oct 5');
});
it.each(['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'])('preserves the timed instant household day in %s', async tz => {
  setup([native(1, { all_day: false, starts_at: '2026-10-05T02:00:00Z', ends_at: '2026-10-05T03:00:00Z' })], { tz });
  expect((await send()).props.events[0].date).toBe(tz === 'Asia/Tokyo' ? '2026-10-05' : '2026-10-04');
});
it.each([['2026-03-08', '2026-03-09', 'Sun, Mar 8'], ['2026-11-01', '2026-11-02', 'Sun, Nov 1']])('preserves NY DST DATE %s and its real email label', async (day, next, label) => {
  vi.setSystemTime(new Date(Date.parse(`${day}T12:00:00Z`) - 86400000));
  setup([native(1, { starts_at: `${day}T00:00:00.000Z`, ends_at: `${next}T00:00:00.000Z` })]); const email = await send();
  expect(email.props.events[0].date).toBe(day); expect(renderToStaticMarkup(email)).toContain(label);
});
it.each([11, 201])('counts all %i native occurrences under a two-row transport cap before limiting details', async count => {
  const f = setup(Array.from({ length: count }, (_, i) => native(i + 1)), { tz: 'UTC', cap: 2 }); const email = await send();
  expect(email.props.events).toHaveLength(10); expect(email.props.eventCount).toBe(count); expect(renderToStaticMarkup(email)).toContain(`>${count}</p>`);
  expect(f.calls.some(url => url.pathname.endsWith('/calendar_events') && Number(url.searchParams.get('offset')) >= count - 1)).toBe(true);
  expect(renderToStaticMarkup(email)).not.toContain('Synthetic event 6</p>');
});
it.each([{ missingCount: true }, { drift: true }, { laterError: true }, { count: 20001 }])('refuses unqualified calendar completion %j before email', async options => {
  setup(Array.from({ length: 11 }, (_, i) => native(i + 1)), { cap: 2, ...options }); await refuse();
});
it.each([{ title: null }, { updated_at: 'bad-clock' }, { onboarding_key: undefined }, { starts_at: '2026-10-05T03:00:00Z' }, { source_recurrence: { unsafe: true } }])('qualifies malformed row 201 before presentation %j', async patch => {
  setup([...Array.from({ length: 200 }, (_, i) => native(i + 1)), native(201, patch)], { cap: 2 }); await refuse();
});
it('refuses a foreign-family projection before email', async () => {
  setup([native(1, { family_id: id(999) })], { ignoreFamily: true }); await refuse();
});
it('refuses duplicate IDs even beyond the presentation limit', async () => {
  setup([...Array.from({ length: 200 }, (_, i) => native(i + 1)), native(201, { id: id(1) })], { cap: 2 }); await refuse();
});
it('preserves the explicit source-enabled protective hold', async () => {
  const f = setup(); h.enabled = true; await refuse(); expect(f.calls.some(url => url.pathname.endsWith('/calendar_events'))).toBe(false);
});
it('qualifies ongoing rows without adding their earlier starts to the upcoming list', async () => {
  setup([native(1, { starts_at: '2026-10-03T00:00:00.000Z' }), native(2)]);
  const email = await send(); expect(email.props.eventCount).toBe(1); expect(email.props.events).toEqual([{ title: 'Synthetic event 2', date: '2026-10-05' }]);
});
it('counts expanded native recurrence occurrences rather than stored series rows', async () => {
  setup([native(1, { starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-02T00:00:00.000Z', recurrence: 'daily' })]);
  const email = await send(); expect(email.props.eventCount).toBe(8); expect(email.props.events).toHaveLength(8);
  expect(email.props.events[0].date).toBe('2026-10-04'); expect(email.props.events[7].date).toBe('2026-10-11');
});
it('preserves the rolling window inclusive final instant for timed starts', async () => {
  setup([native(1, { all_day: false, starts_at: '2026-10-11T12:00:00.000Z', ends_at: null }),
    native(2, { all_day: false, starts_at: '2026-10-11T12:00:00.001Z', ends_at: null })]);
  const email = await send(); expect(email.props.eventCount).toBe(1); expect(email.props.events).toEqual([{ title: 'Synthetic event 1', date: '2026-10-11' }]);
});
it('rejects an invalid household clock before calendar transport or email', async () => {
  const f = setup([native()], { tz: 'Invalid/Zone' }); await refuse(); expect(f.calls.some(url => url.pathname.endsWith('/calendar_events'))).toBe(false);
});
it('keeps callers without the optional exact count compatible', () => {
  const email = createElement(WeeklyDigestEmail, { familyName: 'Synthetic', adminName: 'Manager', events: [{ title: 'Event', date: '2026-10-05' }], openChores: 0, mealsPlanned: 0, memberCount: 2, timeZone: 'UTC' });
  expect(renderToStaticMarkup(email)).toMatch(/>1<\/p><p[^>]*>Events<\/p>/);
});
