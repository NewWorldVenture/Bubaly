'use client';

// Family Economy — parent-defined custom currencies (non-cash). Kids earn tokens
// and spend them on family rewards. Four tabs: Balances, Store, Requests, Manage.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Coins, Store, Inbox, Settings2, Plus, Check, X, Gift } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { canAfford, formatTokens } from '@/lib/economy/ledger';
import {
  createCurrencyAction, awardTokensAction, createRewardAction,
  requestRedemptionAction, decideRedemptionAction,
} from '@/app/(app)/economy/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type Currency = { id: string; name: string; emoji: string; unitLabel: string | null };
export type Member = { id: string; name: string; color: string | null; isManager: boolean };
export type BalanceCell = { currencyId: string; memberId: string; balance: number };
export type Reward = { id: string; currencyId: string; title: string; emoji: string; cost: number; stock: number | null };
export type Redemption = { id: string; currencyId: string; memberId: string; memberName: string; title: string; cost: number; status: string };

type Tab = 'balances' | 'store' | 'requests' | 'manage';

export function EconomyView(props: {
  currencies: Currency[]; members: Member[]; balances: BalanceCell[];
  rewards: Reward[]; redemptions: Redemption[]; canManage: boolean;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const { currencies, members, balances, rewards, redemptions, canManage } = props;
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('balances');
  const [busy, setBusy] = useState<string | null>(null);

  const kids = members.filter((m) => !m.isManager);
  const emojiByCurrency = new Map(currencies.map((c) => [c.id, c.emoji]));
  const balanceOf = (currencyId: string, memberId: string) =>
    balances.find((b) => b.currencyId === currencyId && b.memberId === memberId)?.balance ?? 0;
  const pending = redemptions.filter((r) => r.status === 'pending');

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return toastError(res.error ?? 'Something went wrong');
    success(okMsg);
    router.refresh();
  }

  if (currencies.length === 0 && !canManage) {
    return (
      <div>
        <PageHeader title={tr('economy.familyEconomy')} description={t('economyView.earnAndSpendFamilyTokens')} />
        <EmptyState icon={Coins} title={tr('economy.noCurrenciesYet')} description={t('economyView.askAParentToSet')} />
      </div>
    );
  }

  const TABS: { key: Tab; label: string; icon: typeof Coins; show: boolean }[] = [
    { key: 'balances', label: 'Balances', icon: Coins, show: true },
    { key: 'store', label: 'Store', icon: Store, show: true },
    { key: 'requests', label: 'Requests', icon: Inbox, show: canManage },
    { key: 'manage', label: 'Manage', icon: Settings2, show: canManage },
  ];

  return (
    <div>
      <PageHeader title={tr('economy.familyEconomy')} description={t('economyView.customFamilyTokensKidsEarn')} />

      <div className="mb-5 mt-3 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface/40 p-1 no-scrollbar">
        {TABS.filter((t) => t.show).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn('flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
              tab === t.key ? 'bg-brand text-white' : 'text-muted hover:bg-elevated hover:text-fg')}>
            <t.icon className="h-3.5 w-3.5" /> {t.label}
            {t.key === 'requests' && pending.length > 0 && (
              <span className="ml-0.5 rounded-full bg-danger/15 px-1.5 text-[10px] font-bold text-danger">{pending.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Balances ── */}
      {tab === 'balances' && (
        kids.length === 0 ? (
          <EmptyState icon={Coins} title={tr('economy.noKidsYet')} description={t('economyView.addChildMembersToStart')} />
        ) : (
          <div className="space-y-3">
            {kids.map((m) => (
              <div key={m.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-2 flex items-center gap-2.5">
                  <Avatar name={m.name} color={m.color ?? undefined} size={32} className="rounded-full" />
                  <p className="font-semibold">{m.name}</p>
                </div>
                {currencies.length === 0 ? (
                  <p className="text-sm text-muted">{t('economyView.noCurrenciesYet')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {currencies.map((c) => (
                      <span key={c.id} className="rounded-xl border border-border bg-bg/40 px-3 py-1.5 text-sm">
                        <span className="font-bold">{balanceOf(c.id, m.id)}</span> {c.emoji} <span className="text-muted">{c.name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Store ── */}
      {tab === 'store' && (
        rewards.length === 0 ? (
          <EmptyState icon={Store} title={tr('economy.noRewardsYet')} description={canManage ? 'Add rewards in the Manage tab.' : 'Ask a parent to add rewards.'} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rewards.map((r) => (
              <RewardCard key={r.id} reward={r} emoji={emojiByCurrency.get(r.currencyId) ?? '⭐'}
                kids={kids} balanceOf={balanceOf} busy={busy}
                onRequest={(memberId) => run(`redeem-${r.id}-${memberId}`, () => requestRedemptionAction({ rewardId: r.id, memberId }), 'Request sent for approval')} />
            ))}
          </div>
        )
      )}

      {/* ── Requests (manager) ── */}
      {tab === 'requests' && canManage && (
        pending.length === 0 ? (
          <EmptyState icon={Inbox} title={tr('economy.noPendingRequests')} description={t('economyView.redemptionRequestsWillAppearHere')} />
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3">
                <div>
                  <p className="text-sm font-medium">{r.memberName} wants {r.title}</p>
                  <p className="text-xs text-muted">{formatTokens(r.cost, emojiByCurrency.get(r.currencyId) ?? '⭐')}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" disabled={busy === `decide-${r.id}`}
                    onClick={() => run(`decide-${r.id}`, () => decideRedemptionAction({ redemptionId: r.id, approve: true }), 'Approved')}
                    className="inline-flex items-center gap-1 rounded-lg bg-success/15 px-2.5 py-1.5 text-xs font-medium text-success hover:bg-success/25">
                    <Check className="h-3.5 w-3.5" />{' '}{t('economyView.approve')}</button>
                  <button type="button" disabled={busy === `decide-${r.id}`}
                    onClick={() => run(`decide-${r.id}`, () => decideRedemptionAction({ redemptionId: r.id, approve: false }), 'Rejected')}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-danger">
                    <X className="h-3.5 w-3.5" />{' '}{t('economyView.reject')}</button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Manage (manager) ── */}
      {tab === 'manage' && canManage && (
        <ManagePanel currencies={currencies} kids={kids} busy={busy}
          onCreateCurrency={(name, emoji, unit) => run('new-currency', () => createCurrencyAction({ name, emoji, unitLabel: unit }), 'Currency created')}
          onAward={(currencyId, memberId, amount, reason) => run('award', () => awardTokensAction({ currencyId, memberId, amount, reason }), 'Tokens awarded')}
          onCreateReward={(currencyId, title, emoji, cost) => run('new-reward', () => createRewardAction({ currencyId, title, emoji, cost }), 'Reward created')}
        />
      )}
    </div>
  );
}

function RewardCard({ reward, emoji, kids, balanceOf, busy, onRequest }: {
  reward: Reward; emoji: string; kids: Member[];
  balanceOf: (c: string, m: string) => number; busy: string | null; onRequest: (memberId: string) => void;
}) {
  const [who, setWho] = useState<string>(kids[0]?.id ?? '');
  const affordable = who ? canAfford(balanceOf(reward.currencyId, who), reward.cost) : false;
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex items-center gap-2">
        <span className="text-2xl">{reward.emoji}</span>
        <div>
          <p className="font-semibold">{reward.title}</p>
          <p className="text-xs text-muted">{formatTokens(reward.cost, emoji)}{reward.stock != null && ` · ${reward.stock} left`}</p>
        </div>
      </div>
      {kids.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <select value={who} onChange={(e) => setWho(e.target.value)}
            className="h-9 flex-1 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
            {kids.map((k) => <option key={k.id} value={k.id}>{k.name} ({balanceOf(reward.currencyId, k.id)} {emoji})</option>)}
          </select>
          <Button onClick={() => onRequest(who)} loading={busy === `redeem-${reward.id}-${who}`} disabled={!affordable}>
            <Gift className="mr-1 h-4 w-4" /> {affordable ? 'Redeem' : 'Not enough'}
          </Button>
        </div>
      )}
    </div>
  );
}

function ManagePanel({ currencies, kids, busy, onCreateCurrency, onAward, onCreateReward }: {
  currencies: Currency[]; kids: Member[]; busy: string | null;
  onCreateCurrency: (name: string, emoji: string, unit: string) => void;
  onAward: (currencyId: string, memberId: string, amount: number, reason: string) => void;
  onCreateReward: (currencyId: string, title: string, emoji: string, cost: number) => void;
}) {
  const tr = useTranslations();
  const [cName, setCName] = useState(''); const [cEmoji, setCEmoji] = useState('⭐'); const [cUnit, setCUnit] = useState('');
  const [aCur, setACur] = useState(currencies[0]?.id ?? ''); const [aMem, setAMem] = useState(kids[0]?.id ?? '');
  const [aAmt, setAAmt] = useState(''); const [aReason, setAReason] = useState('');
  const [rCur, setRCur] = useState(currencies[0]?.id ?? ''); const [rTitle, setRTitle] = useState('');
  const [rEmoji, setREmoji] = useState('🎁'); const [rCost, setRCost] = useState('');

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface/40 p-4">
        <h3 className="mb-3 font-semibold">{tr('economy.newCurrency')}</h3>
        <div className="flex flex-wrap gap-2">
          <input value={cEmoji} onChange={(e) => setCEmoji(e.target.value)} className="h-10 w-14 rounded-lg border border-border bg-bg px-2 text-center text-lg focus-ring" />
          <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder={tr('economy.nameEGStars')} className="h-10 min-w-[140px] flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
          <input value={cUnit} onChange={(e) => setCUnit(e.target.value)} placeholder={tr('economy.unitOptional')} className="h-10 w-32 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
          <Button onClick={() => onCreateCurrency(cName, cEmoji, cUnit)} loading={busy === 'new-currency'} disabled={!cName.trim()}><Plus className="mr-1 h-4 w-4" /> Add</Button>
        </div>
      </section>

      {currencies.length > 0 && kids.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface/40 p-4">
          <h3 className="mb-3 font-semibold">{tr('economy.awardTokens')}</h3>
          <div className="flex flex-wrap gap-2">
            <select value={aMem} onChange={(e) => setAMem(e.target.value)} className="h-10 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
              {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
            <input type="number" min="1" value={aAmt} onChange={(e) => setAAmt(e.target.value)} placeholder={tr('economy.amount')} className="h-10 w-24 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
            <select value={aCur} onChange={(e) => setACur(e.target.value)} className="h-10 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
              {currencies.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
            <input value={aReason} onChange={(e) => setAReason(e.target.value)} placeholder={tr('economy.reasonOptional')} className="h-10 min-w-[120px] flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
            <Button onClick={() => onAward(aCur, aMem, Number(aAmt), aReason)} loading={busy === 'award'} disabled={!aCur || !aMem || !aAmt}>{tr('economy.award')}</Button>
          </div>
        </section>
      )}

      {currencies.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface/40 p-4">
          <h3 className="mb-3 font-semibold">{tr('economy.newReward')}</h3>
          <div className="flex flex-wrap gap-2">
            <input value={rEmoji} onChange={(e) => setREmoji(e.target.value)} className="h-10 w-14 rounded-lg border border-border bg-bg px-2 text-center text-lg focus-ring" />
            <input value={rTitle} onChange={(e) => setRTitle(e.target.value)} placeholder={tr('economy.rewardEGMovieNightPick')} className="h-10 min-w-[160px] flex-1 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
            <input type="number" min="1" value={rCost} onChange={(e) => setRCost(e.target.value)} placeholder={tr('economy.cost')} className="h-10 w-24 rounded-lg border border-border bg-bg px-3 text-sm focus-ring" />
            <select value={rCur} onChange={(e) => setRCur(e.target.value)} className="h-10 rounded-lg border border-border bg-bg px-2 text-sm focus-ring">
              {currencies.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
            <Button onClick={() => onCreateReward(rCur, rTitle, rEmoji, Number(rCost))} loading={busy === 'new-reward'} disabled={!rCur || !rTitle.trim() || !rCost}><Plus className="mr-1 h-4 w-4" /> Add</Button>
          </div>
        </section>
      )}
    </div>
  );
}
