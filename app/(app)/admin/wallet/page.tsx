import type { Metadata } from 'next';
import Link from 'next/link';
import { Wallet, ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { ErrorState } from '@/components/ui/states';
import { AdminWalletClient, type FlagRow, type AuditRow } from './admin-wallet-client';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Family Wallet', robots: { index: false } };
export const dynamic = 'force-dynamic';

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
  ] = await Promise.all([
    supabase.from('family_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('child_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('gift_payments').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('parent_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('wallet_transactions').select('amount_cents, direction, status').eq('status', 'completed').limit(10000),
    supabase.from('feature_flags').select('key, enabled, description').order('key'),
    supabase.from('wallet_audit_logs').select('id, family_id, action, entity_type, detail, created_at').order('created_at', { ascending: false }).limit(25),
  ]);

  const readError = [
    activeWalletsResult.error,
    childWalletsResult.error,
    pendingGiftsResult.error,
    pendingApprovalsResult.error,
    creditAggResult.error,
    flagsResult.error,
    auditResult.error,
  ].find(Boolean);
  if (readError) {
    console.error('[admin-wallet] wallet overview read failed', readError);
    return (
      <div className="space-y-5">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Wallet className="h-6 w-6 text-brand-text" /> {tr('adminWallet.familyWallet')}
          </h1>
          <p className="mt-1 text-sm text-muted">{tr('adminWallet.liveWalletOversightAcrossEveryFamily')}</p>
        </div>
        <ErrorState message={tr('wallet.couldNotLoadWalletOversight')} />
        <a href="/admin/wallet" className="text-sm font-medium text-brand-text underline">{tr('adminWallet.refreshWalletOverview')}</a>
      </div>
    );
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
      <AdminWalletClient
        stats={{
          activeWallets: activeWallets ?? 0,
          childWallets: childWallets ?? 0,
          pendingGifts: pendingGifts ?? 0,
          pendingApprovals: pendingApprovals ?? 0,
          creditVolumeCents,
          debitVolumeCents,
          netCents: creditVolumeCents - debitVolumeCents,
        }}
        flags={flagRows}
        audit={auditRows}
      />
    </div>
  );
}
