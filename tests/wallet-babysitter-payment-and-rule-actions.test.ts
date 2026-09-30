import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * recordBabysitterPaymentAction and saveWalletRuleAction
 * (app/(app)/wallet/actions.ts), run as code. Nothing ran either action; the
 * existing wallet tests read their source text. This drives both against the
 * in-memory store, with the real audit writer (`logWalletAudit`), the real
 * split normalisation and the real message catalogue, and asserts what each one
 * checks, writes and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-B0B83B2B1B5A (recordBabysitterPaymentAction), ACTION-34A3D968CD47
 * (saveWalletRuleAction).
 *
 * Mocked: the session, `next/cache` and the Trust Engine's `evaluateTrust`.
 * Row-level security on `babysitter_payments` and `wallet_rules`, and their
 * CHECK constraints (0088), are not exercised here.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } as Record<string, unknown>,
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
  evaluateTrust: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const { vi: v } = await import('vitest');
  harness.evaluateTrust = v.fn(async () => ({ decision: harness.decision }));
  return { ...(await importOriginal<typeof import('@/lib/trust/server')>()), evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args) };
});

const { recordBabysitterPaymentAction, saveWalletRuleAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const DENY_POLICY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy', details: null, hint: null };

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.decision = { effect: 'allow', reason: 'Allowed.', basis: 'role_default' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('babysitter_profiles', [
    { id: 'sitter-1', family_id: FAMILY, name: 'Ava', rate_cents: 2_000, is_active: true },
  ]);
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
  db.seed('wallet_rules', [
    { id: 'wrule-b', family_id: FAMILY, child_wallet_id: 'wallet-b', split: { spend: 40, save: 40, give: 10, invest: 10 }, auto_accept_gifts: false, require_approval_over_cents: 5_000, created_by: 'user-other' },
    { id: 'wrule-x', family_id: 'family-2', child_wallet_id: 'wallet-x', split: { spend: 100, save: 0, give: 0, invest: 0 }, auto_accept_gifts: true, require_approval_over_cents: 0, created_by: 'user-x' },
  ]);
});

/** Make one table's insert or upsert, or its maybeSingle read, answer `reply`. */
function override(table: string, method: 'insert' | 'upsert' | 'maybeSingle', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== table) return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) };
    if (method === 'insert' || method === 'upsert') builder[method] = () => settle;
    if (method === 'maybeSingle') builder.maybeSingle = async () => answer;
    return builder;
  };
}

const payments = () => db.table('babysitter_payments');
const audit = () => db.table('wallet_audit_logs');
const walletRules = () => db.table('wallet_rules');
const walletRule = (walletId: string) => walletRules().find((row) => row.child_wallet_id === walletId) as Row;
const snapshot = (name: string) => structuredClone(db.table(name));

const pay = (over: Partial<Parameters<typeof recordBabysitterPaymentAction>[0]> = {}) =>
  recordBabysitterPaymentAction({ babysitterId: 'sitter-1', hours: 4, rateCents: 2_000, tipCents: 500, amountCents: 8_500, ...over });
const saveRule = (over: Partial<Parameters<typeof saveWalletRuleAction>[0]> = {}) =>
  saveWalletRuleAction({ childWalletId: 'wallet-a', split: { spend: 30, save: 50, give: 10, invest: 10 }, autoAcceptGifts: true, requireApprovalOverCents: 2_500, ...over });

describe('recordBabysitterPaymentAction (ACTION-B0B83B2B1B5A)', () => {
  it('records one completed payment in the family, credited to the user, with an audit row, and refreshes the page', async () => {
    expect(await pay()).toEqual({ ok: true });

    expect(payments()).toHaveLength(1);
    expect(payments()[0]).toMatchObject({
      family_id: FAMILY, babysitter_id: 'sitter-1', event_id: null, hours: 4, rate_cents: 2_000,
      tip_cents: 500, amount_cents: 8_500, status: 'completed', created_by: 'user-self',
    });
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ family_id: FAMILY, actor_user_id: 'user-self', action: 'babysitter_paid', entity_type: 'babysitter_payments' });
    expect(String(audit()[0].detail)).toContain('85.00');
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/babysitters');
  });

  it('an adult may record one too', async () => {
    harness.role = 'adult';
    expect(await pay()).toEqual({ ok: true });
    expect(payments()).toHaveLength(1);
  });

  it('with only an amount, the hours and rate are empty and the tip is zero', async () => {
    expect(await recordBabysitterPaymentAction({ babysitterId: 'sitter-1', amountCents: 6_000 })).toEqual({ ok: true });
    expect(payments()[0]).toMatchObject({ hours: null, rate_cents: null, tip_cents: 0, event_id: null, amount_cents: 6_000 });
  });

  it('keeps the calendar event it was for', async () => {
    expect(await pay({ eventId: 'event-7' })).toEqual({ ok: true });
    expect(payments()[0].event_id).toBe('event-7');
  });

  it('the amount recorded is the amount given, not recomputed from hours and rate', async () => {
    expect(await pay({ hours: 4, rateCents: 2_000, tipCents: 0, amountCents: 7_000 })).toEqual({ ok: true });
    expect(payments()[0].amount_cents).toBe(7_000);
  });

  it('asks the Trust Engine as the member, about finances, for this amount, without opening its own approval', async () => {
    await pay();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'automate', context: { amountCents: 8_500 }, openApproval: false,
    });
  });

  it('a Trust denial records nothing', async () => {
    harness.decision = DENY_POLICY;

    expect(await pay()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY_POLICY as never) });
    expect(payments()).toHaveLength(0);
    expect(audit()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a Trust answer short of a denial does not stop it', async () => {
    harness.decision = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' };
    expect(await pay()).toEqual({ ok: true });
    expect(payments()).toHaveLength(1);
  });

  it.each(NON_MANAGERS)('refuses a %s before Trust or the database', async (role) => {
    harness.role = role;

    expect(await pay()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan13') });
    expect(db.log).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(payments()).toHaveLength(0);
  });

  it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s before Trust or the database', async (amountCents) => {
    expect(await pay({ amountCents })).toEqual({ ok: false, error: t('actions.enterAPaymentAmount') });
    expect(db.log).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('a refused insert is a failure in words, with no audit row and no refresh', async () => {
    override('babysitter_payments', 'insert', { error: RLS_DENIED });

    expect(await pay()).toEqual({ ok: false, error: describeActionError(RLS_DENIED, t('actions.couldNotRecordThatBabysitter')) });
    expect(audit()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a lost audit row does not undo or hide the payment: it is logged, and the payment stands', async () => {
    override('wallet_audit_logs', 'insert', { error: PG_ERROR });

    expect(await pay()).toEqual({ ok: true });
    expect(payments()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('babysitter payment was not recorded'), PG_ERROR);
  });
});

