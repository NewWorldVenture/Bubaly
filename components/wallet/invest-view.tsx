'use client';

// Wallet → Invest. EDUCATIONAL, simulated investing for kids. Pretend money from
// the child's Invest bucket buys simulated assets; parents approve orders. Shows
// holdings, gain/loss, a compound-growth projector, and an AI explainer. Clear
// "simulation" disclaimer; never implies real trading or guaranteed returns.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TrendingUp, TrendingDown, Sparkles, Check, X, Loader2, Info } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { formatCents } from '@/lib/wallet/ledger';
import {
  portfolioValue, portfolioCost, gainLossCents, gainLossPct, projectGrowth,
  orderAmountCents, type Holding as PortHolding, type PriceMap,
} from '@/lib/invest/portfolio';
import { placeInvestOrderAction, decideInvestOrderAction } from '@/app/(app)/wallet/invest/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type InvestAsset = { id: string; symbol: string; name: string; kind: string; emoji: string; description: string | null; priceCents: number; riskLevel: string };
export type InvestChild = { id: string; name: string; color: string | null; investCashCents: number };
export type Holding = { childWalletId: string; assetId: string; shares: number; avgCostCents: number };
export type PendingOrder = { id: string; childName: string; assetEmoji: string; assetName: string; side: 'buy' | 'sell'; shares: number; amountCents: number };

