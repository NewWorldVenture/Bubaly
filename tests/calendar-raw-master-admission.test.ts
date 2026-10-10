import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { type ComponentProps, type ReactElement } from 'react';
import type { Database } from '@/lib/database.types';
import { orPredicate, type Row } from './helpers/in-memory-supabase';
import { WeeklyDigestEmail } from '@/lib/emails/weekly-digest';

type DigestProps = ComponentProps<typeof WeeklyDigestEmail>;
const h = vi.hoisted(() => ({ db: null as SupabaseClient<Database> | null, mail: [] as ReactElement<DigestProps>[], enabled: false }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { if (!h.db) throw new Error('Synthetic client missing'); return h.db; }, createServer: async () => { if (!h.db) throw new Error('Synthetic client missing'); return h.db; } }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://synthetic.invalid', sendReactEmail: async (input: { react: ReactElement<DigestProps> }) => { h.mail.push(input.react); return { ok: true }; } }));
import { gatherSignalsResult } from '@/lib/family/signals';
import { readCompleteCalendarOccurrences, searchCalendarOccurrences } from '@/lib/services/calendar/search-occurrences';
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


const master = (n = 1, patch: Row = {}) => native(n, { all_day: false, starts_at: '2026-09-30T15:00:00Z',
  ends_at: '2026-09-30T16:00:00Z', recurrence: 'monthly', ...patch });
const window = { from: '2026-10-05T04:00:00Z', to: '2026-10-12T03:59:59.999Z' };
function scope() {
  if (!h.db) throw new Error('Missing synthetic client');
  return { db: h.db, familyId: FAMILY, userId: null, memberId: null, role: 'system' as const, actorKind: 'system' as const, tz: 'America/New_York' };
}
const consumers = ['search', 'signals', 'digest'] as const;
async function check(consumer: typeof consumers[number], valid: boolean) {
  if (consumer === 'search') {
    const result = await searchCalendarOccurrences(scope(), { ...window, query: 'not present', limit: 1 });
    expect(result.ok).toBe(valid);
    if (result.ok) expect(result.data).toMatchObject({ events: [], totalVisibleCount: 0, matchedCount: 0 });
  } else if (consumer === 'signals') {
    const result = await gatherSignalsResult(FAMILY, 'America/New_York', new Date('2026-10-05T12:00:00Z'));
    expect(result.error === null).toBe(valid);
    if (valid) expect(result.data?.counts.eventsToday).toBe(0); else expect(result.data).toBeNull();
  } else if (valid) {
    const email = await send(); expect(email.props.eventCount).toBe(0); expect(email.props.events).toEqual([]);
  } else await refuse();
}
it.each(consumers)('accepts a healthy zero-occurrence monthly master through %s', async consumer => {
  setup([master()]); await check(consumer, true);
});
const originalWitnesses: Row[] = [{ title: null }, { updated_at: undefined }, { source_recurrence: { unsafe: true } }, { family_id: id(77) }];
for (const consumer of consumers) {
  it.each(originalWitnesses)(`refuses original zero-occurrence raw-master witness through ${consumer}: %j`, async patch => {
    setup([master(1, patch)], { ignoreFamily: true }); await check(consumer, false);
  });
}
it.each([{ onboarding_key: undefined }, { category: 'unknown' }, { ends_at: 'bad-clock' }, { recurrence_until: 'bad-clock' },
  { all_day: true, starts_at: '2026-09-30T04:00:00Z', ends_at: '2026-10-01T04:00:00Z' },
  { assignee_id: '' }, { all_day: true, starts_at: '2026-09-30T00:00:00Z', ends_at: '2026-09-30T00:00:00Z' },
  { created_at: '2026-02-30T00:00:00Z' }, { ends_at: '2026-09-29T15:00:00Z' }])('refuses raw clocks/DATE/metadata before zero expansion: %j', async patch => {
  setup([master(1, patch)]); expect((await readCompleteCalendarOccurrences(scope(), window)).ok).toBe(false);
});
it('qualifies a zero-emission master on page201 despite a query and cap1', async () => {
  const f = setup([...Array.from({ length: 200 }, (_, i) => master(i + 1)), master(201, { title: null })], { cap: 2 });
  await check('search', false); expect(f.calls.some(url => Number(url.searchParams.get('offset')) === 200)).toBe(true);
});
it('keeps qualified recurrence occurrence counts and public native identity', async () => {
  setup([master(1, { recurrence: 'daily' })]);
  const result = await searchCalendarOccurrences(scope(), { ...window, limit: 1 }); expect(result.ok).toBe(true);
  if (result.ok) { expect(result.data.totalVisibleCount).toBe(7); expect(result.data.returnedCount).toBe(1);
    expect(result.data.events[0].eventId).toBe(id(1)); expect(result.data.truncated).toBe(true); }
});
it('holds source-enabled signals and digest before native transport', async () => {
  const f = setup([master()]); h.enabled = true; await check('signals', false); await check('digest', false);
  expect(f.calls.some(url => url.pathname.endsWith('/calendar_events'))).toBe(false);
});
