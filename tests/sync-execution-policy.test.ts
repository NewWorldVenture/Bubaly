import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { loadSyncExecutionPolicy, syncExecutionPolicy } from '@/lib/services/sync/policy';
import { getMessages } from '@/lib/i18n/messages';
import type { LocaleCode } from '@/lib/i18n/locales';

const mocks = vi.hoisted(() => ({
  token: vi.fn(), legacyToken: vi.fn(), onboarding: vi.fn(),
  googleCalendars: vi.fn(), googlePull: vi.fn(), googleTasks: vi.fn(),
  googleInsertEvent: vi.fn(), googlePatchEvent: vi.fn(), googleDeleteEvent: vi.fn(),
  googleInsertTask: vi.fn(), googlePatchTask: vi.fn(), googleDeleteTask: vi.fn(),
  locale: 'en-US' as LocaleCode,
}));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages(mocks.locale), key) };
});
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: mocks.token }));
vi.mock('@/lib/services/onboarding-calendar', () => ({ refreshOnboardingCalendar: mocks.onboarding }));
vi.mock('@/lib/sync/accounts', async (original) => ({ ...await original<typeof import('@/lib/sync/accounts')>(), getValidAccessToken: mocks.legacyToken }));
vi.mock('@/lib/sync/providers/google', async (original) => ({
  ...await original<typeof import('@/lib/sync/providers/google')>(),
  listCalendars: mocks.googleCalendars, pullEvents: mocks.googlePull, listTasks: mocks.googleTasks,
  insertEvent: mocks.googleInsertEvent, patchEvent: mocks.googlePatchEvent, deleteEvent: mocks.googleDeleteEvent,
  insertTask: mocks.googleInsertTask, patchTask: mocks.googlePatchTask, deleteTask: mocks.googleDeleteTask,
}));
const { runProviderSync } = await import('@/lib/sync/engine/generic');
const { runGoogleSync } = await import('@/lib/sync/engine/google');

const ACCOUNT = { id: 'account', family_id: 'ours', user_id: 'owner', external_id: 'owner@example.com' };
let db: ReturnType<typeof createInMemorySupabase>;
let adapter: SyncProviderAdapter;
const exports = () => [adapter.insertEvent, adapter.patchEvent, adapter.deleteEvent, adapter.insertTask, adapter.patchTask, adapter.deleteTask];
const googleExports = () => [mocks.googleInsertEvent, mocks.googlePatchEvent, mocks.googleDeleteEvent, mocks.googleInsertTask, mocks.googlePatchTask, mocks.googleDeleteTask];
function seed(direction: string, metadata: unknown = {}, provider = 'microsoft') {
  db.seed('sync_accounts', [{ ...ACCOUNT, provider, sync_direction: direction, metadata }]);
  db.seed('sync_connections', [{ id: 'connection', account_id: ACCOUNT.id }]);
  db.seed('sync_calendars', [{ id: 'calendar', family_id: 'ours', provider, external_id: 'primary', sync_token: null }]);
  db.seed('sync_reminder_lists', [{ id: 'list', family_id: 'ours', provider, external_id: provider === 'google' ? '@default' : 'default' }]);
  db.seed('sync_calendar_events', [{ id: 'local-event', calendar_id: 'calendar', provider: 'internal', title: 'Local event', starts_at: '2026-09-12T12:00:00Z', deleted_at: null }]);
  db.seed('sync_reminders', [{ id: 'local-task', list_id: 'list', provider: 'internal', title: 'Local task', is_completed: false, deleted_at: null }]);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.locale = 'en-US';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('families', [{ id: 'ours', timezone: 'UTC' }]);
  mocks.token.mockResolvedValue('access');
  mocks.legacyToken.mockResolvedValue('access');
  mocks.onboarding.mockResolvedValue({ ok: true, data: { imported: 1, exported: 0, skipped: 0, conflicts: 0 } });
  mocks.googleCalendars.mockResolvedValue([{ id: 'primary', summary: 'Calendar', primary: true }]);
  mocks.googlePull.mockResolvedValue({ events: [], gone: false, nextSyncToken: null });
  mocks.googleTasks.mockResolvedValue([]);
  mocks.googleInsertEvent.mockResolvedValue({ id: 'remote-event', etag: 'v1' });
  mocks.googleInsertTask.mockResolvedValue({ id: 'remote-task' });
  adapter = {
    provider: 'microsoft', label: 'Microsoft', isConfigured: () => true,
    listCalendars: vi.fn().mockResolvedValue([{ externalId: 'primary', name: 'Calendar', primary: true }]),
    pullEvents: vi.fn().mockResolvedValue({ events: [], expired: false, nextCursor: null }),
    defaultTaskListId: vi.fn().mockResolvedValue('default'), listTasks: vi.fn().mockResolvedValue([]),
    insertEvent: vi.fn().mockResolvedValue({ id: 'remote-event', etag: 'v1' }), patchEvent: vi.fn(), deleteEvent: vi.fn(),
    insertTask: vi.fn().mockResolvedValue({ id: 'remote-task' }), patchTask: vi.fn(), deleteTask: vi.fn(),
    eventContentHash: () => 'event-hash', reminderContentHash: () => 'task-hash',
    rowToEventBody: (row: Parameters<SyncProviderAdapter['rowToEventBody']>[0]) => ({ ...row }),
    rowToTaskBody: (row: Parameters<SyncProviderAdapter['rowToTaskBody']>[0]) => ({ ...row }),
  } as unknown as SyncProviderAdapter;
});
afterEach(() => vi.restoreAllMocks());

