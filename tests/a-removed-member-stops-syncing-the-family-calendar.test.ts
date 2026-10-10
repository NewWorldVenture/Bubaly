import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { getMessages } from '@/lib/i18n/messages';

/**
 * A member removed from a family stops syncing their calendar with it.
 *
 * Connecting Google or Microsoft creates a `sync_accounts` row (default
 * direction `two_way`) owned by the member, in the family. Removing the member
 * sets `family_members.is_active = false` and nothing else, and nothing retires
 * the connection. The scheduled provider sync picks accounts by direction alone,
 * and `loadSyncExecutionPolicy` — the gate both engines pass before any token
 * read or provider call — checked the account's id, family, owner and provider,
 * never that the owner still belonged to the family.
 *
 * So every cron run went on PUSHING the family's events on that calendar into
 * the departed member's own Google/Outlook calendar and PULLING their personal
 * calendar into the family: an ex-partner taken out of the household kept
 * receiving the family's entries, and the family kept seeing theirs.
 */

const mocks = vi.hoisted(() => ({
  token: vi.fn(), legacyToken: vi.fn(),
  googleCalendars: vi.fn(), googlePull: vi.fn(), googleTasks: vi.fn(),
  googleInsertEvent: vi.fn(), googleInsertTask: vi.fn(),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages('en-US'), key) };
});
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: mocks.token }));
vi.mock('@/lib/services/onboarding-calendar', () => ({ refreshOnboardingCalendar: vi.fn() }));
vi.mock('@/lib/sync/accounts', async (original) => ({
  ...await original<typeof import('@/lib/sync/accounts')>(), getValidAccessToken: mocks.legacyToken,
}));
vi.mock('@/lib/sync/providers/google', async (original) => ({
  ...await original<typeof import('@/lib/sync/providers/google')>(),
  listCalendars: mocks.googleCalendars, pullEvents: mocks.googlePull, listTasks: mocks.googleTasks,
  insertEvent: mocks.googleInsertEvent, insertTask: mocks.googleInsertTask,
}));

const { loadSyncExecutionPolicy } = await import('@/lib/services/sync/policy');
const { runProviderSync } = await import('@/lib/sync/engine/generic');
const { runGoogleSync } = await import('@/lib/sync/engine/google');

const FAMILY = 'ours';
const OWNER = 'owner';
const ACCOUNT = { id: 'account', family_id: FAMILY, user_id: OWNER, external_id: 'owner@example.com' };
const OWNER_GONE = getMessages('en-US')['syncPolicy.ownerUnavailable'];

let db: ReturnType<typeof createInMemorySupabase>;
let adapter: SyncProviderAdapter;

function seed(opts: { ownerActive: boolean; provider?: 'microsoft' | 'google' }) {
  const provider = opts.provider ?? 'microsoft';
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'parent', role: 'parent', is_active: true },
    { id: 'member-owner', family_id: FAMILY, user_id: OWNER, role: 'adult', is_active: opts.ownerActive },
    // The same person can belong to another household; that is not this one.
    { id: 'member-elsewhere', family_id: 'theirs', user_id: OWNER, role: 'parent', is_active: true },
  ]);
  db.seed('sync_accounts', [{ ...ACCOUNT, provider, sync_direction: 'two_way', metadata: {} }]);
  db.seed('sync_connections', [{ id: 'connection', account_id: ACCOUNT.id }]);
  db.seed('sync_calendars', [{ id: 'calendar', account_id: ACCOUNT.id, family_id: FAMILY, provider, external_id: 'primary', sync_token: null }]);
  db.seed('sync_reminder_lists', [{ id: 'list', account_id: ACCOUNT.id, family_id: FAMILY, provider, external_id: provider === 'google' ? '@default' : 'default' }]);
  db.seed('sync_calendar_events', [{ id: 'family-event', family_id: FAMILY, calendar_id: 'calendar', provider: 'internal', title: 'Custody handover', starts_at: '2026-10-12T16:00:00Z', deleted_at: null }]);
  db.seed('sync_reminders', [{ id: 'family-task', family_id: FAMILY, list_id: 'list', provider: 'internal', title: 'School forms', is_completed: false, deleted_at: null }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ rpc: {
    ensure_sync_pull_container: (args, fixture) => {
      const table = args.p_kind === 'event' ? 'sync_calendars' : 'sync_reminder_lists';
      const row = fixture.table(table).find((r) => r.account_id === args.p_account && r.family_id === args.p_family
        && r.provider === args.p_provider && r.external_id === args.p_external);
      if (!row) throw new Error('Missing synthetic mirror');
      return { id: row.id, sync_token: row.sync_token ?? null };
    },
  } });
  mocks.token.mockResolvedValue('access');
  mocks.legacyToken.mockResolvedValue('access');
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

describe('the sync gate asks whether the owner still belongs to the family', () => {
  it('refuses a connection whose owner was removed', async () => {
    seed({ ownerActive: false });
    expect(await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft'))
      .toEqual({ ok: false, code: 'ownerUnavailable', error: OWNER_GONE });
  });

  it('does not count a membership in another household', async () => {
    seed({ ownerActive: false });
    db.replace('family_members', db.table('family_members').filter((r) => r.family_id !== FAMILY || r.user_id !== OWNER));
    expect(await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft'))
      .toMatchObject({ ok: false, code: 'ownerUnavailable' });
  });

  it('answers a failed membership read as a read failure, not as permission', async () => {
    seed({ ownerActive: true });
    const from = db.from.bind(db);
    // A refused read resolves with an error, the way PostgREST answers.
    const refused = { data: null, error: { code: '08006', message: 'offline', details: null, hint: null } };
    const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(refused).then(resolve) };
    vi.spyOn(db, 'from').mockImplementation(((table: string) => (table === 'family_members' ? chain : from(table))) as typeof db.from);
    expect(await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft'))
      .toMatchObject({ ok: false, code: 'readFailed', retryable: true });
  });

  it('lets a current member sync (control)', async () => {
    seed({ ownerActive: true });
    expect(await loadSyncExecutionPolicy(db as never, ACCOUNT, 'microsoft'))
      .toEqual({ ok: true, data: { mode: 'standard', pull: true, push: true } });
  });
});

describe('a scheduled sync for a removed member', () => {
  it('neither pushes the family\'s entries out nor pulls their calendar in (generic engine)', async () => {
    seed({ ownerActive: false });
    const result = await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result.error).toBe(OWNER_GONE);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(adapter.listCalendars).not.toHaveBeenCalled();
    expect(adapter.pullEvents).not.toHaveBeenCalled();
    expect(adapter.insertEvent).not.toHaveBeenCalled();
    expect(adapter.insertTask).not.toHaveBeenCalled();
    expect(db.table('sync_jobs')).toEqual([]);
  });

  it('neither pushes nor pulls in the Google engine either', async () => {
    seed({ ownerActive: false, provider: 'google' });
    const result = await runGoogleSync(db as never, ACCOUNT);
    expect(result.error).toBe(OWNER_GONE);
    expect(mocks.legacyToken).not.toHaveBeenCalled();
    expect(mocks.googleCalendars).not.toHaveBeenCalled();
    expect(mocks.googleInsertEvent).not.toHaveBeenCalled();
    expect(db.table('sync_jobs')).toEqual([]);
  });

  it('still syncs both ways for a current member (control)', async () => {
    seed({ ownerActive: true });
    const result = await runProviderSync(db as never, ACCOUNT, adapter);
    expect(result.error).toBeUndefined();
    expect(adapter.pullEvents).toHaveBeenCalledOnce();
    expect(adapter.insertEvent).toHaveBeenCalledOnce();
  });
});
