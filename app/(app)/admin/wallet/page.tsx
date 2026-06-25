import type { Metadata } from 'next';
import { Wallet } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { AdminWalletClient, type FlagRow, type AuditRow } from './admin-wallet-client';

export const metadata: Metadata = { title: 'Admin · Family Wallet', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminWalletPage() {
  const supabase = createServiceClient();

  const [
    { count: activeWallets },
    { count: childWallets },
    { count: pendingGifts },
    { count: pendingApprovals },
    { data: creditAgg },
    { data: flags },
    { data: audit },
  ] = await Promise.all([
    supabase.from('family_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('child_wallets').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('gift_payments').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('parent_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('wallet_transactions').select('amount_cents, direction, status').eq('status', 'completed').limit(10000),
    supabase.from('feature_flags').select('key, enabled, description').order('key'),
    supabase.from('wallet_audit_logs').select('id, family_id, action, entity_type, detail, created_at').order('created_at', { ascending: false }).limit(25),
  ]);

  const txns = (creditAgg ?? []) as { amount_cents: number; direction: string }[];
  const creditVolumeCents = txns.filter((t) => t.direction === 'credit').reduce((s, t) => s + Number(t.amount_cents), 0);
  const debitVolumeCents = txns.filter((t) => t.direction === 'debit').reduce((s, t) => s + Number(t.amount_cents), 0);

  const flagRows: FlagRow[] = (flags ?? []).map((f) => ({ key: f.key, enabled: f.enabled, description: f.description }));
  const auditRows: AuditRow[] = (audit ?? []).map((a) => ({
    id: a.id, familyId: a.family_id, action: a.action, entityType: a.entity_type, detail: a.detail, createdAt: a.created_at,
  }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Wallet className="h-6 w-6 text-brand" /> Family Wallet
        </h1>
        <p className="mt-1 text-sm text-muted">
          Oversight for the virtual-ledger Family Wallet across every family — activation, pending
          approvals, ledger volume, feature flags, and recent audit activity.
        </p>
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
