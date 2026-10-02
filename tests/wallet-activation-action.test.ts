import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * activateFamilyWalletAction (app/(app)/wallet/actions.ts), run as code.
 * No test named it: `a-refused-write-is-not-a-success.test.ts` lists
 * `family_wallets` among tables whose writes are checked in source text, and
 * nothing ran the action. This drives it against the in-memory store, with the
 * four unique keys its upserts rely on declared as the schema declares them,
 * through the real `logWalletAudit`, `describeActionError` and message
 * catalogue, and asserts what it provisions, keeps, refuses and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-61EE5A6DD0D6 (activateFamilyWalletAction).
 *
 * Mocked: the session and `next/cache`. The clock is pinned. Row-level
 * security (0322 makes compliance_disclosures manager-written) and database
 * defaults beyond ids and timestamps are not exercised.
 */

const FAMILY = 'family-1';
const NOW = '2026-09-28T12:00:00.000Z';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
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
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY }, family: { id: FAMILY, timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { activateFamilyWalletAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const KINDS = ['spend', 'save', 'give', 'invest'];
const LABELS = ['Spend', 'Save', 'Give', 'Invest'];

let db: InMemorySupabase;

function freshStore() {
  return createInMemorySupabase({
    uniques: {
      family_wallets: [['family_id']],
      child_wallets: [['family_id', 'member_id']],
      wallet_buckets: [['child_wallet_id', 'kind']],
      wallet_rules: [['family_id', 'child_wallet_id']],
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = freshStore();
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  // Two managers, two active children of different ages, one child who has
  // left, and another family's child. Caregivers and guests are left out on
  // purpose: whether they get a wallet is reported, not asserted.
  db.seed('family_members', [
    { id: 'member-self', family_id: FAMILY, role: 'parent', is_active: true },
    { id: 'member-adult', family_id: FAMILY, role: 'adult', is_active: true },
    { id: 'member-teen', family_id: FAMILY, role: 'teen', is_active: true },
    { id: 'member-child', family_id: FAMILY, role: 'child', is_active: true },
    { id: 'member-gone', family_id: FAMILY, role: 'child', is_active: false },
    { id: 'member-x', family_id: 'family-2', role: 'child', is_active: true },
  ]);
});

afterEach(() => { vi.useRealTimers(); });

const table = (name: string) => db.table(name);
const walletOf = (memberId: string) => table('child_wallets').find((row) => row.member_id === memberId) as Row | undefined;
const bucketsOf = (walletId: unknown) => table('wallet_buckets').filter((row) => row.child_wallet_id === walletId);

/** Replace one table's builder method so its call answers `reply`. */
function override(name: string, method: 'upsert' | 'insert' | 'single' | 'then', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (n: string) => unknown }).from = (n: string) => {
    const builder = from(n) as unknown as Record<string, unknown>;
    if (n !== name) return builder;
    const answer = { data: null, error: null, count: null, status: 200, statusText: 'OK', ...reply };
    if (method === 'then') {
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
    } else if (method === 'single') {
      builder.single = async () => answer;
    } else {
      builder[method] = () => {
        const settled: Record<string, unknown> = {
          select: () => settled,
          single: async () => answer,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve),
        };
        return settled;
      };
    }
    return builder;
  };
}

describe('activateFamilyWalletAction (ACTION-61EE5A6DD0D6)', () => {
  describe('a first activation', () => {
    it('opens the family wallet in ledger mode, with the parent’s acceptance, once', async () => {
      expect(await activateFamilyWalletAction()).toEqual({ ok: true });

      expect(table('family_wallets')).toEqual([expect.objectContaining({
        family_id: FAMILY, mode: 'ledger', is_active: true,
        disclosures_accepted_at: NOW, disclosures_accepted_by: 'user-self', created_by: 'user-self',
      })]);
    });

    it('records the terms the parent accepted, by version', async () => {
      await activateFamilyWalletAction();

      expect(table('compliance_disclosures')).toEqual([expect.objectContaining({
        family_id: FAMILY, kind: 'wallet_terms', version: '2026-06-25', accepted_by: 'user-self',
      })]);
    });

    it('gives every active child and teen a wallet, four buckets in order and a default rule', async () => {
      await activateFamilyWalletAction();

      for (const member of ['member-teen', 'member-child']) {
        const wallet = walletOf(member);
        expect(wallet).toMatchObject({ family_id: FAMILY, member_id: member, is_active: true, created_by: 'user-self' });
        const buckets = bucketsOf(wallet!.id).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
        expect(buckets.map((b) => [b.kind, b.label, b.sort_order, b.family_id])).toEqual(
          KINDS.map((kind, i) => [kind, LABELS[i], i, FAMILY]),
        );
        expect(table('wallet_rules').filter((r) => r.child_wallet_id === wallet!.id)).toEqual([
          expect.objectContaining({ family_id: FAMILY, child_wallet_id: wallet!.id, created_by: 'user-self' }),
        ]);
      }
      expect(table('child_wallets')).toHaveLength(2);
      expect(table('wallet_buckets')).toHaveLength(8);
      expect(table('wallet_rules')).toHaveLength(2);
    });

    it('gives no wallet to a parent, an adult, a child who has left, or another family’s child', async () => {
      await activateFamilyWalletAction();

      for (const member of ['member-self', 'member-adult', 'member-gone', 'member-x']) {
        expect(walletOf(member)).toBeUndefined();
      }
      expect(table('child_wallets').every((row) => row.family_id === FAMILY)).toBe(true);
    });

    it('logs the activation against the family wallet and refreshes /wallet once', async () => {
      await activateFamilyWalletAction();

      const wallet = table('family_wallets')[0];
      expect(table('wallet_audit_logs')).toEqual([expect.objectContaining({
        family_id: FAMILY, actor_user_id: 'user-self', action: 'wallet_activated',
        entity_type: 'family_wallets', entity_id: wallet.id,
      })]);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    });

    it('a family with no children still activates, with nothing to provision', async () => {
      db.replace('family_members', table('family_members').filter((row) => ['parent', 'adult'].includes(String(row.role))));

      expect(await activateFamilyWalletAction()).toEqual({ ok: true });
      expect(table('family_wallets')).toHaveLength(1);
      expect(table('child_wallets')).toHaveLength(0);
      expect(table('wallet_audit_logs')).toHaveLength(1);
    });

    it('an adult may activate too', async () => {
      harness.role = 'adult';
      expect(await activateFamilyWalletAction()).toEqual({ ok: true });
      expect(table('family_wallets')).toHaveLength(1);
    });
  });

  describe('activating again', () => {
    it('keeps one family wallet, and each child’s wallet, buckets and rule, by id', async () => {
      await activateFamilyWalletAction();
      const ids = (name: string) => table(name).map((row) => row.id).sort();
      const before = Object.fromEntries(['family_wallets', 'child_wallets', 'wallet_buckets', 'wallet_rules'].map((n) => [n, ids(n)]));

      expect(await activateFamilyWalletAction()).toEqual({ ok: true });

      for (const [name, was] of Object.entries(before)) expect(ids(name)).toEqual(was);
    });

    it('does not reset a split the parent has since chosen', async () => {
      await activateFamilyWalletAction();
      const rule = table('wallet_rules').find((r) => r.child_wallet_id === walletOf('member-child')!.id)!;
      Object.assign(rule, { split: { spend: 100, save: 0, give: 0, invest: 0 }, require_approval_over_cents: 0, auto_accept_gifts: true });

      await activateFamilyWalletAction();

      expect(rule).toMatchObject({ split: { spend: 100, save: 0, give: 0, invest: 0 }, require_approval_over_cents: 0, auto_accept_gifts: true });
    });

    it('provisions a child who joined since, and leaves the others as they were', async () => {
      await activateFamilyWalletAction();
      const teenWallet = structuredClone(walletOf('member-teen'));
      db.seed('family_members', [{ id: 'member-new', family_id: FAMILY, role: 'child', is_active: true }]);

      await activateFamilyWalletAction();

      expect(bucketsOf(walletOf('member-new')!.id)).toHaveLength(4);
      expect(walletOf('member-teen')!.id).toBe(teenWallet!.id);
      expect(table('child_wallets')).toHaveLength(3);
    });

    it('records the acceptance again, as a new row', async () => {
      await activateFamilyWalletAction();
      await activateFamilyWalletAction();
      expect(table('compliance_disclosures')).toHaveLength(2);
    });
  });

  describe('refusals', () => {
    it.each(NON_MANAGERS)('a %s is refused before anything is read or written', async (role) => {
      harness.role = role;

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan') });
      expect(db.log).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('failures stop the activation where they happen, in words', () => {
    const expectStopped = () => {
      expect(table('wallet_audit_logs')).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    };

    it('the family wallet cannot be opened: nothing else is written', async () => {
      override('family_wallets', 'upsert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotActivateTheFamily')) });
      expect(table('compliance_disclosures')).toHaveLength(0);
      expect(table('child_wallets')).toHaveLength(0);
      expectStopped();
    });

    it('the acceptance cannot be recorded: no child is provisioned', async () => {
      override('compliance_disclosures', 'insert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotRecordTheWallet')) });
      expect(table('child_wallets')).toHaveLength(0);
      expectStopped();
    });

    it('the family’s members cannot be read: no child is provisioned', async () => {
      override('family_members', 'then', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadFamilyMembers')) });
      expect(table('child_wallets')).toHaveLength(0);
      expectStopped();
    });

    it('a child wallet cannot be created', async () => {
      override('child_wallets', 'upsert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('wallet.couldNotProvisionAChild')) });
      expect(table('wallet_buckets')).toHaveLength(0);
      expectStopped();
    });

    it('a child wallet write that returns no row is a failure, and says nothing of the database', async () => {
      override('child_wallets', 'upsert', { data: null, error: null });

      expect(await activateFamilyWalletAction()).toEqual({
        ok: false,
        error: describeActionError(new Error(t('actions.childWalletSetupReturnedNo')), t('wallet.couldNotProvisionAChild')),
      });
      expect(table('wallet_buckets')).toHaveLength(0);
      expectStopped();
    });

    it('a child’s buckets cannot be created: no rule is written for it', async () => {
      override('wallet_buckets', 'upsert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotProvisionWalletBuckets')) });
      expect(table('wallet_rules')).toHaveLength(0);
      expectStopped();
    });

    it('a child’s rule cannot be created', async () => {
      override('wallet_rules', 'upsert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotProvisionWalletRules')) });
      expectStopped();
    });

    it('a lost audit row does not undo or hide the activation', async () => {
      override('wallet_audit_logs', 'insert', { error: PG_ERROR, status: 500 });

      expect(await activateFamilyWalletAction()).toEqual({ ok: true });
      expect(table('family_wallets')).toHaveLength(1);
      expect(table('child_wallets')).toHaveLength(2);
      expect(console.error).toHaveBeenCalledWith('[wallet-audit] wallet activation was not recorded', PG_ERROR);
    });
  });
});
