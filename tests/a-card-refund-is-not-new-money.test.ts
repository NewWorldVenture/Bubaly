import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { moneyFlow } from '@/lib/wallet/flows';
import { weeksToGoal } from '@/lib/wallet/ledger';

/**
 * A card refund is a purchase undone, not new money (owner review 5976939812
 * on #925).
 *
 * #925 writes a refund as a `card_refund` CREDIT to Spend. Two readers counted
 * every completed credit as money coming in, so a refund now inflated them:
 *   - the treasury's "this month in", each child's "+$X this month" and the
 *     6-month trend (app/(app)/wallet/treasury/page.tsx);
 *   - the money coach's 8-week contribution rate, which forecasts how many
 *     weeks a goal is away (app/api/ai/wallet/route.ts).
 * A refund nets against out instead, so in − out is still the ledger's change.
 *
 * Both readers are driven for real against an in-memory store: the page's
 * props to TreasuryView, and the goal forecast the route hands to the prompt.
 */

const FAMILY = 'family-1';
const WALLET = 'wallet-a';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  promptInput: null as null | { goals: { weeksToGoal: number | null }[] },
}));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-parent' },
    active: { familyId: FAMILY, family: { id: FAMILY, name: 'Rivera', timezone: 'UTC' }, role: 'parent', member: { id: 'mem-parent' } },
  }),
  effectivePlanLevel: async () => 3,
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  };
});
vi.mock('@/components/wallet/treasury-view', () => ({ TreasuryView: function TreasuryView() { return null; } }));
// The coach route's gates and model call; the ledger arithmetic stays real.
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 3 }));
vi.mock('@/lib/wallet/tiers', async (importOriginal) => ({ ...(await importOriginal<object>()), walletTierForPlanLevel: () => 'plus' }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: async () => ({ text: 'ok', model: 'test', usage: {} }) }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: unknown) => unknown) => run({ used() {}, failed() {} }),
}));
vi.mock('@/lib/services/scope', async (importOriginal) => ({ ...(await importOriginal<object>()), scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/server/audit', () => ({ logWalletAudit: async () => {} }));
vi.mock('@/lib/wallet/coach', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildWalletCoachPrompt: (input: { goals: { weeksToGoal: number | null }[] }) => { harness.promptInput = input; return { system: 's', user: 'u' }; },
  parseWalletCoach: () => ({ headline: 'Keep going', insights: [] }),
}));

const { default: WalletTreasuryPage } = await import('@/app/(app)/wallet/treasury/page');
const { TreasuryView } = await import('@/components/wallet/treasury-view');
const { POST: coach } = await import('@/app/api/ai/wallet/route');

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.promptInput = null;
  db.seed('family_wallets', [{ id: 'fw-1', family_id: FAMILY, is_active: true }]);
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'mem-kid', is_active: true }]);
  db.seed('wallet_buckets', [
    { id: 'bucket-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' },
    { id: 'bucket-save', family_id: FAMILY, child_wallet_id: WALLET, kind: 'save' },
  ]);
  db.seed('family_members', [{ id: 'mem-kid', family_id: FAMILY, display_name: 'Ava', color: null }]);
  db.seed('wallet_rules', []);
  db.seed('wallet_audit_logs', []);
});

const now = () => new Date().toISOString();
function txn(id: string, type: string, direction: 'credit' | 'debit', cents: number, bucket = 'bucket-spend', createdAt = now()) {
  return { id, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: bucket, type, status: 'completed', direction, amount_cents: cents, created_at: createdAt };
}

/** The TreasuryView element the page renders, wherever it sits in the tree. */
function findView(node: unknown): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findView(child); if (hit) return hit; }
    return null;
  }
  const el = node as ReactElement<{ children?: unknown }>;
  if (el.type === TreasuryView) return el as ReactElement<Record<string, unknown>>;
  return findView(el.props?.children);
}

describe('moneyFlow', () => {
  it('counts a credit as in, a debit as out, and a card refund against out', () => {
    expect(moneyFlow({ type: 'parent_top_up', direction: 'credit', amount_cents: 500 })).toEqual({ inCents: 500, outCents: 0 });
    expect(moneyFlow({ type: 'card_spend', direction: 'debit', amount_cents: 200 })).toEqual({ inCents: 0, outCents: 200 });
    expect(moneyFlow({ type: 'card_refund', direction: 'credit', amount_cents: 200 })).toEqual({ inCents: 0, outCents: -200 });
  });
});

describe('the treasury: a refund is spending undone', () => {
  it('a $50 top-up, a $20 purchase and its $20 refund: in $50, out $0, net +$50', async () => {
    db.seed('wallet_transactions', [
      txn('t-topup', 'parent_top_up', 'credit', 5_000),
      txn('t-buy', 'card_spend', 'debit', 2_000),
      txn('t-refund', 'card_refund', 'credit', 2_000),
    ]);
    db.seed('wallet_goals', []);

    const view = findView(await WalletTreasuryPage());

    expect(view).not.toBeNull();
    const props = view!.props as { thisMonthIn: number; thisMonthOut: number; wallets: { monthlyIn: number; monthlyOut: number }[]; trend: { credits: number; debits: number }[] };
    expect(props.thisMonthIn).toBe(5_000);
    expect(props.thisMonthOut).toBe(0);
    // Net is still the ledger's real change: +50 −20 +20.
    expect(props.thisMonthIn - props.thisMonthOut).toBe(5_000);
    expect(props.wallets[0]).toEqual(expect.objectContaining({ monthlyIn: 5_000, monthlyOut: 0 }));
    expect(props.trend.at(-1)).toEqual(expect.objectContaining({ credits: 5_000, debits: 0 }));
  });
});

describe('the money coach: a refund is not a contribution', () => {
  it('a goal forecast counts the allowance saved, not a returned purchase', async () => {
    const recent = new Date(Date.now() - 7 * 86_400_000).toISOString();
    db.seed('wallet_transactions', [
      txn('t-allowance', 'allowance', 'credit', 8_000, 'bucket-save', recent), // $10 a week over 8 weeks
      txn('t-buy', 'card_spend', 'debit', 4_000, 'bucket-spend', recent),
      txn('t-refund', 'card_refund', 'credit', 4_000, 'bucket-spend', recent),
    ]);
    db.seed('wallet_goals', [{ id: 'g-1', family_id: FAMILY, child_wallet_id: WALLET, title: 'Bike', saved_cents: 0, target_cents: 10_000, status: 'active' }]);

    const res = await coach();

    expect(res.status).toBe(200);
    const forecast = harness.promptInput?.goals[0]?.weeksToGoal;
    expect(forecast).toBe(weeksToGoal(0, 10_000, 1_000));
    // Counted as income, the refund made it $15 a week and the goal closer than it is.
    expect(forecast).not.toBe(weeksToGoal(0, 10_000, 1_500));
  });
});
