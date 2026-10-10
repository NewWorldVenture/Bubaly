import { createClient } from '@supabase/supabase-js';
import { expect, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import type { GEvent, GTask } from '@/lib/sync/providers/google';

// Intercepts only synthetic SDK/provider requests; PostgreSQL behavior has its
// independent real-role fixture. No request can reach a hosted service.
type Row = Record<string, unknown>;
type Call = { url: URL; method: string; body: Row | null };
export const ACCOUNT = { id: 'account', family_id: 'family', user_id: 'owner', external_id: 'synthetic@example.invalid' };
export const NEXT = 'next-synthetic-cursor';
export const STALE = 'prior-synthetic-cursor';
export const CANCELLED_INSTANCE = { id: 'deleted', status: 'cancelled', recurringEventId: 'series',
  originalStartTime: { dateTime: '2026-06-21T09:00:00Z' } };

export function syncSdkFixture(events: GEvent[], options: {
  failedDelete?: boolean; zeroDelete?: boolean; direction?: string; alreadyDeleted?: boolean;
  rpcFailure?: 'container' | 'item' | 'mapping' | 'lock'; malformedReceipt?: boolean; uncertainReceipt?: boolean; racedFields?: Row;
  tasks?: GTask[]; zeroLiveWrite?: boolean; moveBeforeLiveWrite?: boolean;
  moveMappingBeforeWrite?: boolean; zeroPushWrite?: boolean;
} = {}) {
  const rows: Record<string, Row[]> = {
    sync_accounts: [{ ...ACCOUNT, provider: 'google', sync_direction: options.direction ?? 'import', metadata: {} }],
    // A connection syncs only while its owner is an active member of its family.
    family_members: [{ id: 'owner-member', family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id, role: 'parent', is_active: true }],
    sync_connections: [{ account_id: ACCOUNT.id, health: 'healthy' }],
    sync_calendars: [{ id: 'calendar', account_id: ACCOUNT.id, family_id: ACCOUNT.family_id, provider: 'google', external_id: 'primary', sync_token: STALE }],
    sync_reminder_lists: [{ id: 'list', account_id: ACCOUNT.id, family_id: ACCOUNT.family_id, provider: 'google', external_id: '@default' }],
    sync_calendar_events: [{ id: 'local', calendar_id: 'calendar', family_id: ACCOUNT.family_id, provider: 'google', external_id: 'deleted', deleted_at: null }],
    sync_external_mappings: [{ id: 'mapping', family_id: ACCOUNT.family_id, account_id: ACCOUNT.id, provider: 'google', item_type: 'event', external_id: 'deleted', local_id: 'local', metadata: {} },
      { id: 'foreign-map', family_id: 'another-family', account_id: 'another-account', provider: 'google', item_type: 'event', external_id: 'foreign-only', local_id: 'foreign-local', metadata: {} }],
    sync_jobs: [], sync_job_runs: [], sync_provider_errors: [], sync_reminders: [],
  };
  rows.sync_calendar_events.push({ id: 'foreign-local', family_id: 'another-family', deleted_at: null });
  if (options.tasks?.length) {
    rows.sync_reminders.push({ id: 'local-task', family_id: ACCOUNT.family_id, list_id: 'list', provider: 'google',
      title: 'Synthetic task original', content_hash: null, deleted_at: null, is_completed: false });
    rows.sync_external_mappings.push({ id: 'task-mapping', family_id: ACCOUNT.family_id, account_id: ACCOUNT.id,
      provider: 'google', item_type: 'reminder', external_id: 'remote-task', local_id: 'local-task', metadata: {} });
  }
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Row : null;
    calls.push({ url, method, body });
    if (url.origin === 'https://tasks.googleapis.com') {
      if (method === 'GET' && url.pathname === '/tasks/v1/lists/%40default/tasks') return json({ items: options.tasks ?? [] });
      if (options.direction === 'two_way' && method === 'POST' && url.pathname === '/tasks/v1/lists/%40default/tasks') return json({ id: 'exported-task' });
      if (options.direction === 'two_way' && method === 'PATCH' && url.pathname === '/tasks/v1/lists/%40default/tasks/new-task') return json({ id: 'new-task', etag: 'synthetic-updated-etag' });
      throw new Error(`Unexpected synthetic task request: ${method} ${url.pathname}`);
    }
    if (url.origin === 'https://www.googleapis.com') {
      if (options.direction === 'two_way') {
        if (method === 'PATCH' && url.pathname === '/calendar/v3/calendars/primary/events/new-event') return json({ id: 'new-event', etag: 'synthetic-updated-etag' });
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
        const mirror = rows.sync_calendars.find(row => row.account_id === ACCOUNT.id);
        expect(url.searchParams.get('syncToken')).toBe(mirror?.sync_token ?? null);
        return json({ items: events, nextSyncToken: NEXT });
      }
      throw new Error(`Unexpected synthetic provider path: ${url.pathname}`);
    }
    if (url.origin !== 'https://sync-fixture.invalid' || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error(`Unexpected synthetic request: ${url.origin}${url.pathname}`);
    }
    if (url.pathname === '/rest/v1/rpc/ensure_sync_pull_container') {
      if (options.rpcFailure === 'container') return json({ code: 'PGRST202', message: 'Synthetic RPC absent' }, 404);
      if (!body || body.p_account !== ACCOUNT.id || body.p_family !== ACCOUNT.family_id || body.p_user !== ACCOUNT.user_id) throw new Error('Synthetic container identity mismatch');
      const table = body.p_kind === 'event' ? 'sync_calendars' : 'sync_reminder_lists';
      const matching = rows[table].filter(row => row.account_id === body.p_account && row.provider === body.p_provider && row.external_id === body.p_external);
      if (matching.length > 1 || matching.some(row => row.family_id !== body.p_family)) return json({ code: '42501', message: 'Synthetic container scope refused' }, 403);
      let mirror = matching[0];
      if (!mirror) { mirror = { id: table + '-mirror', family_id: body.p_family, user_id: body.p_user, account_id: body.p_account,
        provider: body.p_provider, external_id: body.p_external, name: body.p_name, timezone: body.p_timezone, color: body.p_color, sync_token: null };
        rows[table].push(mirror); }
      return json({ id: mirror.id, sync_token: mirror.sync_token ?? null });
    }
    if (url.pathname === '/rest/v1/rpc/create_sync_pull_item') {
      if (!body || body.p_account !== ACCOUNT.id || body.p_family !== ACCOUNT.family_id || body.p_user !== ACCOUNT.user_id) throw new Error('Synthetic item identity mismatch');
      if (options.rpcFailure) return json({ code: options.rpcFailure === 'item' ? 'PGRST202'
        : options.rpcFailure === 'lock' ? '55P03' : '42501', message: 'Synthetic item transaction refused' }, options.rpcFailure === 'item' ? 404 : 403);
      const table = body.p_kind === 'event' ? 'sync_calendar_events' : 'sync_reminders';
      let mapping = rows.sync_external_mappings.find(row => row.account_id === body.p_account && row.provider === body.p_provider && row.item_type === body.p_kind && row.external_id === body.p_external);
      const created = !mapping && !options.racedFields;
      if (!mapping) {
        const local = { id: table + '-atomic', ...body.p_fields as Row, ...options.racedFields, family_id: body.p_family, user_id: body.p_user,
          [body.p_kind === 'event' ? 'calendar_id' : 'list_id']: body.p_container,
          provider: options.racedFields?.provider ?? body.p_provider, external_id: body.p_external,
          content_hash: options.racedFields?.content_hash ?? body.p_hash, metadata: { origin: 'remote' }, deleted_at: null };
        mapping = { id: table + '-map', family_id: body.p_family, account_id: body.p_account, provider: body.p_provider,
          item_type: body.p_kind, local_id: local.id, external_id: body.p_external,
          metadata: { lastHash: options.racedFields?.baseHash ?? body.p_hash } };
        rows[table].push(local); rows.sync_external_mappings.push(mapping);
      }
      if (options.uncertainReceipt) { options.uncertainReceipt = false; throw new Error('Synthetic response lost after commit'); }
      return json(options.malformedReceipt ? { created, mapping: { ...mapping, family_id: 'another-family' } } : { created, mapping });
    }
    const table = url.pathname.slice('/rest/v1/'.length);
    const tableRows = rows[table];
    if (!tableRows) throw new Error(`Unexpected synthetic table: ${table}`);
    if (table === 'sync_calendar_events' && method === 'PATCH' && body?.title && options.moveBeforeLiveWrite) {
      rows.sync_calendar_events[0].family_id = 'another-family';
    }
    if (table === 'sync_external_mappings' && method === 'PATCH' && options.moveMappingBeforeWrite) {
      rows.sync_external_mappings[0].local_id = 'foreign-local';
    }
    const selected = tableRows.filter(row => [...url.searchParams].every(([column, value]) => {
      if (column === 'select' || column === 'limit') return true;
      if (!value.startsWith('eq.')) throw new Error(`Unexpected synthetic filter: ${column}=${value}`);
      return String(row[column]) === value.slice(3);
    }));
    let result = url.searchParams.has('limit') ? selected.slice(0, Number(url.searchParams.get('limit'))) : selected;
    if (method === 'PATCH') {
      if (table === 'sync_calendar_events' && body?.title && options.zeroLiveWrite) return json(null);
      if (table === 'sync_calendar_events' && body?.content_hash && !body.title && options.zeroPushWrite) return json(null);
      if (table === 'sync_calendar_events' && body?.deleted_at) {
        if (options.failedDelete) return json({ code: '42501', message: 'Synthetic deletion refused', details: null, hint: null }, 403);
        if (options.zeroDelete) return json(null);
      }
      result.forEach(row => Object.assign(row, body));
    } else if (method === 'POST') {
      if (!body) throw new Error('Synthetic insert body missing');
      if (table === 'sync_external_mappings' && options.rpcFailure === 'mapping') return json({ code: '42501', message: 'Synthetic mapping refused' }, 403);
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
