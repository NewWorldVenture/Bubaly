// M2 — a child has one allowance rule, and the page shows every rule there is.
//
// The allowance page renders a row for a child with no rule yet as "Set", and
// that row sends no rule id. Two parents (or two tabs) setting the same child's
// first allowance, or a second "Set" from a page rendered before the first
// save, each INSERTED a rule: allowance_rules has no unique key per wallet.
// The cron and "Run due now" pay every active due rule, so the child was paid
// by both every period, while the page kept one rule per wallet in a Map and
// showed, counted and paused only that one. Pausing it left the other paying.
//
// The action and the page are driven for real against an in-memory database.
// (A unique index on allowance_rules(family_id, child_wallet_id) is the
// database's half, and the owner's: a migration once duplicates are merged.)
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-parent' }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    useLocale: () => ({ code: 'en-US' }),
    useFamilyTimeZone: () => 'UTC',
  };
});
vi.mock('@/components/wallet/wallet-subnav', () => ({ WalletSubnav: () => null }));

const { saveAllowanceRuleAction } = await import('@/app/(app)/wallet/actions');
const { default: WalletAllowancePage } = await import('@/app/(app)/wallet/allowance/page');
const { AllowanceView } = await import('@/components/wallet/allowance-view');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const AVA_WALLET = 'wallet-ava';
let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('family_members', [{ id: 'member-ava', family_id: FAMILY, display_name: 'Ava', role: 'child', is_active: true }]);
  db.seed('child_wallets', [{ id: AVA_WALLET, family_id: FAMILY, member_id: 'member-ava', is_active: true }]);
});

const rules = () => db.table('allowance_rules').filter((r) => r.child_wallet_id === AVA_WALLET);

/** The AllowanceView element the page renders. */
function viewOf(node: ReactNode): ReactElement<{ rows: { ruleId: string | null; amountCents: number; isActive: boolean; duplicate?: boolean }[] }> {
  if (Array.isArray(node)) {
    for (const child of node) { const hit = viewOf(child); if (hit) return hit; }
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null as never;
  if (node.type === AllowanceView) return node as never;
  return viewOf(node.props.children);
}

describe('a child has one allowance rule', () => {
  it('the first "Set" creates it', async () => {
    const res = await saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' });
    expect(res).toEqual({ ok: true });
    expect(rules()).toHaveLength(1);
  });

  it('a second "Set" from a view rendered before the first save is refused, and the child keeps one rule', async () => {
    // The other parent set Ava's allowance a minute ago.
    await saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' });
    // This parent's page still shows Ava with no allowance, so it sends no id.
    const res = await saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1200, cadence: 'weekly' });

    expect(res).toEqual({ ok: false, error: t('actions.thisChildAlreadyHasAnAllowance') });
    expect(rules()).toHaveLength(1);
    expect(rules()[0].amount_cents).toBe(1000);
  });

  it('an edit of the rule that is there still saves', async () => {
    await saveAllowanceRuleAction({ childWalletId: AVA_WALLET, amountCents: 1000, cadence: 'weekly' });
    const res = await saveAllowanceRuleAction({ id: String(rules()[0].id), childWalletId: AVA_WALLET, amountCents: 1200, cadence: 'weekly' });
    expect(res).toEqual({ ok: true });
    expect(rules()).toHaveLength(1);
    expect(rules()[0].amount_cents).toBe(1200);
  });
});

describe('the allowance page shows every rule a child has', () => {
  beforeEach(() => {
    // Two rules saved for Ava before the action refused a second: both active,
    // both paid by the cron every week.
    db.seed('allowance_rules', [
      { id: 'rule-10', family_id: FAMILY, child_wallet_id: AVA_WALLET, amount_cents: 1000, cadence: 'weekly', is_active: true, next_run_on: '2026-10-18' },
      { id: 'rule-12', family_id: FAMILY, child_wallet_id: AVA_WALLET, amount_cents: 1200, cadence: 'weekly', is_active: true, next_run_on: '2026-10-18' },
    ]);
  });

  it('lists both, each with its own pause, and says the child has more than one', async () => {
    const page = await WalletAllowancePage();
    const view = viewOf(page);
    expect(view.props.rows.map((r) => [r.ruleId, r.amountCents, r.isActive, r.duplicate])).toEqual([
      ['rule-10', 1000, true, true],
      ['rule-12', 1200, true, true],
    ]);

    const html = renderToStaticMarkup(createElement(AllowanceView, view.props as never));
    expect(html.match(new RegExp(`aria-label="${t('uiText.pause')}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('$10 · weekly');
    expect(html).toContain('$12 · weekly');
    expect(html).toContain(t('allowanceView.oneOfSeveralAllowances'));
  });

  it('a child with one rule, and a child with none, still read as before', async () => {
    db.replace('allowance_rules', db.table('allowance_rules').filter((r) => r.id === 'rule-10'));
    db.seed('family_members', [{ id: 'member-ben', family_id: FAMILY, display_name: 'Ben', role: 'child', is_active: true }]);
    db.seed('child_wallets', [{ id: 'wallet-ben', family_id: FAMILY, member_id: 'member-ben', is_active: true }]);

    const view = viewOf(await WalletAllowancePage());
    expect(view.props.rows.map((r) => [r.ruleId, r.duplicate])).toEqual([['rule-10', false], [null, false]]);
  });
});
