import type { Metadata } from 'next';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import Link from 'next/link';
import { Wallet, ShieldCheck } from 'lucide-react';
import { createServiceClient, describeConfiguredServiceKey } from '@/lib/supabase/server';
import { settleAll, describeReadError, credentialHint } from '@/lib/supabase/settle';

import { AdminWalletClient, type FlagRow, type AuditRow } from './admin-wallet-client';
import { getTranslations } from '@/lib/i18n/server';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';

export const metadata: Metadata = { title: 'Admin · Family Wallet', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Completed transactions the ledger volume may page through before it is reported as not shown. */
const VOLUME_ROW_CEILING = 10000;

export default async function AdminWalletPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();

  const [
    activeWalletsResult,
    childWalletsResult,
    pendingGiftsResult,
    pendingApprovalsResult,
    creditAggResult,
    flagsResult,
    auditResult,
  ] = await settleAll([
    supabase.from('family_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('child_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('gift_payments').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('parent_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    // Money: `.limit(10000)` was never 10,000 (PostgREST caps at db-max-rows),
    // so this platform total was the sum of 1,000 arbitrary rows. It pages on
    // the id, not on offsets: a transaction completing between two pages
    // shifted every later offset by one, and one row's cents were added twice.
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('wallet_transactions').select('id, amount_cents, direction, status').eq('status', 'completed');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: VOLUME_ROW_CEILING, failOnMax: true }),
    supabase.from('feature_flags').select('key, enabled, description').order('key'),
    supabase.from('wallet_audit_logs').select('id, family_id, action, entity_type, detail, created_at').order('created_at', { ascending: false }).limit(25),
  ]);

  const readFailures = ([
    ['active wallets', activeWalletsResult],
    ['child wallets', childWalletsResult],
    ['pending gifts', pendingGiftsResult],
    ['pending approvals', pendingApprovalsResult],
    ['credit agg', creditAggResult],
    ['flags', flagsResult],
    ['audit', auditResult],
  ] as const)
    .filter(([, res]) => res.error)
    // The ledger volume past its ceiling did not fail: its three figures say
    // they are not shown and the ceiling banner names them, rather than $0.00
    // beside this banner. Any other failure is still named here.
    .filter(([, res]) => !('truncated' in res && res.truncated))
    .map(([label, res]) => `${label}: ${describeReadError(res.error)}`);
  const volumeCeiling = 'truncated' in creditAggResult && creditAggResult.truncated;
  if (volumeCeiling) console.warn('[admin-wallet] the ledger volume read reached its ceiling; the volume is not shown');
  const readError = readFailures.length > 0;
  if (readError) {
    // Degraded, not fatal: every consumer below defaults an absent read to an
    // empty list or zero, so one unavailable table costs its own tile rather
    // than the page. Production's migration ledger stops at 0001-0003, so a
    // later table being absent is the normal case there, not an anomaly.
    console.warn('[admin-wallet] wallet overview read failed — rendering degraded', readError);
  }

  const { count: activeWallets } = activeWalletsResult;
  const { count: childWallets } = childWalletsResult;
  const { count: pendingGifts } = pendingGiftsResult;
  const { count: pendingApprovals } = pendingApprovalsResult;
  const { data: creditAgg } = creditAggResult;
  const { data: flags } = flagsResult;
  const { data: audit } = auditResult;

  const txns = (creditAgg ?? []) as { amount_cents: number; direction: string }[];
  const creditVolumeCents = txns.filter((t) => t.direction === 'credit').reduce((s, t) => s + Number(t.amount_cents), 0);
  const debitVolumeCents = txns.filter((t) => t.direction === 'debit').reduce((s, t) => s + Number(t.amount_cents), 0);

  const flagRows: FlagRow[] = (flags ?? []).map((f) => ({ key: f.key, enabled: f.enabled, description: f.description }));
  const auditRows: AuditRow[] = (audit ?? []).map((a) => ({
    id: a.id, familyId: a.family_id, action: a.action, entityType: a.entity_type, detail: a.detail, createdAt: a.created_at,
  }));

  return (
    <div className="space-y-5">
      <PartialReadBanner title={"Wallet oversight is incomplete — some reads failed:"} failures={readFailures} hint={credentialHint(readFailures, describeConfiguredServiceKey())} />
      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: VOLUME_ROW_CEILING.toLocaleString() })}
        failures={volumeCeiling ? [tr('adminWalletAdminWalletClient.totalCredits'), tr('adminWalletAdminWalletClient.totalDebits'), tr('adminWalletAdminWalletClient.netOutstanding')] : []}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Wallet className="h-6 w-6 text-brand-text" /> {tr('adminWallet.familyWallet')}
          </h1>
          <p className="mt-1 text-sm text-muted">{tr('wallet.oversightForTheVirtualLedger')}</p>
        </div>
        <Link href="/admin/wallet/reconciliation"
          className="flex flex-shrink-0 items-center gap-2 rounded-xl border border-border bg-surface/40 px-4 py-2 text-sm font-semibold transition hover:border-brand/40 hover:text-brand-text">
          <ShieldCheck className="h-4 w-4" /> {tr('adminWallet.reconciliation')}
        </Link>
      </div>
      {/* A read that failed is named in the banner above, and what it fed is
          not shown as a value: a count reads Unavailable rather than 0, the
          ledger volume rather than $0.00, and the flags and the activity are
          the read-error state rather than no flags to toggle and "No wallet
          audit activity yet". A volume past its ceiling has an error too. */}
      <AdminWalletClient
        stats={{
          activeWallets: activeWalletsResult.error ? null : activeWallets ?? 0,
          childWallets: childWalletsResult.error ? null : childWallets ?? 0,
          pendingGifts: pendingGiftsResult.error ? null : pendingGifts ?? 0,
          pendingApprovals: pendingApprovalsResult.error ? null : pendingApprovals ?? 0,
          creditVolumeCents: creditAggResult.error ? null : creditVolumeCents,
          debitVolumeCents: creditAggResult.error ? null : debitVolumeCents,
          netCents: creditAggResult.error ? null : creditVolumeCents - debitVolumeCents,
        }}
        flags={flagsResult.error ? null : flagRows}
        audit={auditResult.error ? null : auditRows}
      />
    </div>
  );
}
