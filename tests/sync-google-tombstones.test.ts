import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { syncSdkFixture as fixture, ACCOUNT, NEXT, STALE, CANCELLED_INSTANCE } from './helpers/sync-sdk-fixture';

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

    it.each(['family', 'calendar', 'missing'] as const)('refuses a LIVE mapping target in another %s', async scope => {
      const { db, rows } = fixture([{ id: 'deleted', summary: 'Synthetic live overwrite',
        start: { dateTime: '2026-06-21T09:00:00Z' } }]);
      rows.sync_external_mappings[0].local_id = scope === 'missing' ? 'missing-local' : 'foreign-local';
      Object.assign(rows.sync_calendar_events[1], {
        calendar_id: scope === 'calendar' ? 'another-calendar' : 'calendar',
        family_id: scope === 'family' ? 'another-family' : ACCOUNT.family_id,
        title: 'Synthetic foreign original', content_hash: null,
      });
      expect((await run(db)).error).toContain('Sync local event lookup failed');
      expect(rows.sync_calendar_events[1].title).toBe('Synthetic foreign original');
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_job_runs[0].status).toBe('failed');
    });

    it.each(['zeroLiveWrite', 'moveBeforeLiveWrite'] as const)('retains cursor on %s after its scoped live read', async condition => {
      const { db, rows } = fixture([{ id: 'deleted', summary: 'Synthetic live overwrite',
        start: { dateTime: '2026-06-21T09:00:00Z' } }], { [condition]: true });
      expect((await run(db)).error).toContain('event update');
      expect(rows.sync_calendar_events[0].title).toBeUndefined();
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
    });

    it('rejects a mapping with an inconsistent family stamp before reading its payload', async () => {
      const { db, rows, calls } = fixture([{ id: 'deleted', summary: 'Synthetic live overwrite',
        start: { dateTime: '2026-06-21T09:00:00Z' } }]);
      rows.sync_external_mappings[0].family_id = 'another-family';
      expect((await run(db)).error).toContain('event mapping scope');
      expect(calls.filter(call => call.url.pathname === '/rest/v1/sync_calendar_events')).toEqual([]);
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
    });

    it('still updates an actual live row in the resolved account calendar', async () => {
      const { db, rows } = fixture([{ id: 'deleted', summary: 'Synthetic live update',
        start: { dateTime: '2026-06-21T09:00:00Z' } }]);
      expect((await run(db)).error).toBeUndefined();
      expect(rows.sync_calendar_events[0].title).toBe('Synthetic live update');
      expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
    });

    it('rejects a mapping identity changed after the live update instead of advancing its cursor', async () => {
      const { db, rows } = fixture([{ id: 'deleted', summary: 'Synthetic live update',
        start: { dateTime: '2026-06-21T09:00:00Z' } }], { moveMappingBeforeWrite: true });
      expect((await run(db)).error).toContain('event mapping update');
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_job_runs[0].status).toBe('failed');
    });

    it('keeps another account mirror separate even when its external calendar ID matches', async () => {
      const { db, rows } = fixture([]);
      rows.sync_calendars.unshift({ id: 'other-calendar', account_id: 'another-account', family_id: ACCOUNT.family_id,
        provider: 'google', external_id: 'primary', sync_token: 'other-account-cursor' });
      expect((await run(db)).error).toBeUndefined();
      expect(rows.sync_calendars[0].sync_token).toBe('other-account-cursor');
      expect(rows.sync_calendars[1].sync_token).toBe(NEXT);
    });

    it('keeps another account task list separate even when its external ID matches', async () => {
      const { db, rows } = fixture([], { tasks: [{ id: 'remote-task', title: 'Synthetic own task update' }] });
      rows.sync_reminder_lists.unshift({ id: 'other-list', account_id: 'another-account', family_id: ACCOUNT.family_id,
        provider: 'google', external_id: '@default' });
      expect((await run(db)).error).toBeUndefined();
      expect(rows.sync_reminders[0].title).toBe('Synthetic own task update');
      expect(rows.sync_reminders[0].list_id).toBe('list');
      expect(rows.sync_calendars[0].sync_token).toBe(NEXT);
    });

    it('exports only same-family local events even behind a mismatched calendar stamp', async () => {
      const { db, rows, calls } = fixture([], { direction: 'two_way' });
      rows.sync_external_mappings.length = 0;
      Object.assign(rows.sync_calendar_events[0], { provider: 'internal', title: 'Synthetic own export',
        starts_at: '2026-06-21T09:00:00Z', timezone: 'UTC' });
      Object.assign(rows.sync_calendar_events[1], { calendar_id: 'calendar', provider: 'internal',
        title: 'Synthetic foreign private export', starts_at: '2026-06-21T09:00:00Z', timezone: 'UTC' });
      expect((await run(db)).error).toBeUndefined();
      const outgoing = calls.filter(call => call.url.origin === 'https://www.googleapis.com' && call.method === 'POST');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].body?.summary).toBe('Synthetic own export');
      expect(rows.sync_external_mappings).toHaveLength(1);
      expect(rows.sync_external_mappings[0].local_id).toBe('local');
    });

    it('exports only same-family local reminders behind the resolved list', async () => {
      const { db, rows, calls } = fixture([], { direction: 'two_way' });
      rows.sync_external_mappings.length = 0;
      rows.sync_reminders.push({ id: 'own-task', family_id: ACCOUNT.family_id, list_id: 'list',
        provider: 'internal', title: 'Synthetic own task', is_completed: false },
      { id: 'foreign-task', family_id: 'another-family', list_id: 'list',
        provider: 'internal', title: 'Synthetic foreign private task', is_completed: false });
      expect((await run(db)).error).toBeUndefined();
      const outgoing = calls.filter(call => call.url.origin === 'https://tasks.googleapis.com' && call.method === 'POST');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].body?.title).toBe('Synthetic own task');
      expect(rows.sync_external_mappings).toHaveLength(1);
      expect(rows.sync_external_mappings[0].local_id).toBe('own-task');
    });

    it('refuses an inconsistent push mapping before any outgoing provider write', async () => {
      const { db, rows, calls } = fixture([], { direction: 'two_way' });
      rows.sync_external_mappings[0].family_id = 'another-family';
      Object.assign(rows.sync_calendar_events[0], { provider: 'internal', title: 'Synthetic own export',
        starts_at: '2026-06-21T09:00:00Z', timezone: 'UTC' });
      expect((await run(db)).error).toContain('event mapping scope');
      expect(calls.filter(call => call.url.origin === 'https://www.googleapis.com' && call.method !== 'GET')).toEqual([]);
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
    });

    it('fails an unconfirmed push write and retains its cursor after the provider receipt', async () => {
      const { db, rows } = fixture([], { direction: 'two_way', zeroPushWrite: true });
      rows.sync_external_mappings.length = 0;
      Object.assign(rows.sync_calendar_events[0], { provider: 'internal', title: 'Synthetic own export',
        starts_at: '2026-06-21T09:00:00Z', timezone: 'UTC' });
      expect((await run(db)).error).toContain('exported event update');
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_job_runs[0].status).toBe('failed');
      // Provider and prior DB writes are not one transaction; the confirmed
      // mapping remains for an idempotent replay, rather than claiming rollback.
      expect(rows.sync_external_mappings).toHaveLength(1);
    });

    it.each(['family', 'list', 'missing'] as const)('refuses a LIVE reminder mapped into another %s and retains the calendar cursor', async scope => {
      const { db, rows } = fixture([], { tasks: [{ id: 'remote-task', title: 'Synthetic task overwrite' }] });
      Object.assign(rows.sync_reminders[0], {
        family_id: scope === 'family' ? 'another-family' : ACCOUNT.family_id,
        list_id: scope === 'list' ? 'another-list' : 'list',
      });
      if (scope === 'missing') rows.sync_reminders.length = 0;
      expect((await run(db)).error).toContain('Sync local reminder lookup failed');
      expect(rows.sync_reminders.every(row => row.title === 'Synthetic task original')).toBe(true);
      expect(rows.sync_calendars[0].sync_token).toBe(STALE);
      expect(rows.sync_job_runs[0].status).toBe('failed');
    });

    it.each(['family', 'list'] as const)('refuses a reminder tombstone mapped into another %s', async scope => {
      const { db, rows } = fixture([], { tasks: [{ id: 'remote-task', deleted: true }] });
      Object.assign(rows.sync_reminders[0], {
        family_id: scope === 'family' ? 'another-family' : ACCOUNT.family_id,
        list_id: scope === 'list' ? 'another-list' : 'list',
      });
      expect((await run(db)).error).toContain('deleted reminder update');
      expect(rows.sync_reminders[0].deleted_at).toBeNull();
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
