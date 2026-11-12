// "Can we afford it?" (assessAffordabilityAction), called the way the Family CFO
// form calls it, for every role of household A, with household B beside it.
//
// The policy the action is held to, from the sources rather than from the action:
//   - lib/finance/household-money.ts readsHouseholdMoney: the household's
//     accounts and balances are a parent's or adult's (isManager,
//     lib/constants/roles.ts). A teen, child, caregiver and guest are refused.
//   - lib/auth/guest-scope.ts withholds /dashboard/family-cfo from a guest.
//   - lib/constants/feature-catalog.ts lists /dashboard/family-cfo at 'plus',
//     resolved by lib/server/feature-entitlement.ts: a Free or Basic family is
//     refused.
//   - require-aal2: a parent with an authenticator on a password-only session
//     is sent for the code.
//
// The action writes nothing (its own header). So every case asserts the answer
// AND that nothing was written, and a refusal asserts the money tables were not
// even read. The forecast is the REAL loader (lib/finance/timeline-load.ts)
// over an in-memory database holding both households, so "whose money" is
// answered by the rows, not by a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent' as string,
  email: 'parent@example.com' as string | null,
  plan: 'plus',
  aal: { currentLevel: 'aal2', nextLevel: 'aal2' } as { currentLevel: string; nextLevel: string },
  signedOut: false,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { translate } = await import('@/lib/i18n/translate');
  const messages = JSON.parse(read('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (harness.signedOut) throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' });
    return {
      user: { id: `user-${harness.role}`, email: harness.email },
      memberships: [],
      active: { familyId: FAMILY_A, role: harness.role, member: { id: `member-${harness.role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
    };
  },
}));
vi.mock('@/lib/supabase/server', async () => {
  const { entitledServiceClient } = await import('./helpers/entitled-service-client');
  return {
    createServer: async () => {
      const db = harness.db as InMemorySupabase;
      return {
        from: (table: string) => db.from(table),
        auth: {
          getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }),
          mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: harness.aal, error: null }) },
        },
      };
    },
    // The plan is read through the service client (lib/server/plan.ts).
    createServiceClient: () => entitledServiceClient(harness.plan),
  };
});

const { assessAffordabilityAction } = await import('@/app/(app)/dashboard/family-cfo/actions');

const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const KEPT_BY_PARENTS = en['householdMoney.keptByParents'];
const NEEDS_PLUS = en['familyCfoActions.needsFamilyPlus'];
const NEEDS_CODE = en['familyCfoActions.needsYourCode'];

/** A $900 one-off a week out. */
const ASK = { label: 'New fridge', amountDollars: 900, date: '2026-10-20', recurrence: 'once' as const };

/** The money tables the forecast reads. A refusal must reach none of them. */
const MONEY_TABLES = ['financial_accounts', 'bills', 'savings_goals', 'subscriptions_tracked'];

let db: InMemorySupabase;
let read: string[];

function as(role: string, email: string | null = `${role}@example.com`) {
  harness.role = role;
  harness.email = email;
}

/** Every row in every table this test seeded, to show nothing was written. */
const snapshot = () => structuredClone(['financial_accounts', 'bills', 'savings_goals', 'calendar_events', 'app_settings']
  .map((t) => [t, db.table(t)]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.plan = 'plus';
  harness.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
  harness.signedOut = false;
  as('parent');
  db = createInMemorySupabase();
  harness.db = db;
  read = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table: string) => { read.push(table); return from(table); });
  // A: $2,000 in checking. B: a fortune, so a forecast that read B's rows
  // would say any purchase is fine and its numbers would show it.
  db.seed('financial_accounts', [
    { id: 'acct-a', family_id: FAMILY_A, balance: 2000, type: 'checking' },
    { id: 'acct-b', family_id: FAMILY_B, balance: 1_000_000, type: 'checking' },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ACTION-9799EDE8D029 assessAffordabilityAction: managers of A get A\'s answer', () => {
  it.each(['parent', 'adult'])('ACTION-9799EDE8D029 a manager (%s) of a Family+ household gets the verdict from A\'s own balance, and nothing is written', async (role) => {
    as(role);
    const before = snapshot();
    const res = await assessAffordabilityAction(ASK);
    expect(res.ok).toBe(true);
    const result = res.ok ? res.result : null;
    // $2,000 is A's balance; B's $1,000,000 is not in it.
    expect(result?.before.lowestBalance).toBe(2000);
    expect(result?.after.lowestBalance).toBe(1100);
    expect(result?.scenario).toEqual({ label: 'New fridge', date: '2026-10-20', total: 900, occurrences: 1, recurring: false });
    expect(snapshot()).toEqual(before);
    expect(read).toContain('financial_accounts');
  });
});

describe('ACTION-9799EDE8D029 assessAffordabilityAction: everyone else is told whose money it is', () => {
  it.each([
    ['teen', 'teen@example.com'],
    ['child', 'child@example.com'],
    ['child', `kid-1@${CHILD_LOGIN_EMAIL_DOMAIN}`],
    ['caregiver', 'caregiver@example.com'],
    ['guest', 'guest@example.com'],
  ])('ACTION-9799EDE8D029 a %s (%s) is refused before any money table is read', async (role, email) => {
    as(role, email);
    const before = snapshot();
    expect(await assessAffordabilityAction(ASK)).toEqual({ ok: false, error: KEPT_BY_PARENTS });
    for (const table of MONEY_TABLES) expect(read, table).not.toContain(table);
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-9799EDE8D029 a signed-out caller is sent to sign in and nothing is read', async () => {
    harness.signedOut = true;
    await expect(assessAffordabilityAction(ASK)).rejects.toMatchObject({ digest: expect.stringContaining('/login') });
    expect(read).toEqual([]);
  });
});

describe('ACTION-9799EDE8D029 assessAffordabilityAction: the plan and the code', () => {
  it.each(['free', 'basic'])('ACTION-9799EDE8D029 a parent of a %s household is refused the Family+ what-if, and the forecast is not read', async (plan) => {
    harness.plan = plan;
    expect(await assessAffordabilityAction(ASK)).toEqual({ ok: false, error: NEEDS_PLUS });
    for (const table of MONEY_TABLES) expect(read, table).not.toContain(table);
  });

  it('ACTION-9799EDE8D029 a parent with an authenticator on a password-only session is sent for the code', async () => {
    harness.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    expect(await assessAffordabilityAction(ASK)).toEqual({
      ok: false, error: NEEDS_CODE, stepUp: `/auth/step-up?next=${encodeURIComponent('/dashboard/family-cfo')}`,
    });
    for (const table of MONEY_TABLES) expect(read, table).not.toContain(table);
  });
});

describe('ACTION-9799EDE8D029 assessAffordabilityAction: the other household', () => {
  it('ACTION-9799EDE8D029 household B\'s money never reaches A\'s answer, and neither household changes', async () => {
    // The action takes no id: the family is the session's. So the question is
    // whether B's rows leak into it. Drop A's account and the answer must be a
    // zero balance, not B's fortune.
    db.replace('financial_accounts', db.table('financial_accounts').filter((r) => r.family_id === FAMILY_B));
    const before = snapshot();
    const res = await assessAffordabilityAction(ASK);
    expect(res.ok).toBe(true);
    expect(res.ok ? res.result.before.lowestBalance : null).toBe(0);
    expect(res.ok ? res.result.verdict : null).toBe('breaches');
    expect(snapshot()).toEqual(before);
  });
});
