// setMomentPrepDoneAction does a read-merge-write into the shared
// user_preferences.notification_prefs jsonb, and the upsert replaces that WHOLE
// column (supabase/migrations/0002_tables.sql:496 — a plain jsonb column, no
// merge trigger). PostgREST RESOLVES with { data: null, error }, so a read whose
// error is dropped is indistinguishable from "this member has no prefs yet" and
// collapses to `{}`. One tick of "Leave by 14:25" on /dashboard/moments during a
// statement timeout — or the toggle that "Add to list" fires for the member —
// would then write `{ momentPrep: { ... } }` over their App Lock config, their
// Google Calendar refresh token and every other key in the blob, and report ok.
//
// The guard is the one the siblings already have: the identical read-merge-write
// in app/(app)/capture/shortcuts-actions.ts (`if (readError) return { ok: false,
// ... }`), app/(app)/settings/app-lock-actions.ts and
// app/api/google/calendar/callback/route.ts. Read the error, FAIL CLOSED, write
// nothing. The caller already surfaces a failed toggle
// (components/moments/moments-view.tsx), so the failure is visible and the
// member's settings survive it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { setMomentPrepDoneAction } = await import('@/app/(app)/dashboard/moment-actions');

// What the member already has in the shared blob. None of it belongs to moments.
const OTHER_PREFS = {
  appLock: { enabled: true, salt: 'salt-a', hash: 'hash-a' },
  googleCalendar: { refresh_token: 'token-a' },
  sidebarNav: ['home', 'calendar'],
  captureShortcuts: ['tasks'],
};

type Read = { data: unknown; error: unknown };
let read: Read;
let upserts: { row: Record<string, unknown>; options: unknown }[];

// Chainable PostgREST stub: select().eq().maybeSingle() resolves the configured
// read; upsert() records the row it would have written.
function from(_table: string) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => read,
    upsert: async (row: Record<string, unknown>, options: unknown) => {
      upserts.push({ row, options });
      return { data: null, error: null };
    },
  });
  return query;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  read = { data: { notification_prefs: { ...OTHER_PREFS } }, error: null };
  upserts = [];
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1', email: 'parent@example.com' } });
  mocks.createServer.mockResolvedValue({ from });
});

describe('saving a moment step onto a preferences read that failed', () => {
  it('writes NOTHING when the preferences read is refused', async () => {
    read = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const result = await setMomentPrepDoneAction({ eventId: 'evt-1', doneIds: ['leave-by'] });

    // The whole point: no upsert at all. An upsert built on a read that did not
    // happen replaces the column with just the moment key.
    expect(upserts, 'a refused read must not be followed by a write').toEqual([]);
    expect(result.ok, 'a save that did not happen is not ok').toBe(false);
  });

  it('reports the failure to the caller instead of a silent ok', async () => {
    read = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    await expect(setMomentPrepDoneAction({ eventId: 'evt-1', doneIds: ['leave-by'] }))
      .resolves.toMatchObject({ ok: false, error: 'JWT expired' });
  });

  it('does not erase the blob when the refused read is an UNcheck either', async () => {
    read = { data: null, error: { code: '08006', message: 'connection failure' } };

    const result = await setMomentPrepDoneAction({ eventId: 'evt-1', doneIds: [] });

    expect(upserts).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('still merges — and preserves every other key — when the read succeeds', async () => {
    const result = await setMomentPrepDoneAction({ eventId: 'evt-1', doneIds: ['leave-by', 'pack-bag'] });

    expect(result).toEqual({ ok: true });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row.notification_prefs).toEqual({
      ...OTHER_PREFS,
      momentPrep: { 'evt-1': ['leave-by', 'pack-bag'] },
    });
  });

  it('treats a member with no preferences row as empty, not as a failure', async () => {
    read = { data: null, error: null };

    const result = await setMomentPrepDoneAction({ eventId: 'evt-2', doneIds: ['leave-by'] });

    expect(result).toEqual({ ok: true });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row.notification_prefs).toEqual({ momentPrep: { 'evt-2': ['leave-by'] } });
  });
});