describe('persisted direction and onboarding policy', () => {
  it('keeps policy decisions as typed codes until the request loader translates them', () => {
    expect(syncExecutionPolicy({ sync_direction: 'manual', metadata: {} })).toEqual({ ok: false, code: 'notEnabled', retryable: false });
    expect(syncExecutionPolicy({ sync_direction: 'unknown', metadata: {} })).toEqual({ ok: false, code: 'directionUnavailable', retryable: true });
  });
  it.each(['manual', 'disabled', 'missing'])('keeps %s inactive', (direction) => {
    expect(syncExecutionPolicy({ sync_direction: direction, metadata: {} }).ok).toBe(false);
  });
  it.each([null, {}, { version: 2, state: 'import', calendarExternalId: 'primary' }, { version: 1, state: 'preview' }, { version: 1, state: 'import' }])('refuses malformed or pending onboarding metadata %j', (marker) => {
    expect(syncExecutionPolicy({ sync_direction: 'import', metadata: { onboardingCalendar: marker } }).ok).toBe(false);
  });
  it('does not enable a pending onboarding account by changing its direction', () => {
    expect(syncExecutionPolicy({ sync_direction: 'two_way', metadata: { onboardingCalendar: { version: 1, state: 'preview' } } }).ok).toBe(false);
    expect(syncExecutionPolicy({ sync_direction: 'two_way', metadata: { onboardingCalendar: { version: 1, state: 'import', calendarExternalId: 'primary' } } }).ok).toBe(false);
  });
});

describe('localized policy failures', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('uses the %s catalog in real policy reads', async (locale) => {
    mocks.locale = locale;
    seed('manual');
    const result = await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft');
    expect(result).toEqual({ ok: false, code: 'notEnabled', retryable: false, error: getMessages(locale)['syncPolicy.notEnabled'] });
    for (const key of ['notEnabled', 'directionUnavailable', 'settingsUnavailable', 'finishImport', 'ownerUnavailable', 'readFailed']) {
      const message = getMessages(locale)[`syncPolicy.${key}`];
      expect(message).toBeTruthy();
      if (locale !== 'en-US') expect(message).not.toBe(getMessages('en-US')[`syncPolicy.${key}`]);
    }
  });

  it('localizes owner and read failures without exposing transport details', async () => {
    mocks.locale = 'de-DE';
    const owner = await loadSyncExecutionPolicy(db as never, { ...ACCOUNT, user_id: null }, 'microsoft');
    expect(owner).toEqual({ ok: false, code: 'ownerUnavailable', error: getMessages('de-DE')['syncPolicy.ownerUnavailable'] });
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('private connection details'); });
    const failed = await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft');
    expect(failed).toEqual({ ok: false, code: 'readFailed', retryable: true, error: getMessages('de-DE')['syncPolicy.readFailed'] });
  });
});

