// Call-level role tests for resolving an entry on the Family Assistant feed
// (app/(app)/dashboard/agents/actions.ts), Register B ACTION-3FF1CF422A1C
// (resolveActivityAction).
//
// THE POLICY. The feed is the family's shared view of what Bubaly surfaced.
// Every member may mark an entry done or dismissed: /dashboard/agents is open
// to every role at every plan (lib/constants/navigation.ts:82, minLevel 0, and
// lib/auth/guest-scope.ts does not withhold it), components/modules/
// agents-module.tsx offers the two buttons with no role check, and the live
// policy on agent_activity is family membership for every command
// (0127_agent_activity.sql:41-48, `is_family_member(family_id)`). What no one
// may do is reach another household's entry: setActivityStatus filters the
// caller's family and answers a row it cannot find as not found.
//
// WHAT IS ASSERTED: for each role in household A the real action moves only
// the named entry to the chosen status; an id from household B is refused as
// not found and neither household's feed changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, requireUserContext: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { resolveActivityAction } = await import('@/app/(app)/dashboard/agents/actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const ENTRY_A = '00000000-0000-4000-8000-0000000000e1';
const OTHER_A = '00000000-0000-4000-8000-0000000000e2';
const ENTRY_B = '00000000-0000-4000-8000-0000000000e3';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-a-${role}`, email: `${role}@example.com` },
    active: { familyId: FAMILY_A, role, member: { id: `member-a-${role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
  });
}

const feed = () => structuredClone(db.table('agent_activity'));
const statusOf = (id: string) => db.table('agent_activity').find((r) => r.id === id)?.status;

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  db.seed('agent_activity', [
    { id: ENTRY_A, family_id: FAMILY_A, agent: 'scheduler', title: 'Dentist on Tuesday', status: 'active' },
    { id: OTHER_A, family_id: FAMILY_A, agent: 'groceries', title: 'Milk is low', status: 'active' },
    { id: ENTRY_B, family_id: FAMILY_B, agent: 'scheduler', title: 'Their own entry', status: 'active' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('resolveActivityAction', () => {
  it.each(ROLES.flatMap((role) => (['done', 'dismissed'] as const).map((status) => [role, status] as const)))(
    'ACTION-3FF1CF422A1C signed in as %s, a member marks their family\'s entry %s and nothing else moves',
    async (role, status) => {
      signInAs(role);
      expect(await resolveActivityAction(ENTRY_A, status)).toEqual({ ok: true });
      expect(statusOf(ENTRY_A)).toBe(status);
      expect(statusOf(OTHER_A)).toBe('active');
      expect(statusOf(ENTRY_B)).toBe('active');
      expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/agents');
    },
  );

  it.each(ROLES)('ACTION-3FF1CF422A1C signed in as %s, an entry of another household is not found and no feed changes', async (role) => {
    signInAs(role);
    const before = feed();
    expect(await resolveActivityAction(ENTRY_B, 'done')).toEqual({ ok: false, error: 'That activity could not be found.' });
    expect(feed()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-3FF1CF422A1C a status the roster has no button for is narrowed, never written as given', async () => {
    signInAs('child');
    expect(await resolveActivityAction(ENTRY_A, 'active' as never)).toEqual({ ok: true });
    expect(statusOf(ENTRY_A)).toBe('dismissed');
  });
});
