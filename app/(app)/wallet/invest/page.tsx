import type { Metadata } from 'next';
import { AlertTriangle } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { WalletActivation } from '@/components/wallet/wallet-activation';
import {
  InvestView, type InvestAsset, type InvestChild, type Holding, type PendingOrder,
} from '@/components/wallet/invest-view';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Wallet Invest' };
export const dynamic = 'force-dynamic';

export default async function WalletInvestPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const dataWarnings: string[] = [];

  const { data: wallet, error: walletError } = await supabase.from('family_wallets').select('id, is_active').eq('family_id', familyId).maybeSingle();
  if (walletError) {
    console.error('[wallet-invest] Wallet read failed', walletError);
    return <ErrorState message={tr('invest.couldNotLoadTheFamily')} />;
  }
  if (!wallet || !wallet.is_active) return <WalletActivation canActivate={isManager(ctx.active.role)} />;

  const [{ data: assets, error: assetsError }, { data: childWallets, error: childWalletsError }, { data: members, error: membersError }, { data: holdings, error: holdingsError }, { data: buckets, error: bucketsError }, { data: orders, error: ordersError }] = await settleAll([
    supabase.from('invest_assets').select('id, symbol, name, kind, emoji, description, price_cents, risk_level').eq('is_active', true).order('sort_order'),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('invest_holdings').select('child_wallet_id, asset_id, shares, avg_cost_cents').eq('family_id', familyId),
    supabase.from('wallet_buckets').select('id, child_wallet_id, kind').eq('family_id', familyId).eq('kind', 'invest'),
    supabase.from('invest_orders').select('id, child_wallet_id, asset_id, side, shares, amount_cents, status, created_at').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }),
  ]);
  if (assetsError) { console.error('[wallet-invest] Asset read failed', assetsError); return <ErrorState message={tr('invest.couldNotLoadInvestmentsRefresh')} />; }
  if (childWalletsError) { console.error('[wallet-invest] Child wallets read failed', childWalletsError); dataWarnings.push('Child wallets'); }
  if (membersError) { console.error('[wallet-invest] Family members read failed', membersError); dataWarnings.push('Family members'); }
  if (holdingsError) { console.error('[wallet-invest] Holdings read failed', holdingsError); return <ErrorState message={tr('invest.couldNotLoadInvestmentHoldings')} />; }
  if (bucketsError) { console.error('[wallet-invest] Investment buckets read failed', bucketsError); return <ErrorState message={tr('invest.couldNotLoadInvestmentCash')} />; }
  if (ordersError) { console.error('[wallet-invest] Pending orders read failed', ordersError); dataWarnings.push('Pending orders'); }

  // Invest-bucket cash per child (from the immutable ledger).
  const investBucketIds = new Map((buckets ?? []).map((b) => [b.id, b.child_wallet_id]));
  const investCashByChild = new Map<string, number>();
  if ((buckets ?? []).length > 0) {
    const { data: txns, error: txnsError } = await supabase
      .from('wallet_transactions').select('bucket_id, direction, amount_cents, status')
      .eq('family_id', familyId).in('bucket_id', Array.from(investBucketIds.keys())).in('status', ['completed', 'processing']);
    if (txnsError) {
      console.error('[wallet-invest] Investment transactions read failed', txnsError);
      return <ErrorState message={tr('invest.couldNotLoadInvestmentCash2')} />;
    }
    for (const t of txns ?? []) {
      const child = t.bucket_id ? investBucketIds.get(t.bucket_id) : null;
      if (!child) continue;
      investCashByChild.set(child, (investCashByChild.get(child) ?? 0) + (t.direction === 'credit' ? t.amount_cents : -t.amount_cents));
    }
  }

  const nameByMember = new Map((members ?? []).map((m) => [m.id, { name: m.display_name, color: m.color }]));
  const assetList: InvestAsset[] = (assets ?? []).map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, kind: a.kind, emoji: a.emoji, description: a.description, priceCents: a.price_cents, riskLevel: a.risk_level }));
  const children: InvestChild[] = (childWallets ?? []).map((cw) => {
    const m = nameByMember.get(cw.member_id);
    return { id: cw.id, name: m?.name ?? 'Child', color: m?.color ?? null, investCashCents: investCashByChild.get(cw.id) ?? 0 };
  });
  const holdingList: Holding[] = (holdings ?? []).filter((h) => h.shares > 0).map((h) => ({ childWalletId: h.child_wallet_id, assetId: h.asset_id, shares: h.shares, avgCostCents: h.avg_cost_cents }));

  const nameByWallet = new Map(children.map((c) => [c.id, c.name]));
  const assetById = new Map(assetList.map((a) => [a.id, a]));
  const pendingOrders: PendingOrder[] = (orders ?? []).map((o) => ({
    id: o.id, childName: nameByWallet.get(o.child_wallet_id) ?? 'Child',
    assetEmoji: assetById.get(o.asset_id)?.emoji ?? '📈', assetName: assetById.get(o.asset_id)?.name ?? 'Investment',
    side: o.side, shares: o.shares, amountCents: o.amount_cents,
  }));

  return (
    <div>
      {dataWarnings.length > 0 && (
        <div role="status" aria-label={tr('walletInvest.investmentDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{tr('walletInvest.someInvestmentDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}
      <InvestView assets={assetList} childWallets={children} holdings={holdingList} pendingOrders={pendingOrders} canManage={isManager(ctx.active.role)} />
    </div>
  );
}