describe('saveWalletRuleAction (ACTION-34A3D968CD47)', () => {
  it('writes the child’s rule in the family, credited to the user, and refreshes the settings page', async () => {
    const others = snapshot('wallet_rules');

    expect(await saveRule()).toEqual({ ok: true });

    expect(walletRule('wallet-a')).toMatchObject({
      family_id: FAMILY, child_wallet_id: 'wallet-a', split: { spend: 30, save: 50, give: 10, invest: 10 },
      auto_accept_gifts: true, require_approval_over_cents: 2_500, created_by: 'user-self',
    });
    expect(walletRules().filter((row) => row.child_wallet_id !== 'wallet-a')).toEqual(others);
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/settings');
  });

  it('an adult may save one too', async () => {
    harness.role = 'adult';
    expect(await saveRule()).toEqual({ ok: true });
    expect(walletRule('wallet-a')).toBeDefined();
  });

  it('a child with a rule already keeps one rule, rewritten in place', async () => {
    expect(await saveRule({ childWalletId: 'wallet-b', split: { spend: 0, save: 100, give: 0, invest: 0 }, autoAcceptGifts: true, requireApprovalOverCents: 0 })).toEqual({ ok: true });

    const rows = walletRules().filter((row) => row.child_wallet_id === 'wallet-b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'wrule-b', family_id: FAMILY, split: { spend: 0, save: 100, give: 0, invest: 0 }, auto_accept_gifts: true, require_approval_over_cents: 0 });
    expect(walletRule('wallet-x')).toMatchObject({ family_id: 'family-2', split: { spend: 100, save: 0, give: 0, invest: 0 } });
  });

  it.each([
    ['0 and 100 at the edges', { spend: 0, save: 100, give: 0, invest: 0 }],
    ['fractions that add to 100', { spend: 33.3, save: 33.3, give: 33.4, invest: 0 }],
  ])('accepts a split with %s, stored as given', async (_label, split) => {
    expect(await saveRule({ split })).toEqual({ ok: true });
    expect(walletRule('wallet-a').split).toEqual(split);
  });

  it('a threshold of zero is kept as zero', async () => {
    expect(await saveRule({ requireApprovalOverCents: 0 })).toEqual({ ok: true });
    expect(walletRule('wallet-a').require_approval_over_cents).toBe(0);
  });

  describe('what it refuses before touching the database', () => {
    it.each(NON_MANAGERS)('a %s', async (role) => {
      harness.role = role;

      expect(await saveRule()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan14') });
      expect(db.log).toHaveLength(0);
    });

    it.each([
      ['adds to 99', { spend: 30, save: 50, give: 10, invest: 9 }, 'actions.splitPercentagesMustAddUp'],
      ['adds to 101', { spend: 30, save: 50, give: 10, invest: 11 }, 'actions.splitPercentagesMustAddUp'],
      ['has a gap', { spend: 30, save: 50, give: 10, invest: Number.NaN }, 'actions.splitPercentagesMustAddUp'],
      ['adds to 100 with a negative bucket', { spend: -10, save: 60, give: 25, invest: 25 }, 'actions.eachBucketMustBe0'],
      ['adds to 100 with a bucket over 100', { spend: 110, save: -10, give: 0, invest: 0 }, 'actions.eachBucketMustBe0'],
    ])('a split that %s', async (_label, split, key) => {
      expect(await saveRule({ split })).toEqual({ ok: false, error: t(key) });
      expect(db.log).toHaveLength(0);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('a threshold of %s', async (requireApprovalOverCents) => {
      expect(await saveRule({ requireApprovalOverCents })).toEqual({ ok: false, error: t('actions.approvalThresholdMustBeA') });
      expect(db.log).toHaveLength(0);
    });
  });

  it.each([
    ['another family’s child wallet', 'wallet-x'],
    ['a wallet that does not exist', 'wallet-missing'],
  ])('%s is not found, and no rule is written', async (_label, childWalletId) => {
    const before = snapshot('wallet_rules');

    expect(await saveRule({ childWalletId })).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(walletRules()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a wallet read failure is a failure in words, and no rule is written', async () => {
    override('child_wallets', 'maybeSingle', { error: PG_ERROR });
    const before = snapshot('wallet_rules');

    expect(await saveRule()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatChild')) });
    expect(walletRules()).toEqual(before);
  });

  it('a refused write is a failure in words, and refreshes nothing', async () => {
    override('wallet_rules', 'upsert', { error: RLS_DENIED });

    expect(await saveRule()).toEqual({ ok: false, error: describeActionError(RLS_DENIED, t('actions.couldNotSaveThatWallet2')) });
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
