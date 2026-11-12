// dismissNotificationAction, called the way the bell's bin calls it, by every
// household role, on their own notification, on a family-wide one, on another
// member's, and on one of another family.
//
// THE POLICY, from the sources rather than from the action:
//   - Who may dismiss is who could delete (the action's docstring,
//     app/(app)/dashboard/notifications/actions.ts:20-24): the recipient, or a
//     manager for a family-wide row. The live `notif_select`
//     (supabase/migrations/0118_rls_drift_repair.sql:99) shows a member only
//     their own rows and the family-wide ones, so another member's personal
//     notification is not the caller's to see, let alone dismiss — not even a
//     manager's, although `notif_delete` (0118:108) would let a manager delete
//     it. A family-wide row is a manager's to dismiss (`can_manage_family`,
//     lib/constants/roles.ts isManager = parent or adult).
//   - The write is the service role's, so the action's own family filter and
//     recipient check are the boundary; nothing in RLS stops it.
//
// Mocked: the session, both client factories (one in-memory database behind
// both), and the translator (the real en-US source catalogue). The clock is
// pinned so the settled stamps can be asserted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, userIdOf, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({ caller: 'parent' as string | null, db: null as unknown }));

vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { dismissNotificationAction } = await import('@/app/(app)/dashboard/notifications/actions');

const NOW = '2026-11-12T15:00:00.000Z';
const PARKED = '9999-12-31T00:00:00.000Z';
const NOT_SAVED = "That change wasn't saved — you may not have permission. Refresh and try again.";
const WIDE_A = 'a0000000-0000-4000-8000-0000000a0201';
const WIDE_B = 'b0000000-0000-4000-8000-0000000b0201';
const PERSONAL_B = 'b0000000-0000-4000-8000-0000000b0202';
/** A family-B row addressed to family A's parent's own user, as if they belonged to both families. */
const MINE_IN_B = 'b0000000-0000-4000-8000-0000000b0203';
/** One personal notification per caller of family A. */
const personalId = (caller: Caller) => `a0000000-0000-4000-8000-0000000a03${String(CALLERS.indexOf(caller)).padStart(2, '0')}`;

const MANAGERS: Caller[] = ['parent', 'adult'];
const NON_MANAGERS: Caller[] = ['teen', 'child', 'kid', 'caregiver', 'guest'];

let db: InMemorySupabase;
/** Every update the action SENT to notifications, landed or not. */
let updatesSent: number;
const row = (id: string) => db.table('notifications').find((r) => r.id === id) as Row | undefined;
const unsent = { is_read: false, send_at: '2026-11-12T08:00:00.000Z', sent_at: null, pushed_at: null };
const dismissed = { is_read: true, send_at: PARKED, sent_at: NOW, pushed_at: NOW };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase();
  updatesSent = 0;
  harness.db = withFaults(db, (table, calls) => {
    if (table === 'notifications' && calls.some((call) => call.method === 'update')) updatesSent += 1;
    return null;
  });
  harness.caller = 'parent';
  db.seed('notifications', [
    ...CALLERS.map((caller) => ({ id: personalId(caller), family_id: FAMILY_A, user_id: userIdOf(caller), title: `For ${caller}`, ...unsent })),
    { id: WIDE_A, family_id: FAMILY_A, user_id: null, title: 'Bins tonight', ...unsent },
    { id: WIDE_B, family_id: FAMILY_B, user_id: null, title: 'Their bins', ...unsent },
    { id: PERSONAL_B, family_id: FAMILY_B, user_id: userIdOf('parent', FAMILY_B), title: 'Their parent', ...unsent },
    { id: MINE_IN_B, family_id: FAMILY_B, user_id: userIdOf('parent'), title: 'Mine, but in the other family', ...unsent },
  ]);
});

afterEach(() => { vi.useRealTimers(); });

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('dismissNotificationAction (ACTION-9CD10DFF9CBC)', () => {
  it.each(CALLERS)('ACTION-9CD10DFF9CBC a %s dismisses their own notification: kept, read, settled and parked', async (caller) => {
    as(caller);
    expect(await dismissNotificationAction({ id: personalId(caller) })).toEqual({ ok: true });
    expect(row(personalId(caller))).toEqual(expect.objectContaining(dismissed));
    // Only that row moved.
    expect(db.table('notifications').filter((r) => r.is_read === true).map((r) => r.id)).toEqual([personalId(caller)]);
  });

  it.each(MANAGERS)('ACTION-9CD10DFF9CBC a %s dismisses a family-wide notification', async (caller) => {
    as(caller);
    expect(await dismissNotificationAction({ id: WIDE_A })).toEqual({ ok: true });
    expect(row(WIDE_A)).toEqual(expect.objectContaining(dismissed));
  });

  it.each(NON_MANAGERS)('ACTION-9CD10DFF9CBC a %s may not dismiss a family-wide notification for everyone', async (caller) => {
    as(caller);
    expect(await dismissNotificationAction({ id: WIDE_A })).toEqual({ ok: false, error: NOT_SAVED });
    expect(row(WIDE_A)).toEqual(expect.objectContaining(unsent));
  });

  it.each(CALLERS.filter((c) => c !== 'parent'))(
    "ACTION-9CD10DFF9CBC a %s may not dismiss the parent's personal notification",
    async (caller) => {
      as(caller);
      expect(await dismissNotificationAction({ id: personalId('parent') })).toEqual({ ok: false, error: NOT_SAVED });
      expect(row(personalId('parent'))).toEqual(expect.objectContaining(unsent));
    },
  );

  it.each([
    ['a family-wide', WIDE_B],
    ["their parent's personal", PERSONAL_B],
    ["the caller's own (addressed to their user) but filed under that family", MINE_IN_B],
  ])(
    "ACTION-9CD10DFF9CBC another family's %s notification is not dismissed from family A, and no write is sent",
    async (_label, id) => {
      const before = structuredClone(db.table('notifications'));
      expect(await dismissNotificationAction({ id })).toEqual({ ok: false, error: NOT_SAVED });
      expect(updatesSent).toBe(0);
      expect(db.table('notifications')).toEqual(before);
    },
  );

  it('ACTION-9CD10DFF9CBC a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = structuredClone(db.table('notifications'));
    await expect(dismissNotificationAction({ id: WIDE_A })).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('notifications')).toEqual(before);
  });
});
