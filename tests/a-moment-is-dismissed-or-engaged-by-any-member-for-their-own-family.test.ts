// Call-level role tests for app/(app)/dashboard/moments/actions.ts (Register B
// ACTION-94972CCF8DD8 dismissMomentAction, ACTION-0D464B09E078 engageMomentAction).
//
// THE POLICY, from the sources rather than from the action:
//   - moment_activations RLS (0148, the only migration that names the table):
//     insert/update `is_family_member(family_id)`, no role. No later sweep
//     (0461, 0464, 0481) lists the table.
//   - /dashboard/moments is a Free (minLevel 0) entry with no `manage` flag
//     (lib/constants/navigation.ts:78), and components/moments/moment-organizer.tsx
//     renders the Dismiss X on every card for every reader — no role prop.
//   - lib/auth/guest-scope.ts does not withhold /dashboard/moments.
// So every household member except the guest is pinned as allowed to write
// their own family's row. The guest is left unpinned: 0464's header says every
// model describes a guest as one who looks and does not write, and
// lib/trust/engine.ts gives a guest only ['view'], while the RLS and the page
// let a guest dismiss. That is recorded as an owner decision, not asserted.
//
// The family always comes from the session: neither action takes a family or
// row id, so the cross-family case is "a moment key that another family also
// has a row for today", and that family's row must not move.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
// 15:00 UTC is 10:00 in New York — the same calendar day in every host zone
// the suite runs under, and the action resolves the day in the FAMILY's zone.
const NOW = '2026-03-10T15:00:00Z';
const TODAY = '2026-03-10';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { dismissMomentAction, engageMomentAction } = await import('@/app/(app)/dashboard/moments/actions');

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

let db: InMemorySupabase;
/** Family B's table as seeded, read back from the fake (with its defaults). */
let bAsSeeded: unknown[];

function signedInAs(role: Role, opts: { kidLogin?: boolean } = {}) {
  const email = opts.kidLogin ? `kid-${role}@kids.bubaly.app` : `${role}@example.com`;
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}`, email },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      family: { id: FAMILY_A, timezone: 'America/New_York' },
      role,
      member: { id: `member-${role}` },
    },
  });
}

/** Family B's row for the same moment and day, written by B's own parent. */
const B_ROW = {
  id: '00000000-0000-4000-8000-0000000000b1',
  family_id: FAMILY_B,
  moment_key: 'dinner',
  as_of_date: TODAY,
  status: 'active',
  created_by: 'user-b-parent',
};

const rowsOf = (family: string) => db.table('moment_activations').filter((r) => r.family_id === family);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase({
    uniques: { moment_activations: [['family_id', 'moment_key', 'as_of_date']] },
  });
  db.seed('moment_activations', [{ ...B_ROW }]);
  bAsSeeded = structuredClone(rowsOf(FAMILY_B));
  mocks.createServer.mockResolvedValue(db);
});
afterEach(() => {
  vi.useRealTimers();
});

const ACTIONS = [
  { id: 'ACTION-94972CCF8DD8', name: 'dismissMomentAction', run: dismissMomentAction, status: 'dismissed' },
  { id: 'ACTION-0D464B09E078', name: 'engageMomentAction', run: engageMomentAction, status: 'engaged' },
] as const;

describe.each(ACTIONS)('$id $name', ({ id, run, status }) => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'] as const)(
    `${id} as a member with role %s, writes exactly one row for their own family's day`,
    async (role) => {
      signedInAs(role);
      await expect(run('dinner')).resolves.toEqual({ ok: true });
      expect(rowsOf(FAMILY_A).map(({ family_id, moment_key, as_of_date, status: s, created_by }) =>
        ({ family_id, moment_key, as_of_date, status: s, created_by }))).toEqual([
        { family_id: FAMILY_A, moment_key: 'dinner', as_of_date: TODAY, status, created_by: `user-${role}` },
      ]);
      expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/moments');
    },
  );

  it(`${id} a child on a kid login writes the same row`, async () => {
    signedInAs('child', { kidLogin: true });
    await expect(run('dinner')).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_A)).toHaveLength(1);
    expect(rowsOf(FAMILY_A)[0]).toMatchObject({ status, created_by: 'user-child' });
  });

  it(`${id} a second tap on the same day updates the one row rather than adding another`, async () => {
    signedInAs('parent');
    await expect(run('dinner')).resolves.toEqual({ ok: true });
    await expect(run('dinner')).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_A)).toHaveLength(1);
  });

  it(`${id} another family's row for the same moment and day is left exactly as it was`, async () => {
    signedInAs('parent');
    await expect(run('dinner')).resolves.toEqual({ ok: true });
    expect(rowsOf(FAMILY_B)).toEqual(bAsSeeded);
    expect(rowsOf(FAMILY_A)).toHaveLength(1);
  });

  it(`${id} an empty key is refused before the session is read, and nothing is written`, async () => {
    signedInAs('parent');
    await expect(run('')).resolves.toEqual({ ok: false, error: 'actions.invalidMoment' });
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
    expect(db.table('moment_activations')).toEqual(bAsSeeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it(`${id} a signed-out caller is sent away and nothing is written`, async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    await expect(run('dinner')).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('moment_activations')).toEqual(bAsSeeded);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it(`${id} a refused write is reported and the page is not revalidated`, async () => {
    signedInAs('parent');
    const refusing = {
      from: (name: string) => {
        const builder = db.from(name);
        return Object.assign(builder, {
          upsert: () => Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }),
        });
      },
    };
    mocks.createServer.mockResolvedValue(refusing);
    const result = await run('dinner');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/i);
    expect(rowsOf(FAMILY_A)).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
