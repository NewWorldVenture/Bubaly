import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
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

      // A pull reads the orphan as unmapped and owned by this account, and is
      // paused before its first write (`claim`) or, once its mapping claim has
      // committed, before its item refresh (`refresh`); `atWrite` runs there once.
      const raced = (atWrite: (orphan: Record<string, unknown>) => Promise<void> | void,
        { at = 'claim', direction }: { at?: 'claim' | 'refresh'; direction?: string } = {}) => {
        const remote = kind === 'event' ? { ...event } : { ...task };
        let looked = false, held = false;
        const state = syncSdkFixture(kind === 'event' ? [remote as typeof event] : [], {
          rpcFailure: 'missing', tasks: kind === 'reminder' ? [remote as typeof task] : [], direction,
          gate: async ({ table: target, method, url }) => {
            if (target === 'sync_external_mappings' && method === 'GET' && url.searchParams.get('local_id') === 'eq.orphan') looked = true;
            else if (looked && !held && method !== 'GET' && (at === 'claim'
              ? target === table || target === 'sync_external_mappings' : target === table && method === 'PATCH')) {
              held = true;
              await atWrite(state.rows[table].find(row => row.id === 'orphan')!);
            }
          },
        });
        state.rows.sync_external_mappings = state.rows.sync_external_mappings.filter(row => row.item_type !== kind);
        state.rows[table] = [{ id: 'orphan', ...container, family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
          provider: 'google', external_id: external, title: 'Stale partial write', content_hash: 'stale', deleted_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00.000Z' }];
        return { ...state, remote: remote as { summary?: string; title?: string } };
      };
      const maps = (rows: Record<string, Record<string, unknown>[]>) =>
        rows.sync_external_mappings.filter(row => row.item_type === kind && (row.external_id === external || row.local_id === 'orphan'));

      it(`${kind} a pull paused before adopting never overwrites the newer snapshot a concurrent pull claimed`, async () => {
        let paused!: () => void, resume!: () => void;
        const atA = new Promise<void>(resolve => { paused = resolve; });
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        const { db, rows, remote } = raced(async () => { paused(); await resumed; });
        const pullA = run(db);
        await atA;
        remote[kind === 'event' ? 'summary' : 'title'] = 'Newer remote snapshot';
        expect((await run(db)).error).toBeUndefined();
        const claimedByB = { ...rows[table].find(row => row.id === 'orphan') };
        expect(claimedByB).toMatchObject({ title: 'Newer remote snapshot', deleted_at: null, user_id: ACCOUNT.user_id });
        const [mappingB] = maps(rows);
        expect(mappingB).toMatchObject({ account_id: ACCOUNT.id, local_id: 'orphan', metadata: { lastHash: claimedByB.content_hash } });

        resume();
        await pullA;
        expect(rows[table]).toEqual([claimedByB]);
        expect(maps(rows)).toEqual([mappingB]);
      });

      it(`${kind} a pull paused after its claim commits never removes the association a concurrent pull completed with it`, async () => {
        let paused!: () => void, resume!: () => void;
        const atA = new Promise<void>(resolve => { paused = resolve; });
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        const { db, rows } = raced(async () => { paused(); await resumed; }, { at: 'refresh' });
        const pullA = run(db);
        await atA;
        expect(maps(rows)).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan' })]);

        // B meets A's claim on the ordinary mapped path and completes with it.
        expect((await run(db)).error).toBeUndefined();
        const completedByB = { ...rows[table].find(row => row.id === 'orphan') };
        expect(completedByB).toMatchObject({ title: kind === 'event' ? event.summary : task.title,
          user_id: ACCOUNT.user_id, content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
        const mappingB = { ...maps(rows)[0] };
        expect(mappingB).toMatchObject({ account_id: ACCOUNT.id, local_id: 'orphan', metadata: { lastHash: completedByB.content_hash } });

        resume();
        expect((await pullA).error).toBeDefined();
        expect(maps(rows)).toEqual([mappingB]);
        expect(rows[table]).toEqual([completedByB]);
        // B finished the adoption as A would have: the item is live again.
        expect(completedByB.deleted_at).toBeNull();
        expect(mappingB.sync_status).toBe('synced');
      });

      it(`${kind} an adoption interrupted after its claim is refreshed and completed by a same-snapshot two-way retry`, async () => {
        const { db, rows, calls } = raced(() => new Promise<void>(() => {}), { at: 'refresh', direction: 'two_way' });
        void run(db); // stops for good after its mapping claim commits
        await vi.waitFor(() => expect(maps(rows)).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan' })]));
        // Only the calendar has a cursor; the task list is read whole each time.
        if (kind === 'event') expect(rows.sync_calendars[0].sync_token).toBe(STALE);

        expect((await run(db)).error).toBeUndefined();
        const items = rows[table];
        expect(items).toEqual([expect.objectContaining({ id: 'orphan', title: kind === 'event' ? event.summary : task.title,
          deleted_at: null, user_id: ACCOUNT.user_id, content_hash: expect.stringMatching(/^[a-f0-9]{64}$/), metadata: { origin: 'remote' } })]);
        expect(maps(rows)).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan', sync_status: 'synced',
          metadata: { lastHash: items[0].content_hash } })]);
        expect(calls.filter(call => call.url.origin !== 'https://sync-fixture.invalid' && call.method !== 'GET')).toEqual([]);
        if (kind === 'event') expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
      });

      // An orphan adopted and recovered by several pulls. The nth item refresh
      // (an item write carrying remote content) first runs stages[n]; every
      // generation token a takeover writes to the mapping is recorded.
      const staged = (stages: (() => Promise<void>)[]) => {
        const remote: Record<string, unknown> = kind === 'event' ? { ...event } : { ...task };
        let refreshes = 0;
        const tokens: string[] = [];
        const state = syncSdkFixture(kind === 'event' ? [remote as typeof event] : [], {
          rpcFailure: 'missing', tasks: kind === 'reminder' ? [remote as typeof task] : [],
          gate: async ({ table: target, method, body }) => {
            const adoption = (body?.metadata as { adoption?: { token?: unknown } } | undefined)?.adoption;
            if (target === 'sync_external_mappings' && method === 'PATCH' && typeof adoption?.token === 'string') tokens.push(adoption.token);
            if (target === table && method === 'PATCH' && body?.title !== undefined) await stages[refreshes++]?.();
          },
        });
        state.rows.sync_external_mappings = state.rows.sync_external_mappings.filter(row => row.item_type !== kind);
        state.rows[table] = [{ id: 'orphan', ...container, family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
          provider: 'google', external_id: external, title: 'Stale partial write', content_hash: 'stale', deleted_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00.000Z' }];
        return { ...state, remote, tokens, refreshes: () => refreshes };
      };
      const hang = () => new Promise<void>(() => {});
      const pause = () => {
        let paused!: () => void, resume!: () => void;
        const at = new Promise<void>(resolve => { paused = resolve; });
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        return { at, resume: () => resume(), stage: async () => { paused(); await resumed; } };
      };
      const cancelRemote = (remote: Record<string, unknown>) =>
        Object.assign(remote, kind === 'event' ? { status: 'cancelled' } : { deleted: true });
      const SEEDED_DELETION = '2026-05-01T00:00:00Z';

      it(`${kind} a cancellation after the claim keeps its receipt and association; the paused claimant fails`, async () => {
        const a = pause();
        const { db, rows, remote } = staged([a.stage]);
        const pullA = run(db);
        await a.at; // A's pending claim committed; A is paused before its item refresh
        expect(maps(rows)).toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan', sync_status: 'pending' })]);

        cancelRemote(remote);
        expect((await run(db)).error).toBeUndefined();
        const cancelledByB = { ...rows[table].find(row => row.id === 'orphan') };
        expect(cancelledByB.deleted_at).toEqual(expect.any(String));
        expect(cancelledByB.deleted_at).not.toBe(SEEDED_DELETION);
        const mappingB = { ...maps(rows)[0] };
        expect(mappingB).toMatchObject({ account_id: ACCOUNT.id, local_id: 'orphan', sync_status: 'synced', metadata: {} });

        a.resume();
        expect((await pullA).error).toBeDefined();
        expect(maps(rows)).toEqual([mappingB]);
        expect(rows[table]).toEqual([cancelledByB]);
      });

      it(`${kind} a stale 'syncing' recovery never revives an item a newer pull cancelled`, async () => {
        const r = pause();
        const { db, rows, remote, refreshes } = staged([hang, hang, r.stage]);
        void run(db); // A claims, then stops for good before its refresh
        await vi.waitFor(() => expect(refreshes()).toBe(1));
        void run(db); // S takes the claim over, then stops for good before its refresh
        await vi.waitFor(() => expect(refreshes()).toBe(2));
        expect(maps(rows)).toEqual([expect.objectContaining({ local_id: 'orphan', sync_status: 'syncing' })]);
        const recovery = run(db); // R recovers the stale 'syncing' claim
        await r.at;

        cancelRemote(remote);
        expect((await run(db)).error).toBeUndefined();
        const cancelledByC = { ...rows[table].find(row => row.id === 'orphan') };
        expect(cancelledByC.deleted_at).toEqual(expect.any(String));
        expect(cancelledByC.deleted_at).not.toBe(SEEDED_DELETION);
        const mappingC = { ...maps(rows)[0] };
        expect(mappingC).toMatchObject({ local_id: 'orphan', sync_status: 'synced' });

        r.resume();
        expect((await recovery).error).toBeDefined();
        expect(rows[table]).toEqual([cancelledByC]);
        expect(maps(rows)).toEqual([mappingC]);
      });

      it(`${kind} two recoveries of one claim take distinct generations and only one completes`, async () => {
        const r1 = pause();
        const { db, rows, remote, tokens, refreshes } = staged([hang, r1.stage]);
        void run(db); // A claims, then stops for good before its refresh
        await vi.waitFor(() => expect(refreshes()).toBe(1));
        const first = run(db); // R1 takes the claim over and pauses before its refresh
        await r1.at;

        remote[kind === 'event' ? 'summary' : 'title'] = 'Newer remote snapshot';
        expect((await run(db)).error).toBeUndefined(); // R2 takes it over from R1 and completes
        const completedByR2 = { ...rows[table].find(row => row.id === 'orphan') };
        expect(completedByR2).toMatchObject({ title: 'Newer remote snapshot', deleted_at: null });
        const mappingR2 = { ...maps(rows)[0] };
        expect(mappingR2).toMatchObject({ local_id: 'orphan', sync_status: 'synced', metadata: { lastHash: completedByR2.content_hash } });
        expect(tokens).toHaveLength(2);
        expect(new Set(tokens).size).toBe(2);

        r1.resume();
        expect((await first).error).toBeDefined();
        expect(rows[table]).toEqual([completedByR2]);
        expect(maps(rows)).toEqual([mappingR2]);
      });

      it(`${kind} an orphan that changes owner after the lookup is never adopted`, async () => {
        const { db, rows } = raced(orphan => { orphan.user_id = 'someone-else'; });
        expect((await run(db)).error).toBeDefined();
        expect(rows[table]).toEqual([expect.objectContaining({ id: 'orphan', user_id: 'someone-else', title: 'Stale partial write',
          content_hash: 'stale', deleted_at: '2026-05-01T00:00:00Z' })]);
        expect(maps(rows)).toEqual([]);
      });

      it(`${kind} an orphan edited after the lookup keeps that edit`, async () => {
        const { db, rows } = raced(orphan => { Object.assign(orphan, { title: 'Concurrent edit', updated_at: '2026-05-02T00:00:00.000Z' }); });
        expect((await run(db)).error).toBeDefined();
        expect(rows[table]).toEqual([expect.objectContaining({ id: 'orphan', user_id: ACCOUNT.user_id, title: 'Concurrent edit', content_hash: 'stale' })]);
        expect(maps(rows)).toEqual([]);
      });

      it(`${kind} an adoption whose mapping write commits but reports an error is not wedged`, async () => {
        const options: Parameters<typeof syncSdkFixture>[1] = { committedMappingFailure: true };
        const { db, rows } = fixture(options);
        rows[table].push({ id: 'orphan', ...container, family_id: ACCOUNT.family_id, user_id: ACCOUNT.user_id,
          provider: 'google', external_id: external, title: 'Stale partial write', deleted_at: null });
        await run(db);
        options.committedMappingFailure = false;
        expect((await run(db)).error).toBeUndefined();
        expect(rows[table]).toEqual([expect.objectContaining({ id: 'orphan', title: kind === 'event' ? event.summary : task.title, deleted_at: null })]);
        expect(rows.sync_external_mappings.filter(row => row.item_type === kind && row.external_id === external))
          .toEqual([expect.objectContaining({ account_id: ACCOUNT.id, local_id: 'orphan' })]);
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
