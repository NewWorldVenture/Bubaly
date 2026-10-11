// SRV-001 l0 — a campaign read that FAILED is not a campaign that is gone.
//
// Pause/Resume and "Post now" on /admin/marketing/social/recurring each read
// the one campaign first, and both answered `readError || !row` with "That
// campaign could not be found." — with nothing logged. So during a database
// blip an operator pressing Pause on a card that plainly says Active was told
// it had been removed, walked away, and the cron posted it on schedule; and
// afterwards nobody could tell an outage from a deletion, because nothing
// reached the logs. The page's own read and the cron's read of the same table
// already logged theirs; these two did not.
//
// Now a failed read is logged with the campaign id and answered as a failed
// read (an existing catalogue sentence: "Could not load this marketing
// campaign … Refresh and try again."), and only a campaign that is really not
// there is "could not be found". Nothing is written on either path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type Row = Record<string, unknown>;
const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

const state = vi.hoisted(() => ({
  read: { data: null as unknown, error: null as unknown },
  writes: [] as Row[],
}));

function chain(result: () => Promise<{ data: unknown; error: unknown }>) {
  const node = {
    select: () => chain(result),
    eq: () => chain(result),
    is: () => chain(result),
    maybeSingle: () => result(),
    then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => result().then(onOk, onErr),
  };
  return node as unknown as never;
}

// The admin gates also ask lib/auth/super-admin-assurance whether the session
// proved its authenticator; this file is not about step-up, so it says yes.
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => chain(async () => state.read),
      update: (patch: Row) => { state.writes.push(patch); return chain(async () => ({ data: [{ id: 'ad-1' }], error: null })); },
      insert: (row: Row) => { state.writes.push(row); return chain(async () => ({ data: { id: 'x' }, error: null })); },
    }),
  }),
}));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => true, getUser: async () => ({ id: 'admin-1' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('@/lib/social/connectors', () => ({ getConnector: () => ({ publish: vi.fn() }) }));

const { setRecurringAdStatusAction, runRecurringAdNowAction } = await import('@/app/(app)/admin/marketing/social/recurring/actions');

const FAILED = { message: 'fetch failed', code: '' };
const actions = [
  ['Pause', () => setRecurringAdStatusAction('ad-1', 'paused'), 'status change'],
  ['Resume', () => setRecurringAdStatusAction('ad-1', 'active'), 'status change'],
  ['Post now', () => runRecurringAdNowAction('ad-1'), 'run now'],
] as const;

beforeEach(() => {
  state.read = { data: null, error: null };
  state.writes = [];
  vi.restoreAllMocks();
});

describe('a campaign read that failed', () => {
  it.each(actions)('%s answers a failed read as a failed read, logs it, and writes nothing', async (_label, run, tag) => {
    state.read = { data: null, error: FAILED };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run();
    expect(EN_US['campaigns.couldNotLoadThisMarketing']).toEqual(expect.any(String));
    expect(res).toEqual({ ok: false, error: EN_US['campaigns.couldNotLoadThisMarketing'] });
    expect(errorSpy).toHaveBeenCalledWith(`[recurring-ads] ${tag} read failed`, 'ad-1', FAILED);
    expect(state.writes).toEqual([]);
  });
});

describe('a campaign that is really not there', () => {
  it.each(actions)('%s still says it could not be found, and writes nothing', async (_label, run) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run()).toEqual({ ok: false, error: 'That campaign could not be found.' });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
});