export function InvestView(props: {
  assets: InvestAsset[]; childWallets: InvestChild[]; holdings: Holding[]; pendingOrders: PendingOrder[]; canManage: boolean;
}) {
  const tr = useTranslations();
  const { assets, childWallets, holdings, pendingOrders, canManage } = props;
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const prices: PriceMap = Object.fromEntries(assets.map((a) => [a.id, a.priceCents]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const holdingsByChild = new Map<string, Holding[]>();
  for (const h of holdings) { const a = holdingsByChild.get(h.childWalletId) ?? []; a.push(h); holdingsByChild.set(h.childWalletId, a); }

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Something went wrong');
    success(okMsg);
    router.refresh();
  }

  return (
    <div>
      <WalletSubnav />
      <PageHeader title={tr('invest.invest')} description={tr('invest.aSafePlaceToLearn')} />

      <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>{tr('invest.thisIsAn')} <strong>{tr('invest.educationalSimulation')}</strong>{' '}{tr('invest.kidsPracticeWithPretendMoney')}</p>
      </div>

      {/* Manager: pending orders */}
      {canManage && pendingOrders.length > 0 && (
        <div className="mt-4 rounded-2xl border border-border bg-surface/40 p-4">
          <h3 className="mb-2 font-semibold">{tr('invest.approvalsNeeded')}</h3>
          <div className="space-y-2">
            {pendingOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-bg/40 p-2.5">
                <p className="text-sm">{o.childName} wants to <strong>{o.side}</strong> {o.shares} {o.assetEmoji} {o.assetName} <span className="text-muted">({formatCents(o.amountCents)})</span></p>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button type="button" disabled={busy === `o-${o.id}`} onClick={() => run(`o-${o.id}`, () => decideInvestOrderAction({ orderId: o.id, approve: true }), 'Approved')}
                    className="inline-flex items-center gap-1 rounded-lg bg-success/15 px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/25"><Check className="h-3.5 w-3.5" /></button>
                  <button type="button" disabled={busy === `o-${o.id}`} onClick={() => run(`o-${o.id}`, () => decideInvestOrderAction({ orderId: o.id, approve: false }), 'Rejected')}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {childWallets.length === 0 ? (
        <EmptyState icon={TrendingUp} title={tr('invest.noChildWalletsYet')} description={tr('investView.activateTheFamilyWalletAnd')} />
      ) : (
        <div className="mt-4 space-y-4">
          {childWallets.map((child) => (
            <ChildInvest key={child.id} child={child} assets={assets} assetById={assetById} prices={prices}
              holdings={holdingsByChild.get(child.id) ?? []} busy={busy}
              onTrade={(assetId, side, shares) => run(`trade-${child.id}`, () => placeInvestOrderAction({ childWalletId: child.id, assetId, side, shares }), 'Sent for parent approval')} />
          ))}
        </div>
      )}

      <GrowthProjector />
    </div>
  );
}

function ChildInvest({ child, assets, assetById, prices, holdings, busy, onTrade }: {
  child: InvestChild; assets: InvestAsset[]; assetById: Map<string, InvestAsset>; prices: PriceMap;
  holdings: Holding[]; busy: string | null; onTrade: (assetId: string, side: 'buy' | 'sell', shares: number) => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const portHoldings: PortHolding[] = holdings.map((h) => ({ assetId: h.assetId, shares: h.shares, avgCostCents: h.avgCostCents }));
  const value = portfolioValue(portHoldings, prices);
  const cost = portfolioCost(portHoldings);
  const gain = gainLossCents(portHoldings, prices);
  const gainPct = gainLossPct(portHoldings, prices);
  const up = gain >= 0;

  const [assetId, setAssetId] = useState(assets[0]?.id ?? '');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [sharesStr, setSharesStr] = useState('');
  const [explainer, setExplainer] = useState<{ explainer: string; tips: string[] } | null>(null);
  const [explaining, setExplaining] = useState(false);

  const asset = assetById.get(assetId);
  const shares = Number(sharesStr) || 0;
  const estCost = asset ? orderAmountCents(shares, asset.priceCents) : 0;

  function trade() {
    if (shares <= 0) return toastError('Enter how many shares.');
    onTrade(assetId, side, shares);
    setSharesStr('');
  }

  async function explain() {
    setExplaining(true);
    try {
      const res = await fetch('/api/ai/invest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ childWalletId: child.id, assetId }) });
      const data = await res.json();
      if (!res.ok) { toastError(data.error ?? 'Could not explain right now.'); return; }
      setExplainer(data.coaching);
    } catch { toastError('Could not explain right now.'); }
    finally { setExplaining(false); }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={child.name} color={child.color ?? undefined} size={36} className="rounded-full" />
          <div>
            <p className="font-semibold">{child.name}</p>
            <p className="text-xs text-muted">{formatCents(child.investCashCents)} {tr('invest.readyToInvest')}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold">{formatCents(value)}</p>
          {cost > 0 && (
            <p className={`flex items-center justify-end gap-1 text-xs font-medium ${up ? 'text-success' : 'text-danger'}`}>
              {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {up ? '+' : ''}{formatCents(gain)} ({gainPct.toFixed(1)}%)
            </p>
          )}
        </div>
      </div>

      {holdings.length > 0 && (
        <div className="mb-3 space-y-1">
          {holdings.map((h) => {
            const a = assetById.get(h.assetId);
            const v = Math.round(h.shares * (prices[h.assetId] ?? 0));
            return (
              <div key={h.assetId} className="flex items-center justify-between rounded-lg border border-border bg-bg/40 px-3 py-1.5 text-sm">
                <span>{a?.emoji} {a?.name} <span className="text-muted">· {h.shares} sh</span></span>
                <span className="font-medium">{formatCents(v)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Trade panel */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(['buy', 'sell'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSide(s)}
              className={`px-3 py-1.5 text-xs font-medium ${side === s ? (s === 'buy' ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger') : 'text-muted'}`}>
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)} className="h-9 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
          {assets.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name} — {formatCents(a.priceCents)}</option>)}
        </select>
        <input type="number" min="0" step="0.01" value={sharesStr} onChange={(e) => setSharesStr(e.target.value)} placeholder={tr('invest.shares')} className="h-9 w-24 rounded-lg border border-border bg-bg px-2 text-sm focus-ring" />
        {estCost > 0 && <span className="text-xs text-muted">≈ {formatCents(estCost)}</span>}
        <Button onClick={trade} loading={busy === `trade-${child.id}`} disabled={!assetId || shares <= 0}>{tr('invest.request')}</Button>
        <button type="button" onClick={explain} disabled={explaining}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-brand-text hover:bg-elevated disabled:opacity-60">
          {explaining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {tr('invest.explain')}
        </button>
      </div>

      {asset?.description && <p className="mt-2 text-xs text-muted">{asset.emoji} {asset.description}</p>}
      {explainer && (
        <div className="mt-2 rounded-xl border border-brand/20 bg-brand/5 p-3">
          <p className="text-sm">{explainer.explainer}</p>
          {explainer.tips.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted">
              {explainer.tips.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// A fun compound-growth teaching tool (not a prediction).
function GrowthProjector() {
  const tr = useTranslations();
  const [start, setStart] = useState(50);
  const [monthly, setMonthly] = useState(10);
  const [years, setYears] = useState(10);
  const rate = 7; // illustrative long-run average, clearly labelled
  const projected = projectGrowth(start * 100, monthly * 100, years, rate);
  const contributed = (start + monthly * 12 * years) * 100;

  return (
    <div className="mt-6 rounded-2xl border border-border bg-surface/40 p-4">
      <h3 className="font-semibold">{tr('invest.theMagicOfCompoundGrowth')}</h3>
      <p className="mb-3 text-xs text-muted">{tr('invest.seeHowMoneyCanGrowOver')} {rate}{tr('invest.aYearJustForLearningReal')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={`Start: $${start}`}><input type="range" min={0} max={500} step={10} value={start} onChange={(e) => setStart(Number(e.target.value))} className="w-full" /></Field>
        <Field label={`Each month: $${monthly}`}><input type="range" min={0} max={100} step={5} value={monthly} onChange={(e) => setMonthly(Number(e.target.value))} className="w-full" /></Field>
        <Field label={`For: ${years} years`}><input type="range" min={1} max={18} step={1} value={years} onChange={(e) => setYears(Number(e.target.value))} className="w-full" /></Field>
      </div>
      <div className="mt-3 flex items-end justify-between rounded-xl bg-bg/40 p-3">
        <div><p className="text-xs text-muted">{tr('invest.youdPutIn')}</p><p className="font-semibold">{formatCents(contributed)}</p></div>
        <div className="text-right"><p className="text-xs text-muted">{tr('invest.couldGrowTo')}</p><p className="text-xl font-bold text-success">{formatCents(projected)}</p></div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
