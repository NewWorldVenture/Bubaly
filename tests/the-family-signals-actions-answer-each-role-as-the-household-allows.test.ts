// Call-level role tests for Family Intelligence's two writes
// (app/(app)/dashboard/family-signals/actions.ts):
//   refreshSignalsAction    ACTION-37CED65E2E35
//   setSignalStatusAction   ACTION-8522485B70B0
//
// THE POLICY, from the sources:
//  - family_signals' live RLS is 01420's: select/insert/update/delete for any
//    `is_family_member(family_id)` (supabase/migrations/01420_family_signals.sql:44-58).
//    No later migration narrows it and 0464's guest trigger does not list it.
//  - The actions' own comments: "Anyone may Refresh, on their own client. Only
//    a parent's or an adult's scan reads the household" (actions.ts:22-24), and a
//    budget-drift decision is "a parent's or an adult's to make: anyone else's
//    write matches no budget-drift row" (actions.ts:42-46).
//  - readsHouseholdMoney = isManager (lib/finance/household-money.ts:17), and
//    the page hides budget drift from everyone else (family-signals/page.tsx:63).
//  - /dashboard/family-signals is not on a guest's withheld list
//    (lib/auth/guest-scope.ts) and navigation offers it at minLevel 0.
//
// So: every role may Refresh, but only a parent's or adult's Refresh reads the
// household's budgets, writes budget drift and retires stale rows; every role
// may acknowledge or dismiss a non-money signal; only a parent or adult may
// decide a budget-drift signal; and a signal of another family is never written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), db: null as unknown, revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate: tr } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(getMessages('en-US'), key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') }),
  };
});

const { refreshSignalsAction, setSignalStatusAction } = await import('@/app/(app)/dashboard/family-signals/actions');

const COULD_NOT_UPDATE = translate(SOURCE_MESSAGES, 'actions.couldNotUpdateThatSignal');

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const NOW = new Date('2026-10-15T12:00:00.000Z');
/** The drift this month's overspend produces: keyed on the category and the period's first day. */
const DRIFT_KEY = 'budget:groceries:2026-10-01';
const FRICTION_KEY = 'chore_conflict:chore-a';

type Caller = { role: string; email: string };
const PARENT: Caller = { role: 'parent', email: 'parent@example.com' };
const ADULT: Caller = { role: 'adult', email: 'adult@example.com' };
const TEEN: Caller = { role: 'teen', email: 'teen@example.com' };
const CHILD: Caller = { role: 'child', email: 'child@example.com' };
const KID_LOGIN: Caller = { role: 'child', email: `child.sam@${CHILD_LOGIN_EMAIL_DOMAIN}` };
const CAREGIVER: Caller = { role: 'caregiver', email: 'caregiver@example.com' };
const GUEST: Caller = { role: 'guest', email: 'guest@example.com' };
const MANAGERS = [PARENT, ADULT];
const NON_MANAGERS = [TEEN, CHILD, KID_LOGIN, CAREGIVER, GUEST];
const EVERYONE = [...MANAGERS, ...NON_MANAGERS];
const label = (c: Caller) => (c === KID_LOGIN ? 'kid login' : c.role);
const cases = (callers: Caller[]) => callers.map((c) => [label(c), c] as const);

let db: InMemorySupabase;

