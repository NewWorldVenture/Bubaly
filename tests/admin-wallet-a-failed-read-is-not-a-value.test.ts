import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { formatCents } from '@/lib/wallet/ledger';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin/wallet renders degraded when a read fails and names the read in its
// banner, but what that read fed defaulted to a value: a failed wallet count
// read 0 on its tile, a failed ledger read $0.00 for every volume, a failed
// flag read was no flags to toggle, and a failed audit read "No wallet audit
// activity yet" — on a money page, an all-clear nobody gave (coverage sweep
// round 9, class A). Each is now Unavailable, or the read-error state for a
// list. The REAL page and client, in-memory database with PostgREST's cap.
const CAP = 1000;

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
vi.mock('@/app/(app)/admin/actions', () => ({ adminToggleFeatureFlagAction: async () => ({ ok: true }) }));

let db: InMemorySupabase;
const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];
const readError = SOURCE_MESSAGES['wallet.couldNotLoadWalletOversight'];

function seed() {
  db.seed('family_wallets', [{ id: 'fw-1', is_active: true }, { id: 'fw-2', is_active: true }]);
  db.seed('child_wallets', [{ id: 'cw-1', is_active: true }]);
  db.seed('gift_payments', [{ id: 'g-1', status: 'pending' }]);
  db.seed('parent_approvals', [{ id: 'pa-1', status: 'pending' }, { id: 'pa-2', status: 'pending' }, { id: 'pa-3', status: 'approved' }]);
  db.seed('wallet_transactions', [
    { id: 'tx-1', direction: 'credit', amount_cents: 500, status: 'completed' },
    { id: 'tx-2', direction: 'debit', amount_cents: 200, status: 'completed' },
  ]);
  db.seed('feature_flags', [{ key: 'wallet_enabled', enabled: true, description: 'The family wallet' }]);
  db.seed('wallet_audit_logs', [{ id: 'wa-1', family_id: 'fam-1', action: 'credit', entity_type: 'wallet', detail: 'Allowance paid', created_at: '2026-10-20T10:00:00Z' }]);
}

async function render(): Promise<string> {
  const { default: AdminWalletPage } = await import('@/app/(app)/admin/wallet/page');
  return renderServerPage(await AdminWalletPage());
}

/** The figure a stat card shows above its label. */
const stat = (html: string, label: string) => new RegExp(`<div class="mt-2 text-2xl font-bold">([^<]*)</div><div class="text-\\[11px\\] text-muted">${label}</div>`).exec(html)?.[1];
const flagsSection = (html: string) => textOf(html.slice(html.indexOf(SOURCE_MESSAGES['adminWalletAdminWalletClient.featureFlags']), html.indexOf(SOURCE_MESSAGES['adminWalletAdminWalletClient.recentWalletActivity'])));
const auditSection = (html: string) => textOf(html.slice(html.indexOf(SOURCE_MESSAGES['adminWalletAdminWalletClient.recentWalletActivity'])));

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/wallet: a read that FAILS is Unavailable or the read-error state, not a value', () => {
  it.each([
    ['family_wallets', 'Active Wallets'],
    ['child_wallets', 'Child Wallets'],
    ['gift_payments', 'Pending Gifts'],
    ['parent_approvals', 'Pending Approvals'],
  ])('a %s count that fails: its tile, %s, reads Unavailable', async (table, label) => {
    seed();
    h.db = withFaults(db, (name) => (name === table ? { message: `${table} unavailable` } : null));
    const html = await render();
    expect(textOf(html)).toContain('Wallet oversight is incomplete');
    expect(stat(html, label)).toBe(unavailable);
    // Only its own tile.
    for (const other of ['Active Wallets', 'Child Wallets', 'Pending Gifts', 'Pending Approvals'].filter((l) => l !== label)) {
      expect(stat(html, other)).toMatch(/^\d+$/);
    }
  });

  it('a ledger read that fails: every volume reads Unavailable, not $0.00', async () => {
    seed();
    h.db = withFaults(db, (name) => (name === 'wallet_transactions' ? { message: 'ledger unavailable' } : null));
    const html = await render();
    expect(html).toContain(`text-green-400">${unavailable}</div>`);
    expect(html).toContain(`text-rose-400">${unavailable}</div>`);
    expect(html).toContain(`<div class="mt-1 text-xl font-bold">${unavailable}</div>`);
    expect(html).not.toContain(formatCents(0));
  });

  it('a flag read that fails is the read-error state, not a list with nothing to toggle', async () => {
    seed();
    h.db = withFaults(db, (name) => (name === 'feature_flags' ? { message: 'feature_flags unavailable' } : null));
    const html = await render();
    expect(flagsSection(html)).toContain(readError);
    expect(html).not.toContain('role="switch"');
    expect(auditSection(html)).toContain('Allowance paid');
  });

  it('an audit read that fails is the read-error state, not "No wallet audit activity yet"', async () => {
    seed();
    h.db = withFaults(db, (name) => (name === 'wallet_audit_logs' ? { message: 'wallet_audit_logs unavailable' } : null));
    const html = await render();
    expect(auditSection(html)).toContain(readError);
    expect(html).not.toContain(SOURCE_MESSAGES['adminWalletAdminWalletClient.noWalletAuditActivityYet']);
    expect(flagsSection(html)).not.toContain(readError);
  });

  it('the control: every read answers, and each figure and list is its value', async () => {
    seed();
    const html = await render();
    expect(textOf(html)).not.toContain('Wallet oversight is incomplete');
    expect(stat(html, 'Active Wallets')).toBe('2');
    expect(stat(html, 'Child Wallets')).toBe('1');
    expect(stat(html, 'Pending Gifts')).toBe('1');
    expect(stat(html, 'Pending Approvals')).toBe('2');
    expect(html).toContain(`text-green-400">${formatCents(500)}</div>`);
    expect(html).toContain(`text-rose-400">${formatCents(200)}</div>`);
    expect(html).toContain('role="switch"');
    expect(auditSection(html)).toContain('Allowance paid');
    expect(html).not.toContain(unavailable);
    expect(html).not.toContain(readError);
    db.replace('wallet_audit_logs', []);
    expect(await render()).toContain(SOURCE_MESSAGES['adminWalletAdminWalletClient.noWalletAuditActivityYet']);
  });
});
