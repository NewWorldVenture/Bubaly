// Call-level role tests for the Family Memory server actions
// (app/(app)/dashboard/knowledge/actions.ts), Register B rows
// ACTION-83696258D19C (save), ACTION-C3C601C7C299 (pin) and
// ACTION-A4B8E175C5FC (forget).
//
// THE POLICY, from the sources and not from the action:
//   - 0264_ai_surface_role_privacy.sql:114-119: any member inserts a fact,
//     except `medical`/`account`, which are a parent's or adult's.
//   - 0385_a_member_only_rewrites_their_own_memory.sql:123-143: UPDATE and
//     DELETE need can_manage_family OR is_self_member(member_id) OR
//     created_by = auth.uid() — a parent or adult changes any memory, anyone
//     else only one about them or one they wrote.
//   - lib/services/memory/index.ts:100-104 (`mayChangeFact`) asks the same.
//   - The action's own guestRefusal (knowledge/actions.ts:39-47): a guest views
//     the family's memory and does not write to it, the household-roles rule
//     0464's household_write_is_not_a_guests() states for the household tables
//     ("A guest can see the household but not change it").
// So: a parent or adult adds, edits, pins and forgets any memory of their own
// family; a teen, child (a kid login is a child member: the same context) or
// caregiver adds one, and edits, pins or forgets only one about themselves or
// one they wrote; a guest is refused everything; a memory or member of another
// family is "not found" and nothing in either family changes.
//
// The real exported actions and the real memory service run against
// tests/helpers/in-memory-supabase.ts; only the signed-in context, the
// translator (key in, key out) and next/cache are stubbed. The fake has no
// RLS, so every refusal here is the action's or the service's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  db: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { saveFactAction, setFactPinnedAction, forgetFactAction } = await import('@/app/(app)/dashboard/knowledge/actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const PARENT_USER = 'user-parent';
// A household fact a PARENT wrote (member_id null): a manager's to change.
const HOUSEHOLD_FACT = '00000000-0000-4000-8000-0000000005a1';
// A fact about the caller themselves, written by a parent: the caller's to change.
const ABOUT_ME_FACT = '00000000-0000-4000-8000-0000000005a2';
const FOREIGN_FACT = '00000000-0000-4000-8000-0000000005b1';
const FOREIGN_MEMBER = '00000000-0000-4000-8000-0000000006b1';

const MANAGERS = ['parent', 'adult'] as const;
const OTHERS = ['teen', 'child', 'caregiver'] as const;
const GUEST_REFUSAL = { ok: false, error: 'householdRoles.guestViewsOnly' };
const NOT_YOURS = { ok: false, error: 'Only a parent or adult can change a memory about someone else.' };
const NOT_YOURS_TO_FORGET = { ok: false, error: 'Only a parent or adult can forget a memory about someone else.' };
const NOT_FOUND = { ok: false, error: 'That memory could not be found.' };

let db: InMemorySupabase;

const userOf = (role: string) => (role === 'parent' ? PARENT_USER : `user-${role}`);
const memberOf = (role: string) => `member-${role}`;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userOf(role), email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, role, family: { id: FAMILY_A, timezone: 'UTC' }, member: { id: memberOf(role) } },
  });
}

const facts = () => structuredClone(db.table('family_facts'));
const fact = (id: string) => db.table('family_facts').find((r) => r.id === id);

