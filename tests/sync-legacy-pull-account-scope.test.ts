import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import { runGoogleSync } from '@/lib/sync/engine/google';
import { runProviderSync } from '@/lib/sync/engine/generic';
import { resetSyncPullMigrationWarnings } from '@/lib/sync/persistence';
import { syncSdkFixture, ACCOUNT, STALE } from './helpers/sync-sdk-fixture';

vi.mock('@/lib/sync/accounts', async original => ({
  ...await original<typeof import('@/lib/sync/accounts')>(), getValidAccessToken: async () => 'synthetic-access-token',
}));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'synthetic-access-token' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const event = { id: 'new-event', summary: 'Synthetic new event', start: { dateTime: '2026-06-21T09:00:00Z' } };
const task = { id: 'new-task', title: 'Synthetic new reminder' };
// Another provider account of the same household: Google's '@default' task list
// and the fixture's 'primary' calendar have the same remote id for every account.
const OTHER = { account_id: 'other-account', family_id: ACCOUNT.family_id, user_id: 'other-owner', provider: 'google' };

beforeEach(() => {
  resetSyncPullMigrationWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const engine of ['google', 'generic'] as const) {
  const run = (db: ReturnType<typeof syncSdkFixture>['db']) => engine === 'google'
    ? runGoogleSync(db, ACCOUNT) : runProviderSync(db, ACCOUNT, googleAdapter);

  describe(`${engine} pull without 0494 keeps each provider account's mirror`, () => {
    it('a second account in the household gets its own task list and never exports the first account\'s reminders', async () => {
      const { db, rows, calls } = syncSdkFixture([], { rpcFailure: 'missing', direction: 'two_way', tasks: [task] });
      rows.sync_reminder_lists = [{ id: 'other-list', ...OTHER, external_id: '@default' }];
      rows.sync_reminders = [{ id: 'other-private', list_id: 'other-list', family_id: ACCOUNT.family_id, provider: 'internal',
        title: 'Another account private task', content_hash: null, deleted_at: null, is_completed: false }];
      rows.sync_external_mappings = rows.sync_external_mappings.filter(row => row.item_type !== 'reminder');

      expect((await run(db)).error).toBeUndefined();
      const own = rows.sync_reminder_lists.filter(row => row.account_id === ACCOUNT.id);
      expect(own).toEqual([expect.objectContaining({ family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
        provider: 'google', external_id: '@default' })]);
      expect(rows.sync_reminder_lists.find(row => row.id === 'other-list')).toMatchObject(OTHER);
      expect(rows.sync_reminders.find(row => row.external_id === 'new-task')?.list_id).toBe(own[0].id);
      const exported = calls.filter(call => call.url.origin === 'https://tasks.googleapis.com' && call.method !== 'GET');
      expect(exported).toEqual([]);
      expect(rows.sync_external_mappings.some(row => row.local_id === 'other-private')).toBe(false);
    });

    it('a second account gets its own calendar mirror and leaves the other account\'s cursor alone', async () => {
      const { db, rows } = syncSdkFixture([event], { rpcFailure: 'missing' });
      rows.sync_calendars = [{ id: 'other-calendar', ...OTHER, external_id: 'primary', sync_token: STALE }];

      expect((await run(db)).error).toBeUndefined();
      const own = rows.sync_calendars.filter(row => row.account_id === ACCOUNT.id);
      expect(own).toEqual([expect.objectContaining({ family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id, external_id: 'primary' })]);
      expect(rows.sync_calendars.find(row => row.id === 'other-calendar')?.sync_token).toBe(STALE);
      expect(rows.sync_calendar_events.find(row => row.external_id === 'new-event')?.calendar_id).toBe(own[0].id);
    });

    it('an account mirror that names another owner fails closed before pulling', async () => {
      const { db, rows, calls } = syncSdkFixture([], { rpcFailure: 'missing', tasks: [task] });
      rows.sync_reminder_lists[0].user_id = 'someone-else';
      expect((await run(db)).error).toContain('reminder list scope');
      expect(rows.sync_reminder_lists).toHaveLength(1);
      expect(calls.some(call => call.url.origin === 'https://tasks.googleapis.com')).toBe(false);
    });
  });

  describe(`${engine} separate item and mapping writes without 0494 are retry safe`, () => {
    for (const kind of ['event', 'reminder'] as const) {
      const table = kind === 'event' ? 'sync_calendar_events' : 'sync_reminders';
      const external = kind === 'event' ? event.id : task.id;
      const container = kind === 'event' ? { calendar_id: 'calendar' } : { list_id: 'list' };
      const fixture = (options: Parameters<typeof syncSdkFixture>[1] = {}) => {
        // The fixture reads the options object live, so a test can clear a failure between runs.
        const state = syncSdkFixture(kind === 'event' ? [event] : [],
          Object.assign(options, { rpcFailure: 'missing' as const, tasks: kind === 'reminder' ? [task] : [] }));
        state.rows.sync_external_mappings = state.rows.sync_external_mappings.filter(row => row.item_type !== kind);
        state.rows[table] = [];
        return state;
      };

      it(`${kind} a refused mapping write keeps the item and the retry adopts it into exactly one pair`, async () => {
        const options: Parameters<typeof syncSdkFixture>[1] = { rawMappingFailure: true };
        const { db, rows } = fixture(options);
        expect((await run(db)).error).toContain(`${kind} mapping creation`);
        const left = rows[table].filter(row => row.external_id === external);
        expect(left).toHaveLength(1);
        expect(rows.sync_external_mappings.filter(row => row.item_type === kind && row.external_id === external)).toEqual([]);
        options.rawMappingFailure = false;
        expect((await run(db)).error).toBeUndefined();
        const items = rows[table].filter(row => row.external_id === external);
        expect(items).toEqual([expect.objectContaining({ id: left[0].id })]);
        const maps = rows.sync_external_mappings.filter(row => row.item_type === kind && row.external_id === external);
        expect(maps).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: items[0].id })]);
      });

      it(`${kind} a mapping write that commits but reports an error keeps its item, so the next run is not wedged`, async () => {
        const options: Parameters<typeof syncSdkFixture>[1] = { committedMappingFailure: true };
        const { db, rows, calls } = fixture(options);
        expect((await run(db)).error).toContain(`${kind} mapping creation`);
        const items = rows[table].filter(row => row.external_id === external);
        expect(items).toHaveLength(1);
        const maps = () => rows.sync_external_mappings.filter(row => row.item_type === kind && row.external_id === external);
        expect(maps()).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: items[0].id })]);
        expect(calls.some(call => call.method === 'DELETE' && call.url.pathname === `/rest/v1/${table}`)).toBe(false);
        options.committedMappingFailure = false;
        expect((await run(db)).error).toBeUndefined();
        expect(rows[table].filter(row => row.external_id === external)).toEqual([expect.objectContaining({ id: items[0].id })]);
        expect(maps()).toEqual([expect.objectContaining({ local_id: items[0].id })]);
      });

      it(`${kind} a retry adopts an unmapped item left by an interrupted attempt instead of duplicating it`, async () => {
        const { db, rows } = fixture();
        rows[table].push({ id: 'orphan', ...container, family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
          provider: 'google', external_id: external, title: 'Stale partial write', deleted_at: '2026-06-01T00:00:00Z' });
        expect((await run(db)).error).toBeUndefined();
        const items = rows[table].filter(row => row.external_id === external);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id: 'orphan', title: kind === 'event' ? event.summary : task.title, deleted_at: null,
          user_id: ACCOUNT.user_id,
          content_hash: expect.stringMatching(/^[a-f0-9]{64}$/), metadata: { origin: 'remote' } });
        expect(rows.sync_external_mappings.filter(row => row.item_type === kind && row.external_id === external))
          .toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan', metadata: { lastHash: items[0].content_hash } })]);
      });

      it(`${kind} an unmapped item owned by someone else is never adopted`, async () => {
        const { db, rows } = fixture();
        rows[table].push({ id: 'foreign', ...container, family_id: ACCOUNT.family_id, user_id: 'someone-else',
          provider: 'google', external_id: external, title: 'Someone else', deleted_at: null });
        expect((await run(db)).error).toContain(`${kind} retry scope`);
        expect(rows[table].filter(row => row.external_id === external)).toEqual([expect.objectContaining({ id: 'foreign', title: 'Someone else' })]);
        expect(rows.sync_external_mappings.filter(row => row.local_id === 'foreign')).toEqual([]);
      });

      it(`${kind} an existing item another mapping claims is never adopted`, async () => {
        const { db, rows } = fixture();
        rows[table].push({ id: 'claimed', ...container, family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
          provider: 'google', external_id: external, title: 'Claimed elsewhere', deleted_at: null });
        rows.sync_external_mappings.push({ id: 'elsewhere', family_id: ACCOUNT.family_id, account_id: 'other-account',
          provider: 'google', item_type: kind, external_id: 'other-remote', local_id: 'claimed', metadata: {} });
        expect((await run(db)).error).toContain(`${kind} retry scope`);
        expect(rows[table].filter(row => row.external_id === external)).toEqual([expect.objectContaining({ id: 'claimed', title: 'Claimed elsewhere' })]);
        expect(rows.sync_external_mappings.filter(row => row.local_id === 'claimed')).toHaveLength(1);
      });
    }
  });
}
