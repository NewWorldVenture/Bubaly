// The Family Digital Twin's four server actions, called the way its page calls
// them, for every role of household A, with household B beside it.
//
// The policy, from the sources:
//   - simulateDecisionAction / projectActivityAction read; nothing is written
//     (the file's own header). The schedule half is every member's (the page
//     offers both tools to everyone, app/(app)/dashboard/family-digital-twin/
//     page.tsx). The money half — a spend simulation, a projection's Cost line —
//     is a parent's or adult's (readsHouseholdMoney, lib/finance/household-money.ts).
//   - saveSimulationAction: a guest views and does not write (roles.ts
//     ROLE_DESCRIPTIONS.guest, the page's canSave={!guest}); everyone else
//     saves; the member named must be one of A's.
//   - deleteSimulationAction: a manager (isManager) deletes any of A's; anyone
//     else only the one they saved; a guest none (the action's comment and the
//     page's canDelete).
//   - Everything is A's: an id or member of B is refused and B is untouched.
//
// The plan gate (/dashboard/family-digital-twin is 'plus' in the feature
// catalog) is NOT pinned here: none of these actions checks it. See the PR's
// "Defects found" / "Needs an owner decision".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;

const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent' as string,
  email: null as string | null,
  revalidated: [] as string[],
  signedOut: false,
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidated.push(path); } }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (harness.signedOut) throw new Error('REDIRECT:/login');
    return {
      user: { id: `user-${harness.role}`, email: harness.email },
      memberships: [],
      active: { familyId: FAMILY_A, role: harness.role, member: { id: `member-${harness.role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
    };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});

const { simulateDecisionAction, projectActivityAction, saveSimulationAction, deleteSimulationAction } =
  await import('@/app/(app)/dashboard/family-digital-twin/actions');
const { SOURCE_MESSAGES } = await import('@/lib/i18n/messages');

const GUEST_VIEWS_ONLY = SOURCE_MESSAGES['householdRoles.guestViewsOnly'];
const KEPT_BY_PARENTS = SOURCE_MESSAGES['householdMoney.keptByParents'];
const NOT_A_MEMBER = SOURCE_MESSAGES['actions.thatUserIsNotAn'];
const COULD_NOT_DELETE = SOURCE_MESSAGES['actions.couldNotDeleteThatSimulation'];

let db: InMemorySupabase;
let read: string[];

function as(role: string, email: string | null = `${role}@example.com`) {
  harness.role = role;
  harness.email = email;
}

const sims = () => db.table('twin_simulations');
const simsOf = (family: string) => structuredClone(sims().filter((s) => s.family_id === family));

/** A's child Emma is at gymnastics 16:30–18:00 on the 15th; B's child Leo has the same slot in B. */
const PIANO = (memberId: string) => ({
  kind: 'commitment' as const, memberId, memberName: 'Emma', title: 'Piano lesson',
  startsAt: '2026-10-15T17:00:00Z', durationMin: 60, weeks: 1,
});
const SPEND = { kind: 'spend' as const, label: 'Cleats', category: 'Sports', amountDollars: 100 };
const SOCCER = (extra: Record<string, unknown> = {}) => ({
  memberId: 'member-child', memberName: 'Emma', activityName: 'Travel soccer',
  startsAt: '2026-10-17T10:00:00Z', durationMin: 90, sessionsPerWeek: 3, weeks: 4, travelMinEach: 30, ...extra,
});

const seedSim = (id: string, family: string, createdBy: string) => db.seed('twin_simulations', [{
  id, family_id: family, member_id: null, activity_name: `Scenario ${id}`, verdict: 'tight', weekly_hours: 4,
  input: {}, dimensions: [], created_by: createdBy, created_at: '2026-10-10T00:00:00Z',
}]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.revalidated = [];
  harness.signedOut = false;
  as('parent');
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  read = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => { read.push(table); return from(table); });
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY_A, user_id: 'user-parent', role: 'parent', display_name: 'Ana', is_active: true },
    { id: 'member-child', family_id: FAMILY_A, user_id: 'user-child', role: 'child', display_name: 'Emma', is_active: true },
    { id: 'member-leo', family_id: FAMILY_B, user_id: 'user-leo', role: 'child', display_name: 'Leo', is_active: true },
  ]);
  db.seed('calendar_events', [
    { id: 'ev-a', family_id: FAMILY_A, title: 'Gymnastics', starts_at: '2026-10-15T16:30:00Z', ends_at: '2026-10-15T18:00:00Z',
      all_day: false, assignee_id: 'member-child', recurrence: 'none', recurrence_until: null },
    { id: 'ev-b', family_id: FAMILY_B, title: 'Hockey', starts_at: '2026-10-15T16:30:00Z', ends_at: '2026-10-15T18:00:00Z',
      all_day: false, assignee_id: 'member-leo', recurrence: 'none', recurrence_until: null },
  ]);
  // A's Sports budget: $300 a month, $250 spent. B's is older (so it would be
  // the one budgetByCategory picks if it leaked) and untouched.
  db.seed('budgets', [
    { id: 'budget-b', family_id: FAMILY_B, category: 'Sports', amount: 10_000, period: 'monthly', created_at: '2025-01-01T00:00:00Z' },
    { id: 'budget-a', family_id: FAMILY_A, category: 'Sports', amount: 300, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('transactions', [
    { id: 'tx-a', family_id: FAMILY_A, name: 'Cleats', amount: 250, category: 'Sports', date: '2026-10-02', type: 'expense' },
    { id: 'tx-b', family_id: FAMILY_B, name: 'Ice time', amount: 9_000, category: 'Sports', date: '2026-10-03', type: 'expense' },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ACTION-0450C5505E88 simulateDecisionAction', () => {
  it.each([...ROLES])('ACTION-0450C5505E88 the %s simulates a commitment against A\'s calendar, and nothing is written', async (role) => {
    as(role);
    const result = await simulateDecisionAction(PIANO('member-child'));
    expect(result.verdict).toBe('conflict');
    expect(JSON.stringify(result)).toContain('Gymnastics');
    expect(sims()).toEqual([]);
    expect(harness.revalidated).toEqual([]);
  });

  it('ACTION-0450C5505E88 a child on a kid login simulates a commitment like any child', async () => {
    as('child', `kid-1@${CHILD_LOGIN_EMAIL_DOMAIN}`);
    expect((await simulateDecisionAction(PIANO('member-child'))).verdict).toBe('conflict');
  });

  it.each(['parent', 'adult'])('ACTION-0450C5505E88 the %s simulates a spend against A\'s own Sports budget', async (role) => {
    as(role);
    const result = await simulateDecisionAction(SPEND);
    // $250 + $100 against A's $300 limit. B's $10,000 budget and $9,000 are not in it.
    expect(result.verdict).toBe('conflict');
    const text = JSON.stringify(result);
    expect(text).toContain('$300');
    expect(text).not.toMatch(/10,000|9,000/);
    expect(read).toContain('budgets');
    expect(sims()).toEqual([]);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('ACTION-0450C5505E88 the %s is told whose budget it is, and no money table is read', async (role) => {
    as(role);
    const result = await simulateDecisionAction(SPEND);
    expect(result.verdict).toBe('conflict');
    expect(result.headline).toBe(KEPT_BY_PARENTS);
    expect(read).not.toContain('budgets');
    expect(read).not.toContain('transactions');
  });

  it('ACTION-0450C5505E88 a member of household B is simulated against nothing of B\'s', async () => {
    // Leo (B) has a clash in B at that hour; A's session must not read it.
    const result = await simulateDecisionAction(PIANO('member-leo'));
    expect(result.verdict).toBe('clear');
    expect(JSON.stringify(result)).not.toContain('Hockey');
    expect(sims()).toEqual([]);
  });

  it('ACTION-0450C5505E88 a signed-out caller is sent to sign in and nothing is read', async () => {
    harness.signedOut = true;
    await expect(simulateDecisionAction(PIANO('member-child'))).rejects.toThrow('REDIRECT:/login');
    expect(read).toEqual([]);
  });
});

describe('ACTION-0EAB6903D9E2 projectActivityAction', () => {
  it.each(['parent', 'adult'])('ACTION-0EAB6903D9E2 the %s gets the projection with A\'s Cost line, and nothing is written', async (role) => {
    as(role);
    const res = await projectActivityAction(SOCCER({ costDollars: 120, costCategory: 'Sports' }));
    expect(res.ok).toBe(true);
    const keys = res.ok ? res.data.dimensions.map((d) => d.key) : [];
    expect(keys).toContain('cost');
    expect(JSON.stringify(res)).toContain('$300');
    expect(JSON.stringify(res)).not.toMatch(/10,000|9,000/);
    expect(sims()).toEqual([]);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('ACTION-0EAB6903D9E2 the %s gets the schedule projection with no Cost line and no money read', async (role) => {
    as(role);
    const res = await projectActivityAction(SOCCER({ costDollars: 120, costCategory: 'Sports' }));
    expect(res.ok).toBe(true);
    const keys = res.ok ? res.data.dimensions.map((d) => d.key) : [];
    expect(keys).toContain('schedule');
    expect(keys).not.toContain('cost');
    expect(read).not.toContain('budgets');
    expect(read).not.toContain('transactions');
    expect(sims()).toEqual([]);
  });

  it('ACTION-0EAB6903D9E2 a projection for a member of B reads none of B\'s schedule', async () => {
    const forLeo = await projectActivityAction(SOCCER({ memberId: 'member-leo', memberName: 'Leo', startsAt: '2026-10-15T16:30:00Z' }));
    const forEmma = await projectActivityAction(SOCCER({ startsAt: '2026-10-15T16:30:00Z' }));
    expect(JSON.stringify(forLeo)).not.toContain('Hockey');
    expect(JSON.stringify(forEmma)).toContain('Gymnastics');
    expect(sims()).toEqual([]);
  });
});

describe('ACTION-13D081167F71 saveSimulationAction', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('ACTION-13D081167F71 the %s saves the server\'s projection into A under their own name', async (role) => {
    as(role);
    expect(await saveSimulationAction(SOCCER())).toEqual({ ok: true });
    expect(sims()).toHaveLength(1);
    expect(sims()[0]).toMatchObject({
      family_id: FAMILY_A, member_id: 'member-child', activity_name: 'Travel soccer', created_by: `user-${role}`,
    });
    expect((sims()[0].input as { memberName: string }).memberName).toBe('Emma');
    expect(harness.revalidated).toEqual(['/dashboard/family-digital-twin']);
  });

  it('ACTION-13D081167F71 a child on a kid login saves like any child', async () => {
    as('child', `kid-1@${CHILD_LOGIN_EMAIL_DOMAIN}`);
    expect(await saveSimulationAction(SOCCER())).toEqual({ ok: true });
    expect(sims()[0]).toMatchObject({ family_id: FAMILY_A, created_by: 'user-child' });
  });

  it('ACTION-13D081167F71 a guest is refused and nothing is kept', async () => {
    as('guest');
    expect(await saveSimulationAction(SOCCER())).toEqual({ ok: false, error: GUEST_VIEWS_ONLY });
    expect(sims()).toEqual([]);
    expect(harness.revalidated).toEqual([]);
  });

  it('ACTION-13D081167F71 a member of household B is refused, and neither household gains a row', async () => {
    seedSim('sim-b', FAMILY_B, 'user-leo');
    const b = simsOf(FAMILY_B);
    expect(await saveSimulationAction(SOCCER({ memberId: 'member-leo', memberName: 'Leo' }))).toEqual({ ok: false, error: NOT_A_MEMBER });
    expect(simsOf(FAMILY_A)).toEqual([]);
    expect(simsOf(FAMILY_B)).toEqual(b);
  });

  it('ACTION-13D081167F71 a refused insert is reported, not answered with ok', async () => {
    const real = vi.mocked(db.from).getMockImplementation()!;
    vi.mocked(db.from).mockImplementation((table: string) => {
      const builder = real(table);
      if (table !== 'twin_simulations') return builder;
      return Object.assign(builder, {
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }) }) }),
      });
    });
    const res = await saveSimulationAction(SOCCER());
    expect(res.ok).toBe(false);
    expect(sims()).toEqual([]);
    expect(harness.revalidated).toEqual([]);
  });
});

describe('ACTION-9C8E227CD5FB deleteSimulationAction', () => {
  beforeEach(() => {
    seedSim('sim-parent', FAMILY_A, 'user-parent');
    for (const role of ['adult', 'teen', 'child', 'caregiver']) seedSim(`sim-${role}`, FAMILY_A, `user-${role}`);
    seedSim('sim-b', FAMILY_B, 'user-leo');
  });
  const ids = () => sims().map((s) => s.id).sort();

  it.each(['parent', 'adult'])('ACTION-9C8E227CD5FB the %s deletes a scenario someone else saved in A', async (role) => {
    as(role);
    const target = role === 'parent' ? 'sim-child' : 'sim-parent';
    expect(await deleteSimulationAction(target)).toEqual({ ok: true });
    expect(ids()).not.toContain(target);
    expect(ids()).toHaveLength(5);
    expect(harness.revalidated).toEqual(['/dashboard/family-digital-twin']);
  });

  it.each(['teen', 'child', 'caregiver'])('ACTION-9C8E227CD5FB the %s deletes their own scenario but not a parent\'s', async (role) => {
    as(role);
    expect(await deleteSimulationAction('sim-parent')).toEqual({ ok: false, error: COULD_NOT_DELETE });
    expect(ids()).toContain('sim-parent');
    expect(await deleteSimulationAction(`sim-${role}`)).toEqual({ ok: true });
    expect(ids()).not.toContain(`sim-${role}`);
    expect(ids()).toHaveLength(5);
  });

  it('ACTION-9C8E227CD5FB a guest deletes nothing, not even a scenario under their own id', async () => {
    seedSim('sim-guest', FAMILY_A, 'user-guest');
    as('guest');
    expect(await deleteSimulationAction('sim-guest')).toEqual({ ok: false, error: GUEST_VIEWS_ONLY });
    expect(await deleteSimulationAction('sim-parent')).toEqual({ ok: false, error: GUEST_VIEWS_ONLY });
    expect(ids()).toHaveLength(7);
    expect(harness.revalidated).toEqual([]);
  });

  it.each(['parent', 'adult'])('ACTION-9C8E227CD5FB the %s of A cannot delete household B\'s scenario', async (role) => {
    as(role);
    const b = simsOf(FAMILY_B);
    const a = simsOf(FAMILY_A);
    expect(await deleteSimulationAction('sim-b')).toEqual({ ok: false, error: COULD_NOT_DELETE });
    expect(simsOf(FAMILY_B)).toEqual(b);
    expect(simsOf(FAMILY_A)).toEqual(a);
  });
});