function seed(aboutMe: string) {
  db.seed('family_members', [
    ...['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'].map((role) => ({
      id: memberOf(role), family_id: FAMILY_A, role, display_name: role, is_active: true,
    })),
    { id: FOREIGN_MEMBER, family_id: FAMILY_B, role: 'child', display_name: 'Bo', is_active: true },
  ]);
  db.seed('family_facts', [
    { id: HOUSEHOLD_FACT, family_id: FAMILY_A, member_id: null, category: 'preference', label: 'Pizza night', value: 'Fridays', notes: null, is_pinned: false, source: 'user', created_by: PARENT_USER },
    { id: ABOUT_ME_FACT, family_id: FAMILY_A, member_id: aboutMe, category: 'preference', label: 'Shoe size', value: '3', notes: null, is_pinned: false, source: 'user', created_by: PARENT_USER },
    { id: FOREIGN_FACT, family_id: FAMILY_B, member_id: null, category: 'preference', label: 'Pizza night', value: 'Saturdays', notes: null, is_pinned: false, source: 'user', created_by: 'user-b' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('saveFactAction', () => {
  it.each([...MANAGERS, ...OTHERS])('ACTION-83696258D19C the %s adds a household memory to their own family, as theirs', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    const result = await saveFactAction(null, { label: 'Bedtime', value: '8pm', category: 'routine' });
    const added = db.table('family_facts').filter((r) => r.label === 'Bedtime');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ family_id: FAMILY_A, member_id: null, value: '8pm', source: 'user', created_by: userOf(role) });
    expect(result).toEqual({ ok: true, id: added[0].id });
  });

  it.each(MANAGERS)("ACTION-83696258D19C the %s edits a household memory a parent wrote", async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await saveFactAction(HOUSEHOLD_FACT, { label: 'Pizza night', value: 'Thursdays' })).toEqual({ ok: true, id: HOUSEHOLD_FACT });
    expect(fact(HOUSEHOLD_FACT)?.value).toBe('Thursdays');
    expect(fact(FOREIGN_FACT)?.value).toBe('Saturdays');
  });

  it.each(OTHERS)("ACTION-83696258D19C the %s may not edit a household memory a parent wrote, and it is unchanged", async (role) => {
    seed(memberOf(role));
    signInAs(role);
    const before = facts();
    expect(await saveFactAction(HOUSEHOLD_FACT, { label: 'Pizza night', value: 'Never' })).toEqual(NOT_YOURS);
    expect(facts()).toEqual(before);
  });

  it.each(OTHERS)('ACTION-83696258D19C the %s edits a memory about themselves', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await saveFactAction(ABOUT_ME_FACT, { label: 'Shoe size', value: '4' })).toEqual({ ok: true, id: ABOUT_ME_FACT });
    expect(fact(ABOUT_ME_FACT)?.value).toBe('4');
  });

  it.each(OTHERS)('ACTION-83696258D19C the %s may not file a medical memory, and nothing is written', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    const before = facts();
    expect(await saveFactAction(null, { label: 'Allergy', value: 'Peanuts', category: 'medical' }))
      .toEqual({ ok: false, error: 'Only a parent or adult can file a memory as medical or account information.' });
    expect(facts()).toEqual(before);
  });

  it('ACTION-83696258D19C a guest is refused an add and an edit, and nothing is written', async () => {
    seed(memberOf('guest'));
    signInAs('guest');
    const before = facts();
    expect(await saveFactAction(null, { label: 'Bedtime', value: '8pm' })).toEqual(GUEST_REFUSAL);
    expect(await saveFactAction(ABOUT_ME_FACT, { label: 'Shoe size', value: '9' })).toEqual(GUEST_REFUSAL);
    expect(facts()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("ACTION-83696258D19C a parent editing another family's memory is told it is not found, and neither family's memory changes", async () => {
    seed(memberOf('parent'));
    signInAs('parent');
    const before = facts();
    expect(await saveFactAction(FOREIGN_FACT, { label: 'Pizza night', value: 'Mondays' })).toEqual(NOT_FOUND);
    expect(facts()).toEqual(before);
  });

  it("ACTION-83696258D19C a parent filing a memory about another family's member is refused, and nothing is written", async () => {
    seed(memberOf('parent'));
    signInAs('parent');
    const before = facts();
    const result = await saveFactAction(null, { label: 'Bedtime', value: '8pm', memberId: FOREIGN_MEMBER });
    expect(result.ok).toBe(false);
    expect(facts()).toEqual(before);
    // And re-pointing one of the family's own memories at that member is refused too.
    expect((await saveFactAction(HOUSEHOLD_FACT, { label: 'Pizza night', value: 'Fridays', memberId: FOREIGN_MEMBER })).ok).toBe(false);
    expect(facts()).toEqual(before);
  });

  it('ACTION-83696258D19C a signed-out caller is stopped at the session and writes nothing', async () => {
    seed(memberOf('parent'));
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = facts();
    await expect(saveFactAction(null, { label: 'Bedtime', value: '8pm' })).rejects.toThrow('NEXT_REDIRECT');
    expect(facts()).toEqual(before);
  });
});

describe('setFactPinnedAction', () => {
  it.each(MANAGERS)('ACTION-C3C601C7C299 the %s pins a household memory a parent wrote', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await setFactPinnedAction(HOUSEHOLD_FACT, true)).toEqual({ ok: true, id: HOUSEHOLD_FACT });
    expect(fact(HOUSEHOLD_FACT)?.is_pinned).toBe(true);
    expect(fact(FOREIGN_FACT)?.is_pinned).toBe(false);
  });

  it.each(OTHERS)('ACTION-C3C601C7C299 the %s may not pin a household memory a parent wrote, and it is unchanged', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    const before = facts();
    expect(await setFactPinnedAction(HOUSEHOLD_FACT, true)).toEqual(NOT_YOURS);
    expect(facts()).toEqual(before);
  });

  it.each(OTHERS)('ACTION-C3C601C7C299 the %s pins a memory about themselves', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await setFactPinnedAction(ABOUT_ME_FACT, true)).toEqual({ ok: true, id: ABOUT_ME_FACT });
    expect(fact(ABOUT_ME_FACT)?.is_pinned).toBe(true);
  });

  it('ACTION-C3C601C7C299 a guest is refused and nothing is pinned', async () => {
    seed(memberOf('guest'));
    signInAs('guest');
    const before = facts();
    expect(await setFactPinnedAction(ABOUT_ME_FACT, true)).toEqual(GUEST_REFUSAL);
    expect(facts()).toEqual(before);
  });

  it("ACTION-C3C601C7C299 a parent pinning another family's memory is told it is not found, and neither family's memory changes", async () => {
    seed(memberOf('parent'));
    signInAs('parent');
    const before = facts();
    expect(await setFactPinnedAction(FOREIGN_FACT, true)).toEqual(NOT_FOUND);
    expect(facts()).toEqual(before);
  });

  it('ACTION-C3C601C7C299 a signed-out caller is stopped at the session and writes nothing', async () => {
    seed(memberOf('parent'));
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = facts();
    await expect(setFactPinnedAction(HOUSEHOLD_FACT, true)).rejects.toThrow('NEXT_REDIRECT');
    expect(facts()).toEqual(before);
  });
});

