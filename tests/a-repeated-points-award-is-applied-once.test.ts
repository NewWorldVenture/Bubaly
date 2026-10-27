import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// admin-writers N14. The super-admin Award/adjust points form submitted through
// a bare <button>, and loyalty_award_points has no dedupe: a double click, or
// a resubmit after a lost response, applied the award twice — two ledger rows,
// two audit entries, and (lifetime points only ever go up) a tier inflated for
// good. The form now carries a one-time id and a SubmitButton, and the action
// applies a submission once. The REAL action and page against the in-memory
// database, with the RPC served from the same tables as 0204's function.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/app/(app)/admin/marketing/loyalty/reward-editor', () => ({ RewardRow: () => null, AddReward: () => null }));
vi.mock('@/app/(app)/admin/marketing/loyalty/redemption-row', () => ({ RedemptionRow: () => null }));

const { awardPointsAction } = await import('@/app/(app)/admin/marketing/loyalty/actions');

let db: InMemorySupabase;

/** 0204's loyalty_award_points, over the same tables: balance, lifetime (positive only), ledger row. */
function awardRpc(args: Record<string, unknown>, store: InMemorySupabase) {
  const familyId = String(args.p_family_id);
  const points = Number(args.p_points);
  let account = store.table('loyalty_accounts').find((a) => a.family_id === familyId);
  if (!account) {
    account = { id: `acct-${familyId}`, family_id: familyId, points_balance: 0, lifetime_points: 0, tier: 'bronze' };
    store.seed('loyalty_accounts', [account]);
  }
  const balance = Number(account.points_balance) + points;
  const lifetime = Number(account.lifetime_points) + Math.max(0, points);
  store.replace('loyalty_accounts', store.table('loyalty_accounts').map((a) => (a.family_id === familyId
    ? { ...a, points_balance: balance, lifetime_points: lifetime, tier: lifetime >= 5000 ? 'gold' : lifetime >= 1000 ? 'silver' : 'bronze' } : a)));
  const transactionId = `tx-${store.table('loyalty_transactions').length + 1}`;
  store.seed('loyalty_transactions', [{
    id: transactionId, family_id: familyId, points, kind: args.p_kind, reason: args.p_reason, source: args.p_source,
    balance_after: balance, created_by: args.p_actor_id, metadata: {},
  }]);
  return { ok: true, transaction_id: transactionId, account: store.table('loyalty_accounts').find((a) => a.family_id === familyId) as Row };
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
};
const account = () => db.table('loyalty_accounts')[0];

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000, rpc: { loyalty_award_points: awardRpc } });
  h.db = db;
  db.seed('families', [{ id: 'fam-1', name: 'Rivera' }]);
  for (const table of ['loyalty_accounts', 'loyalty_transactions', 'marketing_audit_logs', 'loyalty_settings', 'loyalty_rewards', 'loyalty_redemptions']) db.seed(table, []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('one submission of the award form', () => {
  it('is applied once, however many times it arrives', async () => {
    const submission = { family_id: 'fam-1', points: '5000', reason: 'Goodwill', request_id: 'req-1' };
    await awardPointsAction(form(submission));
    // The second click, or the resubmit after the response was lost.
    await awardPointsAction(form(submission));

    expect(account()).toMatchObject({ points_balance: 5000, lifetime_points: 5000 });
    expect(db.table('loyalty_transactions')).toHaveLength(1);
    expect(db.table('loyalty_transactions')[0]).toMatchObject({ family_id: 'fam-1', points: 5000, metadata: { request_id: 'req-1' } });
    expect(db.table('marketing_audit_logs')).toHaveLength(1);
  });

  it('a second, separate submission is still applied (control)', async () => {
    await awardPointsAction(form({ family_id: 'fam-1', points: '250', request_id: 'req-1' }));
    await awardPointsAction(form({ family_id: 'fam-1', points: '-100', request_id: 'req-2' }));
    expect(account()).toMatchObject({ points_balance: 150, lifetime_points: 250 });
    expect(db.table('loyalty_transactions')).toHaveLength(2);
  });

  it('the same id for another family is that family\'s own submission (control)', async () => {
    db.seed('families', [{ id: 'fam-2', name: 'Okafor' }]);
    await awardPointsAction(form({ family_id: 'fam-1', points: '100', request_id: 'req-1' }));
    await awardPointsAction(form({ family_id: 'fam-2', points: '100', request_id: 'req-1' }));
    expect(db.table('loyalty_transactions')).toHaveLength(2);
  });
});

describe('the award form', () => {
  it('submits through a button that disables itself, with a fresh one-time id per render', async () => {
    const { default: LoyaltyPage } = await import('@/app/(app)/admin/marketing/loyalty/page');
    const first = await renderServerPage(await LoyaltyPage());
    const second = await renderServerPage(await LoyaltyPage());
    const id = (html: string) => /<input type="hidden" name="request_id" value="([^"]+)"/.exec(html)?.[1];
    expect(id(first), 'the award form carries no one-time id').toMatch(/^[0-9a-f-]{36}$/);
    expect(id(second)).not.toBe(id(first));
    // A SubmitButton renders type="submit" (and disables while pending); the bare button did not.
    expect(first).toMatch(/<button[^>]* type="submit"[^>]*>(?:(?!<\/button>).)*Award \/ adjust points/);
  });
});
