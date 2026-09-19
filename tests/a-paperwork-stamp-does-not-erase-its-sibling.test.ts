// "Tapping twice never double-creates" — the guarantee the module's own doc
// comment makes, and the one two ordinary taps break.
//
// materializePaperworkActionAction READS the whole `actions` array, creates the
// calendar event or reminder, then WRITES the whole array back with one element
// stamped. Two materializations that overlap both read the same array, and the
// second write erases the first one's stamp. The record it created is still
// there; the item no longer says so; the next tap makes a second one.
//
// This is not an exotic race. paperwork-module.tsx renders one button per
// action and disables only the button that is busy (`disabled={pending &&
// busy}`, where `busy` compares a SINGLE `busyKey`), so tapping "Add to
// calendar" and then "Remind me" on the same letter — the normal gesture for a
// permission slip that needs both — issues two overlapping server actions. And
// because `busyKey` holds one value, starting the second tap re-enables the
// first button mid-flight.
//
// The fix stamps ONE element in the database rather than rewriting the array,
// so two taps on different actions cannot erase each other. The narrower race —
// two taps on the SAME action inside the create window — is NOT closed here and
// is named in the audit: closing it means claiming before creating, which
// trades a rare double-create for a claim that can get stuck. Audit C1-S8-05.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const ITEM = 'item-1';
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'someone@example.com' },
    memberships: [],
    active: {
      familyId: FAMILY, role: 'parent',
      member: { id: 'member-1', family_id: FAMILY, user_id: 'user-1' },
      family: { id: FAMILY, name: 'Test household', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});
// The reminder half goes through the service; this test is about the stamp, so
// the service is a counter that hands back a fresh id each time. A second call
// for the same action is exactly the double-create being measured.
const reminders = vi.hoisted(() => ({ made: [] as string[] }));
vi.mock('@/lib/services/reminders', () => ({
  createReminder: async () => {
    const id = `reminder-${reminders.made.length + 1}`;
    reminders.made.push(id);
    return { ok: true, data: { id } };
  },
}));

const { materializePaperworkActionAction } = await import('@/app/(app)/dashboard/paperwork/actions');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;

const twoActions = () => ([
  { kind: 'rsvp', label: 'RSVP to the trip', materialized_as: null, materialized_id: null },
  { kind: 'sign', label: 'Sign the slip', materialized_as: null, materialized_id: null },
]);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reminders.made = [];
  db = createInMemorySupabase<DB>({
    // 0327's function, to its contract: stamp ONE element, refuse an element
    // that already carries a materialized_id, and recompute `status` from the
    // row as it stands rather than from the caller's copy. The SQL itself is
    // asserted separately, against a replayed schema, by
    // docs/audit/paperwork-stamp-concurrency-check.sql — this handler is here
    // so the ACTION can be driven, not so the fake can be trusted as Postgres.
    rpc: {
      paperwork_stamp_action: (args, inner) => {
        const rows = inner.table('paperwork_items') as Record<string, unknown>[];
        const row = rows.find((r) => r.id === args.p_item_id);
        if (!row || !Array.isArray(row.actions)) return false;
        const list = row.actions as Record<string, unknown>[];
        const target = list[args.p_index as number];
        if (!target || target.materialized_id) return false;
        target.materialized_id = args.p_id;
        target.materialized_as = args.p_as;
        if (row.status !== 'archived') {
          row.status = list.every((a) => a.materialized_id) ? 'done' : 'in_progress';
        }
        return true;
      },
    },
  });
  db.seed('families', [{ id: FAMILY, name: 'Test household', timezone: 'UTC' }]);
  db.seed('paperwork_items', [{
    id: ITEM, family_id: FAMILY, title: 'Field trip', kind: 'permission_slip',
    status: 'needs_action', urgency: 'soon', due_on: '2026-10-01',
    actions: twoActions(), meta: {}, summary: '', sender: 'School',
  }]);
  state.db = db;
});

const item = () => db.table('paperwork_items')[0] as Record<string, unknown>;
const actions = () => item().actions as { materialized_id: string | null }[];
const events = () => db.table('calendar_events');

describe('materializing two actions on one letter', () => {
  it('keeps both stamps when the taps overlap', async () => {
    // Both start before either finishes — the two-button gesture.
    await Promise.all([
      materializePaperworkActionAction({ itemId: ITEM, actionIndex: 0 }),
      materializePaperworkActionAction({ itemId: ITEM, actionIndex: 1 }),
    ]);
    expect(events()).toHaveLength(1);
    expect(reminders.made).toEqual(['reminder-1']);
    // The array, read back the way the module reads it.
    expect(actions()[0].materialized_id, 'the RSVP stamp was erased').toBeTruthy();
    expect(actions()[1].materialized_id, 'the signature stamp was erased').toBeTruthy();
  });

  it('does not create a second record when the erased stamp is tapped again', async () => {
    await Promise.all([
      materializePaperworkActionAction({ itemId: ITEM, actionIndex: 0 }),
      materializePaperworkActionAction({ itemId: ITEM, actionIndex: 1 }),
    ]);
    // Whatever the race did, the user now taps whichever button still looks
    // undone. If a stamp was lost, this is the double-create.
    for (const [i, a] of actions().entries()) {
      if (!a.materialized_id) await materializePaperworkActionAction({ itemId: ITEM, actionIndex: i });
    }
    expect(events(), 'a second calendar event was created').toHaveLength(1);
    expect(reminders.made, 'a second reminder was created').toEqual(['reminder-1']);
  });

  it('still marks the item done once every action is materialized', async () => {
    await materializePaperworkActionAction({ itemId: ITEM, actionIndex: 0 });
    expect(item().status).toBe('in_progress');
    await materializePaperworkActionAction({ itemId: ITEM, actionIndex: 1 });
    expect(item().status).toBe('done');
  });

  it('is a no-op on an action that is already materialized', async () => {
    await materializePaperworkActionAction({ itemId: ITEM, actionIndex: 0 });
    await materializePaperworkActionAction({ itemId: ITEM, actionIndex: 0 });
    expect(events()).toHaveLength(1);
  });
});