describe('forgetFactAction', () => {
  it.each(MANAGERS)('ACTION-A4B8E175C5FC the %s forgets a household memory a parent wrote, and only that one', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await forgetFactAction(HOUSEHOLD_FACT)).toEqual({ ok: true, id: HOUSEHOLD_FACT });
    expect(fact(HOUSEHOLD_FACT)).toBeUndefined();
    expect(fact(FOREIGN_FACT)?.value).toBe('Saturdays');
  });

  it.each(OTHERS)('ACTION-A4B8E175C5FC the %s may not forget a household memory a parent wrote, and it stays', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    const before = facts();
    expect(await forgetFactAction(HOUSEHOLD_FACT)).toEqual(NOT_YOURS_TO_FORGET);
    expect(facts()).toEqual(before);
  });

  it.each(OTHERS)('ACTION-A4B8E175C5FC the %s forgets a memory about themselves', async (role) => {
    seed(memberOf(role));
    signInAs(role);
    expect(await forgetFactAction(ABOUT_ME_FACT)).toEqual({ ok: true, id: ABOUT_ME_FACT });
    expect(fact(ABOUT_ME_FACT)).toBeUndefined();
    expect(fact(HOUSEHOLD_FACT)?.value).toBe('Fridays');
  });

  it('ACTION-A4B8E175C5FC a guest is refused and nothing is forgotten', async () => {
    seed(memberOf('guest'));
    signInAs('guest');
    const before = facts();
    expect(await forgetFactAction(ABOUT_ME_FACT)).toEqual(GUEST_REFUSAL);
    expect(facts()).toEqual(before);
  });

  it("ACTION-A4B8E175C5FC a parent forgetting another family's memory is told it is not found, and neither family's memory goes", async () => {
    seed(memberOf('parent'));
    signInAs('parent');
    const before = facts();
    expect(await forgetFactAction(FOREIGN_FACT)).toEqual(NOT_FOUND);
    expect(facts()).toEqual(before);
  });

  it('ACTION-A4B8E175C5FC a signed-out caller is stopped at the session and deletes nothing', async () => {
    seed(memberOf('parent'));
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = facts();
    await expect(forgetFactAction(HOUSEHOLD_FACT)).rejects.toThrow('NEXT_REDIRECT');
    expect(facts()).toEqual(before);
  });
});
