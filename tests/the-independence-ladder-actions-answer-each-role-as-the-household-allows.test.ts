// Call-level role tests for the Independence Ladder's three server actions
// (app/(app)/dashboard/independence/actions.ts), Register B rows
// ACTION-BA6D9C001E47 (start), ACTION-DFACF8805CFF (achieve) and
// ACTION-8FA22E77AF99 (skip).
//
// THE POLICY, from the sources and not from the action:
//   - 0442_a_childs_milestones_are_a_parents_to_mark.sql: independence_milestones
//     is written only where can_manage_family(family_id) — a parent or adult —
//     with restrictive guards on insert, update and delete. Every member reads.
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - The action's own header: "The ladder is a parent's to move (0442)".
// So a parent or adult moves the ladder of a child in THEIR family; a teen,
// child (a kid login is a child member: the same context), caregiver or guest
// is refused and nothing is written; an id from another family is refused and
// nothing in either family moves.
//
// The real exported actions run against tests/helpers/in-memory-supabase.ts.
// Only the signed-in context, the translator (key in, key out) and
// next/cache are stubbed. The fake has no RLS, so every refusal asserted here
// is the ACTION's own gate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { LADDER } from '@/lib/independence/progression';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  db: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { startMilestoneAction, achieveMilestoneAction, skipMilestoneAction } =
  await import('@/app/(app)/dashboard/independence/actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const KID_A = '00000000-0000-4000-8000-0000000001a1';
const KID_B = '00000000-0000-4000-8000-0000000001b1';
const RUNG_A = '00000000-0000-4000-8000-0000000002a1';
const RUNG_B = '00000000-0000-4000-8000-0000000002b1';
const RUNG = LADDER[0];
const SECOND_RUNG = LADDER[1];
const NOT_YOURS = 'actions.onlyAParentCanMoveTheLadder';

const MANAGERS = ['parent', 'adult'] as const;
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `00000000-0000-4000-8000-0000000009${role.length}0`, email: `${role}@example.com` },
    memberships: [],
    active: {
      familyId: FAMILY_A, role,
      family: { id: FAMILY_A, timezone: 'UTC' },
      member: { id: `member-${role}` },
    },
  });
}

function signedOut() {
  mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
}

const everything = () => structuredClone({
  milestones: db.table('independence_milestones'),
  audits: db.table('audit_logs'),
});
const rung = (id: string) => db.table('independence_milestones').find((r) => r.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { independence_milestones: [['family_id', 'member_id', 'domain', 'title']] } });
  mocks.db = db;
  db.seed('family_members', [
    { id: KID_A, family_id: FAMILY_A, display_name: 'Kit', role: 'child', is_active: true },
    { id: KID_B, family_id: FAMILY_B, display_name: 'Bo', role: 'child', is_active: true },
  ]);
  db.seed('independence_milestones', [
    { id: RUNG_A, family_id: FAMILY_A, member_id: KID_A, domain: SECOND_RUNG.domain, title: SECOND_RUNG.title, status: 'in_progress', evidence: null, achieved_at: null },
    { id: RUNG_B, family_id: FAMILY_B, member_id: KID_B, domain: SECOND_RUNG.domain, title: SECOND_RUNG.title, status: 'in_progress', evidence: null, achieved_at: null },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('startMilestoneAction', () => {
  it.each(MANAGERS)('ACTION-BA6D9C001E47 the %s adds the rung to their own child\'s ladder, in progress, and audits it', async (role) => {
    signInAs(role);
    expect(await startMilestoneAction(KID_A, RUNG.title)).toEqual({ ok: true });
    const added = db.table('independence_milestones').filter((r) => r.title === RUNG.title);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      family_id: FAMILY_A, member_id: KID_A, domain: RUNG.domain, status: 'in_progress', points: RUNG.points,
    });
    expect(db.table('audit_logs')).toHaveLength(1);
    expect(db.table('audit_logs')[0]).toMatchObject({ family_id: FAMILY_A, resource: 'independence_milestones' });
  });

  it.each(NON_MANAGERS)('ACTION-BA6D9C001E47 the %s is refused and nothing is added or audited', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await startMilestoneAction(KID_A, RUNG.title)).toEqual({ ok: false, error: NOT_YOURS });
    expect(everything()).toEqual(before);
  });

  it("ACTION-BA6D9C001E47 a parent naming another family's child is told the member is not found, and neither family's ladder moves", async () => {
    signInAs('parent');
    const before = everything();
    expect(await startMilestoneAction(KID_B, RUNG.title)).toEqual({ ok: false, error: 'actions.familyMemberNotFound' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-BA6D9C001E47 a signed-out caller is stopped at the session and writes nothing', async () => {
    signedOut();
    const before = everything();
    await expect(startMilestoneAction(KID_A, RUNG.title)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('achieveMilestoneAction', () => {
  it.each(MANAGERS)('ACTION-DFACF8805CFF the %s marks their own child\'s rung achieved with the evidence', async (role) => {
    signInAs(role);
    expect(await achieveMilestoneAction(RUNG_A, '  Packed the lunch alone  ')).toEqual({ ok: true });
    expect(rung(RUNG_A)).toMatchObject({ status: 'achieved', evidence: 'Packed the lunch alone' });
    expect(typeof rung(RUNG_A)?.achieved_at).toBe('string');
    expect(rung(RUNG_B)).toMatchObject({ status: 'in_progress', evidence: null, achieved_at: null });
  });

  it.each(NON_MANAGERS)('ACTION-DFACF8805CFF the %s is refused and the rung stays in progress', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await achieveMilestoneAction(RUNG_A, 'I did it')).toEqual({ ok: false, error: NOT_YOURS });
    expect(everything()).toEqual(before);
  });

  it("ACTION-DFACF8805CFF a parent naming another family's rung gets the could-not-update answer and neither family's rung moves", async () => {
    signInAs('parent');
    const before = everything();
    expect(await achieveMilestoneAction(RUNG_B, 'forged')).toEqual({ ok: false, error: 'actions.couldNotUpdateThatMilestone' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-DFACF8805CFF a signed-out caller is stopped at the session and writes nothing', async () => {
    signedOut();
    const before = everything();
    await expect(achieveMilestoneAction(RUNG_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('skipMilestoneAction', () => {
  it.each(MANAGERS)('ACTION-8FA22E77AF99 the %s skips their own child\'s rung', async (role) => {
    signInAs(role);
    expect(await skipMilestoneAction(RUNG_A)).toEqual({ ok: true });
    expect(rung(RUNG_A)?.status).toBe('skipped');
    expect(rung(RUNG_B)?.status).toBe('in_progress');
  });

  it.each(NON_MANAGERS)('ACTION-8FA22E77AF99 the %s is refused and the rung is not skipped', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await skipMilestoneAction(RUNG_A)).toEqual({ ok: false, error: NOT_YOURS });
    expect(everything()).toEqual(before);
  });

  it("ACTION-8FA22E77AF99 a parent naming another family's rung gets the could-not-update answer and neither family's rung moves", async () => {
    signInAs('parent');
    const before = everything();
    expect(await skipMilestoneAction(RUNG_B)).toEqual({ ok: false, error: 'actions.couldNotUpdateThatMilestone' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-8FA22E77AF99 a signed-out caller is stopped at the session and writes nothing', async () => {
    signedOut();
    const before = everything();
    await expect(skipMilestoneAction(RUNG_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});