describe('real engine entrypoints respect persisted direction', () => {
  it.each(['manual', 'disabled'])('generic %s account makes no provider, token, or job calls', async (direction) => {
    seed(direction, { onboardingCalendar: { version: 1, state: 'preview' } });
    const result = await runProviderSync(db as never, { ...ACCOUNT, sync_direction: 'two_way' } as typeof ACCOUNT, adapter);
    expect(result.error).toBeTruthy();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.onboarding).not.toHaveBeenCalled();
    expect(adapter.listCalendars).not.toHaveBeenCalled();
    expect(db.table('sync_jobs')).toEqual([]);
    for (const action of exports()) expect(action).not.toHaveBeenCalled();
  });
  it('legacy Google also leaves a pending account completely inactive', async () => {
    seed('manual', { onboardingCalendar: { version: 1, state: 'preview' } }, 'google');
    expect((await runGoogleSync(db as never, ACCOUNT)).error).toBeTruthy();
    expect(mocks.legacyToken).not.toHaveBeenCalled();
    expect(mocks.googleCalendars).not.toHaveBeenCalled();
    expect(db.table('sync_jobs')).toEqual([]);
  });
  it('generic import never calls outgoing calendar or task APIs despite pending local work', async () => {
    seed('import');
    const result = await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result.error).toBeUndefined();
    expect(adapter.pullEvents).toHaveBeenCalledOnce();
    expect(adapter.listTasks).toHaveBeenCalledOnce();
    for (const action of exports()) expect(action).not.toHaveBeenCalled();
    expect(result.exported).toBe(0);
  });
  it('legacy Google import never calls outgoing calendar or task APIs', async () => {
    seed('import', {}, 'google');
    const result = await runGoogleSync(db as never, ACCOUNT);
    expect(result.error).toBeUndefined();
    expect(mocks.googlePull).toHaveBeenCalledOnce();
    expect(mocks.googleTasks).toHaveBeenCalledOnce();
    for (const action of googleExports()) expect(action).not.toHaveBeenCalled();
  });
  it('export runs keep outgoing work but do not import remote event/task bodies', async () => {
    seed('export');
    const result = await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result.error).toBeUndefined();
    expect(adapter.pullEvents).not.toHaveBeenCalled();
    expect(adapter.listTasks).not.toHaveBeenCalled();
    expect(adapter.insertEvent).toHaveBeenCalledOnce();
    expect(adapter.insertTask).toHaveBeenCalledOnce();
    expect(result.exported).toBe(2);
  });
  it('retains ordinary two-way imports and exports', async () => {
    seed('two_way');
    const result = await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result.error).toBeUndefined();
    expect(adapter.pullEvents).toHaveBeenCalledOnce();
    expect(adapter.listTasks).toHaveBeenCalledOnce();
    expect(adapter.insertEvent).toHaveBeenCalledOnce();
    expect(adapter.insertTask).toHaveBeenCalledOnce();
  });
  it('legacy Google export sends local work without pulling remote event or task bodies', async () => {
    seed('export', {}, 'google');
    const result = await runGoogleSync(db as never, ACCOUNT);
    expect(result.error).toBeUndefined();
    expect(mocks.googlePull).not.toHaveBeenCalled();
    expect(mocks.googleTasks).not.toHaveBeenCalled();
    expect(mocks.googleInsertEvent).toHaveBeenCalledOnce();
    expect(mocks.googleInsertTask).toHaveBeenCalledOnce();
    expect(result.exported).toBe(2);
  });
  it.each(['generic', 'google'])('routes finished onboarding imports through canonical calendar service in %s engine', async (engine) => {
    seed('import', { onboardingCalendar: { version: 1, state: 'import', calendarExternalId: 'primary' } }, engine === 'google' ? 'google' : 'microsoft');
    const result = engine === 'google' ? await runGoogleSync(db as never, ACCOUNT) : await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result).toEqual({ imported: 1, exported: 0, skipped: 0, conflicts: 0 });
    expect(mocks.onboarding).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', familyId: 'ours', actorKind: 'system' }), 'account', expect.any(Object));
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.legacyToken).not.toHaveBeenCalled();
    expect(adapter.defaultTaskListId).not.toHaveBeenCalled();
    expect(mocks.googleTasks).not.toHaveBeenCalled();
    for (const action of [...exports(), ...googleExports()]) expect(action).not.toHaveBeenCalled();
    expect(db.table('sync_calendar_events')).toHaveLength(1);
  });
  it('refuses mismatched household identity before provider work', async () => {
    seed('two_way');
    expect((await runProviderSync(db as never, { ...ACCOUNT, family_id: 'theirs' }, adapter)).error).toBeTruthy();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(db.table('sync_jobs')).toEqual([]);
  });
  it('returns an honest policy read failure before token access', async () => {
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    expect((await runProviderSync(db as never, ACCOUNT, adapter)).error).toContain('Could not read');
    expect(mocks.token).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