function signedInAs(caller: Caller) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${caller.role}`, email: caller.email },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role: caller.role, member: { id: `member-${caller.role}` } },
  });
}

const signal = (id: string, family: string, kind: string, subjectKey: string) => ({
  id, family_id: family, kind, subject_key: subjectKey, status: 'active', score: 60,
  title: `${kind} ${id}`, detail: 'seeded', evidence: {}, member_id: null, last_seen_at: '2026-10-01T00:00:00Z',
});

function seed() {
  db.seed('family_signals', [
    signal('sig-a-drift', FAMILY_A, 'budget_drift', 'budget:dining:2026-10-01'),
    signal('sig-a-chore', FAMILY_A, 'chore_conflict', 'chore_conflict:chore-old'),
    signal('sig-b-drift', FAMILY_B, 'budget_drift', 'budget:travel:2026-10-01'),
    signal('sig-b-chore', FAMILY_B, 'chore_conflict', 'chore_conflict:chore-b'),
  ]);
  // Household A overspends its monthly grocery budget this month...
  db.seed('budgets', [
    { id: 'budget-a', family_id: FAMILY_A, category: 'Groceries', amount: 100, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
    { id: 'budget-b', family_id: FAMILY_B, category: 'Groceries', amount: 100, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('transactions', [
    { id: 'tx-a', family_id: FAMILY_A, type: 'expense', category: 'Groceries', amount: 300, date: '2026-10-10' },
    { id: 'tx-b', family_id: FAMILY_B, type: 'expense', category: 'Groceries', amount: 900, date: '2026-10-10' },
  ]);
  // ...and one chore is bounced between members — a non-money signal anyone's scan finds.
  db.seed('chores', [{ id: 'chore-a', family_id: FAMILY_A, title: 'Dishes' }]);
  db.seed('chore_assignments', [
    { id: 'ca-1', family_id: FAMILY_A, chore_id: 'chore-a', status: 'rejected', disputed: false, member_id: 'member-teen', created_at: '2026-10-05T00:00:00Z' },
    { id: 'ca-2', family_id: FAMILY_A, chore_id: 'chore-a', status: 'rejected', disputed: true, member_id: 'member-child', created_at: '2026-10-06T00:00:00Z' },
  ]);
}

const signalsOf = (family: string) => structuredClone(db.table('family_signals').filter((r) => r.family_id === family));
const findA = (kind: string, subjectKey: string) =>
  db.table('family_signals').find((r) => r.family_id === FAMILY_A && r.kind === kind && r.subject_key === subjectKey);
const statusOf = (id: string) => db.table('family_signals').find((r) => r.id === id)?.status;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { family_signals: [['family_id', 'kind', 'subject_key']] },
    defaults: { family_signals: { status: 'active' } },
  });
  mocks.db = db;
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('refreshSignalsAction: anyone refreshes, only a manager\'s scan reads the household', () => {
  it.each(cases(MANAGERS))('ACTION-37CED65E2E35 a %s\'s Refresh writes the drift, retires the stale row, and leaves household B alone', async (_n, caller) => {
    signedInAs(caller);
    const b = signalsOf(FAMILY_B);

    const result = await refreshSignalsAction();

    expect(result).toEqual({ ok: true, data: { signals: 2 } });
    expect(findA('budget_drift', DRIFT_KEY), 'this month\'s overspend is written').toMatchObject({ status: 'active' });
    expect(findA('chore_conflict', FRICTION_KEY), 'the chore friction is written').toMatchObject({ status: 'active' });
    expect(statusOf('sig-a-chore'), 'a pattern the scan no longer sees is retired').toBeUndefined();
    expect(statusOf('sig-a-drift'), 'and so is last period\'s drift').toBeUndefined();
    expect(signalsOf(FAMILY_B)).toEqual(b);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/family-signals');
  });

  it.each(cases(NON_MANAGERS))('ACTION-37CED65E2E35 a %s\'s Refresh writes only what their reach sees: no drift, nothing retired, household B alone', async (_n, caller) => {
    signedInAs(caller);
    const b = signalsOf(FAMILY_B);
    const seededA = signalsOf(FAMILY_A);

    const result = await refreshSignalsAction();

    expect(result).toEqual({ ok: true, data: { signals: 1 } });
    expect(findA('chore_conflict', FRICTION_KEY), 'the chore friction is written').toMatchObject({ status: 'active' });
    expect(findA('budget_drift', DRIFT_KEY), 'no budget drift from a scan that does not read the money').toBeUndefined();
    expect(signalsOf(FAMILY_A).filter((r) => r.subject_key !== FRICTION_KEY), 'nothing it could not see is retired or rewritten').toEqual(seededA);
    expect(signalsOf(FAMILY_B)).toEqual(b);
  });
});

describe('setSignalStatusAction: a non-money signal is anyone\'s to decide, budget drift a manager\'s', () => {
  it.each(cases(EVERYONE))('ACTION-8522485B70B0 a %s dismisses household A\'s chore signal, and only that row changes', async (_n, caller) => {
    signedInAs(caller);
    const b = signalsOf(FAMILY_B);
    await expect(setSignalStatusAction('sig-a-chore', 'dismissed')).resolves.toEqual({ ok: true });
    expect(statusOf('sig-a-chore')).toBe('dismissed');
    expect(statusOf('sig-a-drift')).toBe('active');
    expect(signalsOf(FAMILY_B)).toEqual(b);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/family-signals');
  });

  it.each(cases(MANAGERS))('ACTION-8522485B70B0 a %s acknowledges household A\'s budget drift', async (_n, caller) => {
    signedInAs(caller);
    await expect(setSignalStatusAction('sig-a-drift', 'acknowledged')).resolves.toEqual({ ok: true });
    expect(statusOf('sig-a-drift')).toBe('acknowledged');
  });

  it.each(cases(NON_MANAGERS))('ACTION-8522485B70B0 a %s cannot decide household A\'s budget drift, and nothing is written', async (_n, caller) => {
    signedInAs(caller);
    const before = structuredClone(db.table('family_signals'));
    await expect(setSignalStatusAction('sig-a-drift', 'dismissed')).resolves.toEqual({ ok: false, error: COULD_NOT_UPDATE });
    expect(db.table('family_signals')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(cases(EVERYONE))('ACTION-8522485B70B0 a %s naming household B\'s signal is refused, and neither household changes', async (_n, caller) => {
    signedInAs(caller);
    const before = structuredClone(db.table('family_signals'));
    await expect(setSignalStatusAction('sig-b-chore', 'dismissed')).resolves.toEqual({ ok: false, error: COULD_NOT_UPDATE });
    expect(db.table('family_signals')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-8522485B70B0 a signed-out caller is sent to sign in and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
    const before = structuredClone(db.table('family_signals'));
    await expect(setSignalStatusAction('sig-a-chore', 'dismissed')).rejects.toThrow('NEXT_REDIRECT');
    await expect(refreshSignalsAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(db.table('family_signals')).toEqual(before);
  });
});
