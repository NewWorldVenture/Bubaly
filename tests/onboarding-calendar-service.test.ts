import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncProviderAdapter, NormalizedEvent } from '@/lib/sync/adapter';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { previewConnectedCalendar, finishConnectedCalendar, enableConnectedCalendar, refreshOnboardingCalendar, validateConnectedCalendarReceipt } from '@/lib/services/onboarding-calendar';
import { readCalendarPreview, readCalendarContinuation, sealCalendarContinuation } from '@/lib/onboarding/calendar-state';
import { connectAccount } from '@/lib/sync/accounts';
import { getProviderAccessToken } from '@/lib/sync/access-token';

vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: vi.fn(async () => 'server-token') }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});
const userId = '10000000-0000-4000-8000-000000000001';
const familyId = '20000000-0000-4000-8000-000000000001';
const accountId = '30000000-0000-4000-8000-000000000001';
const otherUser = '10000000-0000-4000-8000-000000000002';
let db: InMemorySupabase;
let scope: ServiceScope;
let adapter: SyncProviderAdapter;
let events: NormalizedEvent[];
beforeEach(() => {
  vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { calendar_events: [['family_id', 'onboarding_key']],
    sync_accounts: [['user_id', 'provider', 'external_id']], sync_external_mappings: [['provider', 'item_type', 'external_id', 'account_id']] },
  defaults: { calendar_events: { updated_at: '2026-09-09T00:00:00Z' }, sync_accounts: { updated_at: '2026-09-09T00:00:00Z' } } });
  db.seed('sync_accounts', [{ id: accountId, user_id: userId, family_id: familyId, provider: 'google', external_id: 'calendar@example.test',
    updated_at: '2026-09-09T00:00:00Z', sync_direction: 'manual', metadata: { unrelated: true, onboardingCalendar: { version: 1, state: 'preview' } } }]);
  db.seed('family_members', [{ id: 'member', user_id: userId, family_id: familyId, role: 'parent', is_active: true }]);
  db.seed('families', [{ id: familyId, trial_ends_at: null, closed_at: null }]);
  db.seed('user_preferences', [{ user_id: userId, active_family_id: familyId }]);
  db.seed('onboarding_progress', [{ user_id: userId, family_id: familyId, source: 'wizard', status: 'in_progress' }]);
  scope = { db: db as never, userId, familyId, memberId: 'member', actorKind: 'member', role: 'parent', tz: 'UTC' };
  events = [{ external_id: 'event-1', uid: 'uid-1', title: 'School visit', description: null, location: 'School', starts_at: '2026-09-10T10:00:00Z',
    ends_at: '2026-09-10T11:00:00Z', all_day: false, recurrence_rule: null, status: 'confirmed', etag: null, cancelled: false }];
  adapter = { provider: 'google', listCalendars: vi.fn(async () => [{ externalId: 'primary', primary: true, name: 'My calendar', timezone: 'UTC', color: null }]),
    pullEvents: vi.fn(), pullCalendarWindow: vi.fn(async () => events) } as unknown as SyncProviderAdapter;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function preview() {
  const result = await previewConnectedCalendar(scope, accountId, adapter);
  if (!result.ok) throw new Error(result.error);
  const receipt = readCalendarPreview(result.data.receipt, userId, result.data.events);
  if (!receipt) throw new Error('Preview proof missing');
  return { ...result.data, proof: receipt };
}
async function imported() {
  const result = await preview();
  expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: true, data: { imported: 1 } });
  db.table('onboarding_progress')[0].status = 'completed';
  expect(await enableConnectedCalendar(scope, result.proof)).toMatchObject({ ok: true });
  return result;
}

describe('current Calendar Sync permission at import boundaries', () => {
  it('blocks disabled preview before token access and provider reads', async () => {
    vi.mocked(getProviderAccessToken).mockClear();
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    expect(getProviderAccessToken).not.toHaveBeenCalled(); expect(adapter.listCalendars).not.toHaveBeenCalled();
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it('does not refresh an active import once its trial expires', async () => {
    await imported(); vi.mocked(getProviderAccessToken).mockClear(); vi.mocked(adapter.listCalendars).mockClear();
    db.table('families')[0].trial_ends_at = '2020-01-01T00:00:00Z';
    expect(await refreshOnboardingCalendar({ ...scope, actorKind: 'system', role: 'system' }, accountId, adapter)).toMatchObject({ ok: false });
    expect(getProviderAccessToken).not.toHaveBeenCalled(); expect(adapter.listCalendars).not.toHaveBeenCalled();
    expect(db.table('calendar_events')).toHaveLength(1);
  });

  it('rechecks permission after provider work before changing canonical events', async () => {
    await imported();
    vi.mocked(adapter.pullCalendarWindow!).mockImplementationOnce(async () => {
      db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
      return [{ ...events[0], title: 'Remote change' }];
    });
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('calendar_events')[0].title).toBe('School visit');
    expect(db.table('sync_external_mappings')).toHaveLength(1);
  });

  it('rechecks current entitlement after reading completion and before activating imports', async () => {
    const receipt = await preview();
    db.table('onboarding_progress')[0].status = 'completed';
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      if (table === 'onboarding_progress') {
        const read = query.maybeSingle.bind(query);
        vi.spyOn(query, 'maybeSingle').mockImplementation(async () => {
          const result = await read(); db.table('families')[0].closed_at = new Date().toISOString(); return result;
        });
      }
      return query;
    });
    expect(await enableConnectedCalendar(scope, receipt.proof)).toMatchObject({ ok: false });
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
  });
});

