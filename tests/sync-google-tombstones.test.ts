import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import type { GEvent } from '@/lib/sync/providers/google';

// Only credential access and request-local translation are replaced. Provider
// HTTP, both engines, persisted policy, persistence guards and the real SDK run.
vi.mock('@/lib/sync/accounts', async original => ({
  ...await original<typeof import('@/lib/sync/accounts')>(),
  getValidAccessToken: async () => 'synthetic-access-token',
}));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'synthetic-access-token' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
const { runGoogleSync } = await import('@/lib/sync/engine/google');
const { runProviderSync } = await import('@/lib/sync/engine/generic');

type Row = Record<string, unknown>;
type Call = { url: URL; method: string; body: Row | null };
const ACCOUNT = { id: 'account', family_id: 'family', user_id: 'owner', external_id: 'synthetic@example.invalid' };
const NEXT = 'next-synthetic-cursor';
const STALE = 'prior-synthetic-cursor';
const CANCELLED_INSTANCE = { id: 'deleted', status: 'cancelled', recurringEventId: 'series',
  originalStartTime: { dateTime: '2026-06-21T09:00:00Z' } };

function fixture(events: GEvent[], options: { failedDelete?: boolean; zeroDelete?: boolean; direction?: string; alreadyDeleted?: boolean } = {}) {
  const rows: Record<string, Row[]> = {
    sync_accounts: [{ ...ACCOUNT, provider: 'google', sync_direction: options.direction ?? 'import', metadata: {} }],
    sync_connections: [{ account_id: ACCOUNT.id, health: 'healthy' }],
    sync_calendars: [{ id: 'calendar', family_id: ACCOUNT.family_id, provider: 'google', external_id: 'primary', sync_token: STALE }],
    sync_reminder_lists: [{ id: 'list', family_id: ACCOUNT.family_id, provider: 'google', external_id: '@default' }],
    sync_calendar_events: [{ id: 'local', calendar_id: 'calendar', family_id: ACCOUNT.family_id, provider: 'google', external_id: 'deleted', deleted_at: null }],
    sync_external_mappings: [{ id: 'mapping', account_id: ACCOUNT.id, provider: 'google', item_type: 'event', external_id: 'deleted', local_id: 'local', metadata: {} },
      { id: 'foreign-map', account_id: 'another-account', provider: 'google', item_type: 'event', external_id: 'foreign-only', local_id: 'foreign-local', metadata: {} }],
    sync_jobs: [], sync_job_runs: [], sync_provider_errors: [], sync_reminders: [],
  };
  rows.sync_calendar_events.push({ id: 'foreign-local', family_id: 'another-family', deleted_at: null });
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Row : null;
    calls.push({ url, method, body });
    if (url.origin === 'https://tasks.googleapis.com' && method === 'GET'
      && url.pathname === '/tasks/v1/lists/%40default/tasks') return json({ items: [] });
    if (url.origin === 'https://www.googleapis.com') {
      if (options.direction === 'two_way') {
        if (method === 'POST' && url.pathname === '/calendar/v3/calendars/primary/events') return json({ id: 'exported', etag: 'synthetic-etag' });
        if (method === 'DELETE' && url.pathname === '/calendar/v3/calendars/primary/events/exported') {
          return options.alreadyDeleted
            ? json({ error: { code: 410, errors: [{ domain: 'global', reason: 'deleted' }], message: 'Resource has been deleted' } }, 410)
            : new Response(null, { status: 204 });
        }
      }
      if (method !== 'GET') throw new Error(`Unexpected outgoing synthetic provider write: ${method}`);
      if (url.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [{ id: 'primary', summary: 'Synthetic', primary: true, timeZone: 'UTC' }] });
      if (url.pathname === '/calendar/v3/calendars/primary/events') {
        expect(url.searchParams.get('showDeleted')).toBe('true');
        expect(url.searchParams.get('singleEvents')).toBe('false');
        expect(url.searchParams.get('syncToken')).toBe(rows.sync_calendars[0].sync_token);
        return json({ items: events, nextSyncToken: NEXT });
      }
      throw new Error(`Unexpected synthetic provider path: ${url.pathname}`);
    }
    if (url.origin !== 'https://sync-fixture.invalid' || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error(`Unexpected synthetic request: ${url.origin}${url.pathname}`);
    }
    const table = url.pathname.slice('/rest/v1/'.length);
    const tableRows = rows[table];
    if (!tableRows) throw new Error(`Unexpected synthetic table: ${table}`);
    const selected = tableRows.filter(row => [...url.searchParams].every(([column, value]) => {
      if (column === 'select' || column === 'limit') return true;
      if (!value.startsWith('eq.')) throw new Error(`Unexpected synthetic filter: ${column}=${value}`);
      return String(row[column]) === value.slice(3);
    }));
    let result = url.searchParams.has('limit') ? selected.slice(0, Number(url.searchParams.get('limit'))) : selected;
    if (method === 'PATCH') {
      if (table === 'sync_calendar_events' && body?.deleted_at) {
        if (options.failedDelete) return json({ code: '42501', message: 'Synthetic deletion refused', details: null, hint: null }, 403);
        if (options.zeroDelete) return json(null);
      }
      result.forEach(row => Object.assign(row, body));
    } else if (method === 'POST') {
      if (!body) throw new Error('Synthetic insert body missing');
      result = [{ id: `${table}-${tableRows.length}`, ...body }];
      tableRows.push(...result);
    } else if (method === 'DELETE') {
      rows[table] = tableRows.filter(row => !result.includes(row));
    } else if (method !== 'GET') throw new Error(`Unexpected synthetic database method: ${method}`);
    const singular = new Headers(init?.headers).get('accept')?.includes('application/vnd.pgrst.object+json');
    return json(singular ? result[0] ?? null : result);
  };
  const db = createClient<Database>('https://sync-fixture.invalid', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  vi.stubGlobal('fetch', fetch);
  return { db, rows, calls };
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('standard Google pull preserves deletion identities', () => {
  it('keeps an identity-only deletion beside live rows and advances the returned cursor', async () => {
    fixture([{ id: 'deleted', status: 'cancelled' },
      { id: 'live', summary: 'Synthetic live', start: { dateTime: '2026-06-21T09:00:00Z' } },
      { id: 'malformed-live', status: 'confirmed' }]);
    const pull = await googleAdapter.pullEvents('synthetic-access-token', 'primary', STALE);
    expect(pull.events.map(event => event.external_id)).toEqual(['deleted', 'live']);
    expect(pull.events[0]).toMatchObject({ cancelled: true, status: 'cancelled', starts_at: '', ends_at: null });
    expect(pull.events[1]).toMatchObject({ cancelled: false, starts_at: '2026-06-21T09:00:00.000Z' });
    expect(pull.nextCursor).toBe(NEXT);
  });
});

for (const engine of ['google', 'generic'] as const) {
  const run = (db: ReturnType<typeof fixture>['db']) => engine === 'google'
    ? runGoogleSync(db, ACCOUNT) : runProviderSync(db, ACCOUNT, googleAdapter);
  describe(`${engine} engine uses mapped Google tombstones before saving its cursor`, () => {
    it.each([false, true])('retires an exported event mapping after confirmed deletion (already deleted: %s)', async alreadyDeleted => {
      const events: GEvent[] = [];
      const { db, rows, calls } = fixture(events, { direction: 'two_way', alreadyDeleted });
      rows.sync_external_mappings.length = 0;
      Object.assign(rows.sync_calendar_events[0], {
        provider: 'internal', title: 'Synthetic local appointment', starts_at: '2026-06-21T09:00:00Z',
        ends_at: '2026-06-21T10:00:00Z', timezone: 'UTC',
      });
      expect(await run(db)).toMatchObject({ imported: 0, exported: 1 });
      expect(rows.sync_external_mappings[0]).toMatchObject({ local_id: 'local', external_id: 'exported' });
      events.push({ id: 'exported', status: 'cancelled' });
      const result = await run(db);
      expect(result).toMatchObject({ imported: 1, exported: 1 });
      expect(result.error).toBeUndefined();
      expect(rows.sync_calendar_events[0]).toMatchObject({ provider: 'internal', deleted_at: expect.any(String) });
      expect(rows.sync_external_mappings).toEqual([]);
      expect(calls.filter(call => call.url.origin === 'https://www.googleapis.com' && call.method !== 'GET')
        .map(call => call.method)).toEqual(['POST', 'DELETE']);
      expect(rows.sync_provider_errors).toEqual([]);
      events.length = 0;
      expect((await run(db)).error).toBeUndefined();
      expect(calls.filter(call => call.url.origin === 'https://www.googleapis.com' && call.method === 'DELETE')).toHaveLength(1);
    });

    it.each([{ id: 'deleted', status: 'cancelled' }, CANCELLED_INSTANCE])
      ('deletes only the matching account item without writing invented timing (%j)', async tombstone => {
        const { db, rows, calls } = fixture([tombstone]);
        const result = await run(db);
        expect(result).toMatchObject({ imported: 1, exported: 0, conflicts: 0 });
        expect(result.error).toBeUndefined();
        expect(rows.sync_calendar_events[0].deleted_at).toEqual(expect.any(String));
        expect(rows.sync_calendar_events[1].deleted_at).toBeNull();
        expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
        const deletion = calls.findIndex(call => call.url.pathname === '/rest/v1/sync_calendar_events' && call.method === 'PATCH');
        const cursor = calls.findIndex(call => call.url.pathname === '/rest/v1/sync_calendars' && call.method === 'PATCH');
        expect(deletion).toBeGreaterThan(-1);
        expect(cursor).toBeGreaterThan(deletion);
        expect(calls[deletion].body).not.toHaveProperty('starts_at');
        expect(calls.filter(call => call.method === 'POST' && call.url.pathname === '/rest/v1/sync_calendar_events')).toEqual([]);
      });

    it.each(['family', 'calendar'] as const)('refuses a mapping whose target belongs to another %s', async scope => {
      const { db, rows } = fixture([{ id: 'deleted', status: 'cancelled' }]);
      rows.sync_external_mappings[0].local_id = 'foreign-local';
      Object.assign(rows.sync_calendar_events[1], {
        calendar_id: scope === 'calendar' ? 'another-calendar' : 'calendar',
        family_id: scope === 'family' ? 'another-family' : ACCOUNT.family_id,
      });
      expect((await run(db)).error).toContain('cancelled event update');
      expect(rows.sync_calendar_events.every(row => row.deleted_at === null)).toBe(true);
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
    });

    it('skips unknown and foreign-account deletion IDs rather than creating events', async () => {
      const { db, rows, calls } = fixture([{ id: 'unknown', status: 'cancelled' }, { id: 'foreign-only', status: 'cancelled' }]);
      expect(await run(db)).toMatchObject({ imported: 0, skipped: 2 });
      expect(rows.sync_calendar_events.every(row => row.deleted_at === null)).toBe(true);
      expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
      expect(calls.filter(call => call.url.pathname === '/rest/v1/sync_calendar_events' && call.method !== 'GET')).toEqual([]);
    });

    it.each(['failedDelete', 'zeroDelete'] as const)('keeps the old cursor on %s and reports failed sync', async condition => {
      const { db, rows } = fixture([{ id: 'deleted', status: 'cancelled' }], { [condition]: true });
      expect((await run(db)).error).toContain('cancelled event update');
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_calendar_events[0].deleted_at).toBeNull();
      expect(rows.sync_job_runs[0].status).toBe('failed');
      expect(rows.sync_connections[0].health).toBe('error');
    });

    it('still leaves a disabled connection untouched before provider access', async () => {
      const { db, rows, calls } = fixture([{ id: 'deleted', status: 'cancelled' }], { direction: 'disabled' });
      expect((await run(db)).error).toBeTruthy();
      expect(calls.every(call => call.url.origin === 'https://sync-fixture.invalid')).toBe(true);
      expect(rows.sync_jobs).toEqual([]);
      expect(rows.sync_calendar_events[0].deleted_at).toBeNull();
    });
  });
}
