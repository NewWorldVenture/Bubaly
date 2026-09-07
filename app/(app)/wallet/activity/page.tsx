import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import { WalletActivityView } from '@/components/wallet/activity-view';
import { isManager } from '@/lib/constants/roles';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Wallet Activity' };

export default async function WalletActivityPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  const { data: wallet, error: walletError } = await supabase
    .from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (walletError) {
    console.error('[wallet-activity] Wallet read failed', walletError);
    return <ErrorState message={tr('activity.couldNotLoadTheFamily')} />;
  }
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: childWallets, error: childWalletsError }, { data: txns, error: txnsError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId),
    supabase.from('wallet_transactions').select('id, child_wallet_id, type, status, direction, amount_cents, description, created_at').eq('family_id', familyId).order('created_at', { ascending: false }).limit(2000),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
  ]);
  if (childWalletsError) { console.error('[wallet-activity] Child wallets read failed', childWalletsError); dataWarnings.push('Child wallets'); }
  if (txnsError) { console.error('[wallet-activity] Wallet transactions read failed', txnsError); dataWarnings.push('Wallet transactions'); }
  if (membersError) { console.error('[wallet-activity] Family members read failed', membersError); dataWarnings.push('Family members'); }

  const memberById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const childName = new Map((childWallets ?? []).map((c) => [c.id, memberById.get(c.member_id) ?? 'Child']));

  const rows = (txns ?? []).map((t) => ({
    id: t.id, child_wallet_id: t.child_wallet_id, type: t.type, status: t.status, direction: t.direction,
    amount_cents: t.amount_cents, description: t.description, created_at: t.created_at,
    childName: t.child_wallet_id ? childName.get(t.child_wallet_id) ?? null : null,
  }));
  const childOptions = (childWallets ?? []).map((c) => ({ id: c.id, name: memberById.get(c.member_id) ?? 'Child' }));

  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={tr('walletActivity.walletActivityDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{tr('walletActivity.someWalletDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <WalletActivityView rows={rows} childOptions={childOptions} />
    </div>
  );
}
