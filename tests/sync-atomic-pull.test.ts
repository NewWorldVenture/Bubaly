import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import { eventContentHash, googleEventToRow, googleTaskToReminderRow, reminderContentHash } from '@/lib/sync/providers/google';
import { runGoogleSync } from '@/lib/sync/engine/google';
import { runProviderSync } from '@/lib/sync/engine/generic';
import { resetSyncPullMigrationWarnings } from '@/lib/sync/persistence';
import { syncSdkFixture, ACCOUNT, NEXT, STALE } from './helpers/sync-sdk-fixture';

vi.mock('@/lib/sync/accounts', async original => ({
  ...await original<typeof import('@/lib/sync/accounts')>(), getValidAccessToken: async () => 'synthetic-access-token',
}));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'synthetic-access-token' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const event = { id: 'new-event', summary: 'Synthetic new event', start: { dateTime: '2026-06-21T09:00:00Z' } };
const task = { id: 'new-task', title: 'Synthetic new reminder' };
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const engine of ['google', 'generic'] as const) {
  const run = (db: ReturnType<typeof syncSdkFixture>['db']) => engine === 'google'
    ? runGoogleSync(db, ACCOUNT) : runProviderSync(db, ACCOUNT, googleAdapter);
  describe(`${engine} real SDK atomic pull`, () => {
    for (const kind of ['event', 'reminder'] as const) {
      const fixture = (options: Parameters<typeof syncSdkFixture>[1] = {}) => {
        const state = syncSdkFixture(kind === 'event' ? [event] : [], { tasks: kind === 'reminder' ? [task] : [], ...options });
        state.rows.sync_external_mappings.length = 0;
        state.rows.sync_calendar_events.length = 0;
        state.rows.sync_reminders.length = 0;
        return state;
      };
      const table = kind === 'event' ? 'sync_calendar_events' : 'sync_reminders';
      it(`${kind} sends one scoped transactional request and never raw inserts the pair`, async () => {
        const { db, rows, calls } = fixture();
        expect(await run(db)).toMatchObject({ imported: 1, skipped: 0 });
        expect(rows[table]).toHaveLength(1);
        expect(rows.sync_external_mappings).toHaveLength(1);
        const request = calls.find(call => call.url.pathname === '/rest/v1/rpc/create_sync_pull_item');
        expect(request?.body).toMatchObject({ p_account: ACCOUNT.id, p_family: ACCOUNT.family_id, p_user: ACCOUNT.user_id,
          p_provider: 'google', p_kind: kind, p_container: kind === 'event' ? 'calendar' : 'list',
          p_external: kind === 'event' ? 'new-event' : 'new-task', p_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(calls.filter(call => call.method === 'POST' && [table, 'sync_external_mappings'].some(name => call.url.pathname === `/rest/v1/${name}`))).toEqual([]);
        expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
      });
      it(`${kind} failed mapping transaction leaves no partial item and retains the cursor`, async () => {
        const { db, rows } = fixture({ rpcFailure: 'mapping' });
        expect((await run(db)).error).toContain(`${kind} and mapping creation`);
        expect(rows[table]).toEqual([]);
        expect(rows.sync_external_mappings).toEqual([]);
        expect(rows.sync_calendars[0].sync_token).toBe(STALE);
        expect(rows.sync_job_runs[0].status).toBe('failed');
      });
      // Owner decision: until held 0494 is applied, a missing item RPC takes the
      // previous production writes (item, then mapping) instead of refusing.
      it(`${kind} missing item RPC (0494 not applied) writes the item and mapping directly, as before`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        resetSyncPullMigrationWarnings();
        const { db, rows, calls } = fixture({ rpcFailure: 'item' });
        expect(await run(db)).toMatchObject({ imported: 1, skipped: 0 });
        expect(rows[table]).toHaveLength(1);
        expect(rows[table][0]).toMatchObject({ family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id, provider: 'google',
          external_id: kind === 'event' ? 'new-event' : 'new-task', sync_status: 'synced', metadata: { origin: 'remote' },
          [kind === 'event' ? 'calendar_id' : 'list_id']: kind === 'event' ? 'calendar' : 'list',
          content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(rows.sync_external_mappings).toHaveLength(1);
        expect(rows.sync_external_mappings[0]).toMatchObject({ family_id: ACCOUNT.family_id, account_id: ACCOUNT.id,
          provider: 'google', item_type: kind, local_id: rows[table][0].id, metadata: { lastHash: rows[table][0].content_hash } });
        const posts = calls.filter(call => call.method === 'POST' && [table, 'sync_external_mappings'].some(name => call.url.pathname === `/rest/v1/${name}`));
        expect(posts.map(call => call.url.pathname)).toEqual([`/rest/v1/${table}`, '/rest/v1/sync_external_mappings']);
        expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
        expect(rows.sync_job_runs[0].status).toBe('succeeded');
        expect(warn.mock.calls.flat().join(' ')).toContain('0494_sync_atomic_pull.sql');
      });
      it.each(['item-unnamed', 'item-helper'] as const)(`${kind} a non-missing item RPC failure (%s) still fails without direct writes`, async failure => {
        const { db, rows, calls } = fixture({ rpcFailure: failure });
        expect((await run(db)).error).toContain(`${kind} and mapping creation`);
        expect(rows[table]).toEqual([]);
        expect(calls.some(call => call.method === 'POST' && call.url.pathname === `/rest/v1/${table}`)).toBe(false);
        expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      });
      it(`${kind} database lock refusal fails the run and leaves the batch replayable`, async () => {
        const { db, rows } = fixture({ rpcFailure: 'lock' });
        expect((await run(db)).error).toContain(`${kind} and mapping creation`);
        expect(rows[table]).toEqual([]);
        expect(rows.sync_external_mappings).toEqual([]);
        expect(rows.sync_calendars[0].sync_token).toBe(STALE);
        expect(rows.sync_job_runs[0].status).toBe('failed');
      });
      it(`${kind} retries a lost commit response with the same item and mapping`, async () => {
        const { db, rows } = fixture({ uncertainReceipt: true });
        expect((await run(db)).error).toBeTruthy();
        expect(rows.sync_calendars[0].sync_token).toBe(STALE);
        const localId = rows[table][0].id;
        const mapId = rows.sync_external_mappings[0].id;
        expect((await run(db)).error).toBeUndefined();
        expect(rows[table]).toHaveLength(1);
        expect(rows.sync_external_mappings).toHaveLength(1);
        expect(rows[table][0].id).toBe(localId);
        expect(rows.sync_external_mappings[0].id).toBe(mapId);
        expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
      });
      it(`${kind} reconciles a raced mapping through existing conflict handling`, async () => {
        const { db, rows } = fixture({ racedFields: { title: 'Synthetic local edit', content_hash: 'b'.repeat(64), baseHash: 'a'.repeat(64) } });
        rows.sync_conflicts = [];
        const result = await run(db);
        expect(result).toMatchObject({ imported: 0, conflicts: 1 });
        expect(result.error).toBeUndefined();
        expect(rows[table][0].title).toBe('Synthetic local edit');
        expect(rows.sync_conflicts[0]).toMatchObject({ local_id: rows[table][0].id, item_type: kind, status: 'open' });
      });
      it(`${kind} reconciles an unchanged-base raced mapping through the normal update`, async () => {
        const { db, rows } = fixture({ racedFields: { title: 'Old remote content', content_hash: 'a'.repeat(64), baseHash: 'a'.repeat(64) } });
        expect(await run(db)).toMatchObject({ imported: 1, conflicts: 0 });
        expect(rows[table][0].title).toBe(kind === 'event' ? event.summary : task.title);
        expect(rows.sync_external_mappings[0].metadata).toEqual({ lastHash: rows[table][0].content_hash });
      });
      it.each(['existing', 'raced'] as const)(`${kind} preserves and exports a local-only edit in two-way mode (%s)`, async route => {
        const remote = kind === 'event' ? googleEventToRow(event)! : googleTaskToReminderRow(task);
        const remoteHash = 'starts_at' in remote ? eventContentHash(remote) : reminderContentHash(remote);
        const localHash = 'b'.repeat(64);
        const fields = { ...remote, provider: 'internal', title: 'Synthetic local-only edit', content_hash: localHash, baseHash: remoteHash };
        const { db, rows, calls } = fixture({ direction: 'two_way', ...(route === 'raced' ? { racedFields: fields } : {}) });
        if (route === 'existing') {
          rows[table].push({ ...fields, id: 'owned-edit', family_id: ACCOUNT.family_id,
            [kind === 'event' ? 'calendar_id' : 'list_id']: kind === 'event' ? 'calendar' : 'list', deleted_at: null });
          rows.sync_external_mappings.push({ id: 'owned-map', family_id: ACCOUNT.family_id, account_id: ACCOUNT.id,
            provider: 'google', item_type: kind, external_id: kind === 'event' ? event.id : task.id,
            local_id: 'owned-edit', metadata: { lastHash: remoteHash } });
        }
        expect(await run(db)).toMatchObject({ imported: 0, skipped: 1, exported: 1, conflicts: 0 });
        expect(rows[table][0].title).toBe('Synthetic local-only edit');
        expect(rows[table][0].content_hash).toBe(localHash);
        const outgoing = calls.filter(call => call.url.origin.endsWith('googleapis.com') && call.method === 'PATCH');
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0].body).toMatchObject(kind === 'event' ? { summary: 'Synthetic local-only edit' } : { title: 'Synthetic local-only edit' });
        expect(rows.sync_external_mappings[0].metadata).toEqual({ lastHash: localHash });
      });
      it(`${kind} retains import-only remote authority for an unchanged remote snapshot`, async () => {
        const remote = kind === 'event' ? googleEventToRow(event)! : googleTaskToReminderRow(task);
        const remoteHash = 'starts_at' in remote ? eventContentHash(remote) : reminderContentHash(remote);
        const { db, rows } = fixture({ racedFields: { title: 'Local edit', content_hash: 'b'.repeat(64), baseHash: remoteHash } });
        expect(await run(db)).toMatchObject({ imported: 1, exported: 0, conflicts: 0 });
        expect(rows[table][0].title).toBe(kind === 'event' ? event.summary : task.title);
      });
      it(`${kind} rejects a poisoned transaction receipt before a local read or cursor write`, async () => {
        const { db, rows, calls } = fixture({ malformedReceipt: true });
        expect((await run(db)).error).toContain('item receipt scope');
        expect(calls.some(call => call.method === 'GET' && call.url.pathname === `/rest/v1/${table}`)).toBe(false);
        expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      });
    }
    // Owner decision: without 0494 the previous production mirror lookup/insert
    // applies instead of refusing before the pull.
    it('missing mirror RPC (0494 not applied) creates the mirrors directly and pulls, as before', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, rows, calls } = syncSdkFixture([event], { rpcFailure: 'missing', tasks: [task] });
      rows.sync_calendars.length = 0;
      rows.sync_reminder_lists.length = 0;
      expect(await run(db)).toMatchObject({ imported: 2 });
      expect(rows.sync_calendars).toEqual([expect.objectContaining({ family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
        account_id: ACCOUNT.id, provider: 'google', external_id: 'primary', timezone: 'UTC', is_owned_locally: false, sync_token: NEXT })]);
      expect(rows.sync_reminder_lists).toEqual([expect.objectContaining({ family_id: ACCOUNT.family_id, account_id: ACCOUNT.id,
        provider: 'google', external_id: '@default', name: 'Google Tasks', is_owned_locally: false })]);
      expect(rows.sync_calendar_events.find(row => row.external_id === 'new-event')?.calendar_id).toBe(rows.sync_calendars[0].id);
      expect(rows.sync_reminders.find(row => row.external_id === 'new-task')?.list_id).toBe(rows.sync_reminder_lists[0].id);
      expect(calls.some(call => call.url.pathname === '/calendar/v3/calendars/primary/events')).toBe(true);
      expect(rows.sync_job_runs[0].status).toBe('succeeded');
    });
    it('missing mirror RPC reuses the existing household mirror and its cursor', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, rows, calls } = syncSdkFixture([], { rpcFailure: 'missing' });
      expect((await run(db)).error).toBeUndefined();
      expect(rows.sync_calendars).toHaveLength(1);
      expect(rows.sync_calendars[0]).toMatchObject({ id: 'calendar', sync_token: NEXT });
      expect(calls.some(call => call.method === 'POST' && ['sync_calendars', 'sync_reminder_lists'].some(name => call.url.pathname === `/rest/v1/${name}`))).toBe(false);
    });
    it('without 0494 the cursor advances after the calendar pull, as before, even if the task pull then fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, rows } = syncSdkFixture([], { rpcFailure: 'missing', tasks: [task], rawMappingFailure: true });
      rows.sync_external_mappings = rows.sync_external_mappings.filter(row => row.item_type !== 'reminder');
      expect((await run(db)).error).toContain('reminder mapping creation');
      expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
      expect(rows.sync_job_runs[0].status).toBe('failed');
    });
    it('a failed direct event write without 0494 keeps the cursor', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, rows } = syncSdkFixture([event], { rpcFailure: 'missing', rawMappingFailure: true });
      expect((await run(db)).error).toContain('event mapping creation');
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
    });
    it.each(['container-unnamed', 'container-denied'] as const)('a non-missing mirror RPC failure (%s) fails before pulling and never creates a raw mirror', async failure => {
      const { db, rows, calls } = syncSdkFixture([event], { rpcFailure: failure });
      rows.sync_calendars.length = 0;
      expect((await run(db)).error).toContain('container admission');
      expect(rows.sync_calendars).toEqual([]);
      expect(calls.some(call => call.method === 'POST' && call.url.pathname === '/rest/v1/sync_calendars')).toBe(false);
      expect(calls.some(call => call.url.pathname === '/calendar/v3/calendars/primary/events')).toBe(false);
    });
  });
}
