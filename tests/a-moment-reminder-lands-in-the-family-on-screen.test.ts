import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * createMomentReminderAction ("turn this prep step into a reminder").
 *
 * It wrote `family_id: input.familyId` — the id the browser sent — while the
 * grocery add beside it had already been moved to the session's active family.
 * RLS admits any household the member belongs to, so a member of two families
 * could have the reminder filed in the one they were not looking at, and the
 * tap still reported success. (SRV-001 census, SRV-C01.)
 */

const state = vi.hoisted(() => ({ inserts: [] as { table: string; row: Record<string, unknown> }[] }));

function client() {
  return {
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { data: null, error: null };
        },
      };
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'm1' } } }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { createMomentReminderAction } = await import('@/app/(app)/dashboard/moment-actions');

const REMIND_AT = '2026-10-01T15:00:00.000Z';

beforeEach(() => { state.inserts = []; });

describe('a moment reminder lands in the family on screen', () => {
  it('refuses a family other than the active one and writes nothing', async () => {
    const res = await createMomentReminderAction({ familyId: 'family-2', title: 'Leave for soccer', remindAtISO: REMIND_AT, eventId: 'ev-1' });
    expect(res).toMatchObject({ ok: false });
    expect(state.inserts).toEqual([]);
  });

  it('files the reminder under the session’s family, not a value the caller sent', async () => {
    const res = await createMomentReminderAction({ familyId: 'family-1', title: 'Leave for soccer', remindAtISO: REMIND_AT, eventId: 'ev-1' });
    expect(res).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row.family_id).toBe('family-1');
  });

  it('uses the session’s family when the caller sends none', async () => {
    const res = await createMomentReminderAction({ familyId: '', title: 'Leave for soccer', remindAtISO: REMIND_AT, eventId: 'ev-1' });
    expect(res).toEqual({ ok: true });
    expect(state.inserts[0].row.family_id).toBe('family-1');
  });
});