describe('connected calendar preview and canonical import', () => {
  it('previews privately, verifies the receipt and imports exactly one canonical copy across Finish and background retries', async () => {
    const result = await preview();
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('sync_external_mappings')).toHaveLength(0);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
    expect(readCalendarPreview(result.receipt, otherUser, result.events)).toBeNull();
    expect(readCalendarPreview(result.receipt, userId, [{ ...result.events[0], title: 'Tampered' }])).toBeNull();
    expect(await validateConnectedCalendarReceipt(scope, result.proof)).toMatchObject({ ok: true });
    expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: true, data: { imported: 1 } });
    expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: true, data: { skipped: 1 } });
    expect(await enableConnectedCalendar(scope, result.proof)).toMatchObject({ ok: false });
    db.table('onboarding_progress')[0].status = 'completed';
    expect(await enableConnectedCalendar(scope, result.proof)).toMatchObject({ ok: true });
    expect(await refreshOnboardingCalendar({ ...scope, actorKind: 'system', role: 'system' }, accountId, adapter)).toMatchObject({ ok: true, data: { skipped: 1, exported: 0 } });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('sync_external_mappings')).toHaveLength(1);
    expect(db.table('sync_calendar_events')).toHaveLength(0);
    expect(db.table('sync_accounts')[0].metadata).toMatchObject({ unrelated: true, onboardingCalendar: { state: 'import', calendarExternalId: 'primary' } });
  });

  it.each([{ userId: otherUser }, { familyId: 'other-family' }, { actorKind: 'ai' as const }])('refuses unowned or automated previews before provider calls: %j', async (patch) => {
    expect(await previewConnectedCalendar({ ...scope, ...patch }, accountId, adapter)).toMatchObject({ ok: false });
    expect(adapter.listCalendars).not.toHaveBeenCalled();
  });

  it('rechecks role removal and active-family changes on Finish', async () => {
    const result = await preview();
    db.table('family_members')[0].role = 'teen';
    expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: false });
    db.table('family_members')[0].role = 'parent';
    db.table('user_preferences')[0].active_family_id = 'another-family';
    expect(await validateConnectedCalendarReceipt(scope, result.proof)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it('does not replace the primary calendar with another one or turn failed/invalid reads into empty success', async () => {
    vi.mocked(adapter.listCalendars).mockResolvedValueOnce([{ externalId: 'secondary', primary: false, name: 'Shared', timezone: null, color: null }]);
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    vi.mocked(adapter.pullCalendarWindow!).mockRejectedValueOnce(new Error('offline'));
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    events = [{ ...events[0], cancelled: true, external_id: '' }];
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it('reads a complete 30-day local-calendar window across daylight saving without the recurrence-master API', async () => {
    scope.tz = 'America/New_York'; scope.now = new Date('2026-03-08T06:00:00Z');
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: true });
    expect(adapter.pullCalendarWindow).toHaveBeenCalledWith('server-token', 'primary', '2026-03-08T05:00:00.000Z', '2026-04-07T04:00:00.000Z');
    expect(adapter.pullEvents).not.toHaveBeenCalled();
    scope.tz = 'Invalid/Zone';
    expect(await previewConnectedCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
  });

  it('updates imported provider changes while preserving different local edits and local deletions', async () => {
    await imported();
    events[0].title = 'Updated school visit';
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { imported: 1 } });
    expect(db.table('calendar_events')[0].title).toBe('Updated school visit');
    db.table('calendar_events')[0].title = 'My changed title';
    events[0].title = 'Another remote title';
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { conflicts: 1 } });
    expect(db.table('calendar_events')[0].title).toBe('My changed title');
    db.replace('calendar_events', []);
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { conflicts: 1 } });
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it('repairs a mapping failure after an event update on retry without treating its own write as a local edit', async () => {
    await imported();
    events[0].title = 'Updated school visit';
    const from = db.from.bind(db);
    let failMapping = true;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      if (table === 'sync_external_mappings' && failMapping) vi.spyOn(query, 'upsert').mockImplementation(() => { failMapping = false; throw new Error('mapping offline'); });
      return query;
    });
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')[0].title).toBe('Updated school visit');
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { skipped: 1, conflicts: 0 } });
  });

  it('handles remote cancellation once and keeps later tombstones from recreating records', async () => {
    await imported(); events[0].cancelled = true;
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { imported: 1 } });
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { skipped: 1, conflicts: 0 } });
    expect(db.table('calendar_events')).toHaveLength(0);
  });

  it.each([{ category: 'school' }, { description: 'Bring a signed form' }, { member_id: 'child-member' }])('preserves other local event fields across refresh and a later cancellation: %j', async (patch) => {
    await imported();
    Object.assign(db.table('calendar_events')[0], patch);
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { skipped: 1 } });
    events[0].cancelled = true;
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { conflicts: 1 } });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('calendar_events')[0]).toMatchObject(patch);
  });

  it('does not bless local edits as a cancellation baseline while repairing a first-insert mapping failure', async () => {
    const result = await preview(); const original = db.from.bind(db); let failed = false;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = original(table);
      if (table === 'sync_external_mappings' && !failed) vi.spyOn(query, 'upsert').mockImplementation(() => { failed = true; throw new Error('mapping unavailable'); });
      return query;
    });
    expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toHaveLength(1);
    db.table('calendar_events')[0].category = 'school';
    expect(await finishConnectedCalendar(scope, result.proof, result.events)).toMatchObject({ ok: true });
    db.table('onboarding_progress')[0].status = 'completed';
    expect(await enableConnectedCalendar(scope, result.proof)).toMatchObject({ ok: true });
    events[0].cancelled = true;
    expect(await refreshOnboardingCalendar(scope, accountId, adapter)).toMatchObject({ ok: true, data: { conflicts: 1 } });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('calendar_events')[0].category).toBe('school');
  });

  it('cannot reenable a connection changed on another device between the read and write', async () => {
    const result = await preview();
    db.table('onboarding_progress')[0].status = 'completed';
    const from = db.from.bind(db);
    let accountReads = 0;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'sync_accounts' && ++accountReads === 2) { db.table(table)[0].sync_direction = 'disabled'; db.table(table)[0].updated_at = '2026-09-09T00:00:01Z'; }
      return from(table);
    });
    expect(await enableConnectedCalendar(scope, result.proof)).toMatchObject({ ok: false });
    expect(db.table('sync_accounts')[0].sync_direction).toBe('disabled');
  });
});

describe('dormant connection creation and protected continuation', () => {
  const input = { userId, familyId, provider: 'google' as const, externalId: 'new@example.test', onboardingCalendar: true,
    tokens: { accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600_000 } };
  it('persists the manual marker in the first account write before any token/connection write', async () => {
    const id = await connectAccount(db as never, input);
    const account = db.table('sync_accounts').find((row) => row.id === id)!;
    expect(account).toMatchObject({ sync_direction: 'manual', metadata: { onboardingCalendar: { version: 1, state: 'preview' } } });
    expect(db.table('sync_connections')[0]).toMatchObject({ account_id: id, sync_direction: 'manual', item_types: ['calendar'] });
    expect(JSON.stringify(db.table('sync_tokens'))).not.toContain('private-access');
    expect(JSON.stringify(db.table('sync_tokens'))).not.toContain('private-refresh');
  });
  it('never overwrites a normal connection that wins a concurrent insert', async () => {
    const from = db.from.bind(db);
    let calls = 0;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'sync_accounts' && ++calls === 2) db.replace('sync_accounts', [{ user_id: userId, family_id: familyId, provider: input.provider,
        external_id: input.externalId, id: accountId, sync_direction: 'two_way', metadata: { normal: true } }]);
      return from(table);
    });
    await expect(connectAccount(db as never, input)).rejects.toThrow();
    expect(db.table('sync_accounts')[0]).toMatchObject({ sync_direction: 'two_way', metadata: { normal: true } });
    expect(db.table('sync_tokens')).toHaveLength(0);
  });
  it('binds continuation to an authenticated envelope and expires it', () => {
    const now = Date.now();
    const sealed = sealCalendarContinuation({ userId, familyId, provider: 'google', state: 'opaque-state-long-enough' }, now);
    expect(readCalendarContinuation(sealed, now)).toMatchObject({ userId, familyId, provider: 'google' });
    expect(readCalendarContinuation(`${sealed}tampered`, now)).toBeNull();
    expect(readCalendarContinuation(sealed, now + 600_000)).toBeNull();
  });
});
