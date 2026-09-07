'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Wallet, Plus, Send, MoreHorizontal, CreditCard, Landmark, PiggyBank, Banknote,
  Gift, Ticket, Award, ShieldCheck, ChevronRight, Trash2, ArrowDownLeft, ArrowUpRight,
  Search, X, Sparkles, FolderLock, Star,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  walletOverview, fmtUsd, fmtDollars, fmtCount, fmtSignedUsd, txnSignedCents, fmtTxnDate,
  ACCOUNT_KIND_META, CARD_BRAND_LABEL,
} from '@/lib/wallet/hub';
import {
  addAccountAction, addCardAction, addPassAction, addRewardAction, addTransactionAction,
  deleteWalletRowAction,
} from '@/app/(app)/wallet/hub-actions';
import { useTranslations } from '@/components/i18n/locale-provider';

type Account = Tables<'financial_accounts'>;
type Txn = Tables<'transactions'>;
type Card = Tables<'wallet_cards'>;
type Pass = Tables<'wallet_passes'>;
type Reward = Tables<'wallet_rewards'>;

const TABS = ['Accounts', 'Cards', 'Passes', 'Rewards', 'Transactions', 'Documents'] as const;
type Tab = (typeof TABS)[number];

const ACCOUNT_ICON: Record<string, typeof Landmark> = {
  checking: Landmark, savings: PiggyBank, credit: CreditCard, investment: Award, retirement: Award,
};
const CARD_TINT: Record<string, string> = {
  visa: 'bg-blue-600', mastercard: 'bg-orange-600', amex: 'bg-sky-600', discover: 'bg-amber-600', other: 'bg-slate-600',
};

type AddKind = 'account' | 'card' | 'pass' | 'reward' | 'transaction' | null;

export function WalletHub() {
  const t = useTranslations();
  const tr = useTranslations();
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: accounts, loading: la, error: accountsError, refresh: refreshAccounts } = useRealtimeQuery<Account>({
    table: 'financial_accounts', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('financial_accounts').select('*').eq('family_id', familyId).order('created_at', { ascending: true }),
  });
  const { data: txns, loading: lt, error: txnsError, refresh: refreshTxns } = useRealtimeQuery<Txn>({
    table: 'transactions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('transactions').select('*').eq('family_id', familyId).order('date', { ascending: false }).limit(500),
  });
  const { data: cards, error: cardsError, refresh: refreshCards } = useRealtimeQuery<Card>({
    table: 'wallet_cards', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_cards').select('*').eq('family_id', familyId).eq('is_active', true).order('sort_order'),
  });
  const { data: passes, error: passesError, refresh: refreshPasses } = useRealtimeQuery<Pass>({
    table: 'wallet_passes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_passes').select('*').eq('family_id', familyId).eq('is_active', true).order('sort_order'),
  });
  const { data: rewards, error: rewardsError, refresh: refreshRewards } = useRealtimeQuery<Reward>({
    table: 'wallet_rewards', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wallet_rewards').select('*').eq('family_id', familyId).eq('is_active', true).order('sort_order'),
  });

  const [tab, setTab] = useState<Tab>('Accounts');
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState<AddKind>(null);
  const [txnSearch, setTxnSearch] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);

  const overview = useMemo(
    () => walletOverview(accounts, cards, rewards),
    [accounts, cards, rewards],
  );

  async function del(table: string, id: string, label: string) {
    if (!confirm(`Remove ${label}?`)) return;
    const res = await deleteWalletRowAction({ table, id });
    if (!res.ok) return toastError(res.error ?? 'Could not remove');
    success(t('walletHub.removed'));
    if (table === 'wallet_cards') refreshCards();
    else if (table === 'wallet_passes') refreshPasses();
    else if (table === 'wallet_rewards') refreshRewards();
    else if (table === 'financial_accounts') refreshAccounts();
    else refreshTxns();
  }

  const filteredTxns = useMemo(() => {
    const q = txnSearch.trim().toLowerCase();
    return !q ? txns : txns.filter((t) =>
      t.name.toLowerCase().includes(q) || (t.merchant?.toLowerCase().includes(q) ?? false) || (t.category?.toLowerCase().includes(q) ?? false));
  }, [txns, txnSearch]);

  const loading = la || lt;
  const primaryError = accountsError || txnsError;
  const secondaryErrors = [cardsError && 'Cards', passesError && 'Passes', rewardsError && 'Rewards'].filter(Boolean) as string[];

  if (primaryError && accounts.length === 0 && txns.length === 0) {
    return (
      <div className="module-page">
        <ErrorState message={t('walletHub.couldNotLoadYourWallet')} onRetry={() => { void Promise.all([refreshAccounts(), refreshTxns()]); }} />
      </div>
    );
  }

  return (
    <div className="module-page">
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><Wallet className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">{tr('wallet.myWallet')}</h1>
            <p className="mt-0.5 text-xs text-muted sm:text-sm">{tr('wallet.allYourMoneyCardsPassesAnd')}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative">
            <Button onClick={() => setAddOpen((v) => !v)}><Plus className="h-4 w-4" /> {tr('wallet.addToWallet')}</Button>
            {addOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setAddOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-glass">
                  {([['account', 'Account'], ['card', 'Card'], ['pass', 'Pass / Membership'], ['reward', 'Reward program'], ['transaction', 'Transaction']] as [AddKind, string][]).map(([k, label]) => (
                    <button key={k} onClick={() => { setAddOpen(false); setAdding(k); }} className="block w-full px-4 py-2 text-left text-sm hover:bg-surface">{label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
          <LinkButton href="/wallet/send"><Send className="h-4 w-4" /> {tr('wallet.sendMoney')}</LinkButton>
          <div className="relative">
            <Button variant="secondary" size="icon" aria-label={tr('wallet.more')} onClick={() => setMoreOpen((v) => !v)}><MoreHorizontal className="h-4 w-4" /></Button>
            {moreOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-elevated py-1 shadow-glass">
                  <Link href="/wallet/settings" className="block px-4 py-2 text-sm hover:bg-surface" onClick={() => setMoreOpen(false)}>{tr('wallet.walletSettings')}</Link>
                  <Link href="/wallet/activity" className="block px-4 py-2 text-sm hover:bg-surface" onClick={() => setMoreOpen(false)}>{tr('wallet.activity')}</Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {(primaryError || secondaryErrors.length > 0) && (
        <div role="status" aria-label={tr('wallet.walletDataHealth')} className="mb-4 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {tr('wallet.someWalletDataIsTemporarilyUnavailable')}{secondaryErrors.length > 0 ? `: ${secondaryErrors.join(', ')}` : '.'} {tr('wallet.refreshToTryAgain')}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        {/* MAIN */}
        <div className="min-w-0 space-y-6">
          {/* Overview */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold">{tr('wallet.walletOverview')}</h2>
              <button onClick={() => setTab('Transactions')} className="text-xs font-semibold text-brand-text">{tr('wallet.viewFullSummary')}</button>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard tint="from-violet-600/20 to-violet-600/5 text-violet-300" icon={Wallet} label={tr('wallet.totalBalance')} value={fmtUsd(overview.totalCents)} sub="Across all accounts" />
              <StatCard tint="from-blue-600/20 to-blue-600/5 text-blue-300" icon={Landmark} label={tr('wallet.cashAccounts')} value={fmtUsd(overview.accountsCents)} sub={`${overview.accountsCount} account${overview.accountsCount === 1 ? '' : 's'}`} />
              <StatCard tint="from-emerald-600/20 to-emerald-600/5 text-emerald-300" icon={CreditCard} label={tr('wallet.cards')} value={fmtUsd(overview.cardsCents)} sub={`${overview.cardsCount} card${overview.cardsCount === 1 ? '' : 's'}`} />
              <StatCard tint="from-amber-600/20 to-amber-600/5 text-amber-300" icon={Gift} label={tr('wallet.rewardsValue')} value={fmtUsd(overview.rewardsValueCents)} sub={`${fmtCount(overview.rewardsPoints)} points`} />
            </div>
          </section>

          {/* Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-border scrollbar-none">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={cn('relative shrink-0 px-3 py-2.5 text-sm font-medium transition',
                  tab === t ? 'text-brand-text' : 'text-muted hover:text-fg')}>
                {t}
                {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />}
              </button>
            ))}
          </div>

          {loading ? <SkeletonList /> : tab === 'Accounts' ? (
            <>
              <Panel title={tr('wallet.cashBankAccounts')} action={<button onClick={() => setAdding('account')} className="text-xs font-semibold text-brand-text">Add</button>}>
                {accounts.length === 0 ? (
                  <EmptyState icon={Landmark} title={tr('wallet.noAccountsYet')} description={t('walletHub.addACheckingSavingsOr')}
                    action={<Button onClick={() => setAdding('account')}><Plus className="h-4 w-4" /> {tr('wallet.addAccount')}</Button>} />
                ) : accounts.map((a) => {
                  const Icon = ACCOUNT_ICON[a.type] ?? Banknote;
                  const meta = ACCOUNT_KIND_META[a.type];
                  return (
                    <Row key={a.id} onDelete={() => del('financial_accounts', a.id, a.name)}>
                      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', meta?.tint ?? 'bg-elevated text-muted')}><Icon className="h-5 w-5" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{a.name}</p>
                        <p className="truncate text-xs text-muted">{a.institution ? `${a.institution} · ` : ''}{a.last_four ? `···· ${a.last_four}` : (meta?.label ?? a.type)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold tabular-nums text-emerald-400">{fmtDollars(a.balance)}</p>
                        <p className="text-[11px] text-muted">{t('walletHub.available')}</p>
                      </div>
                    </Row>
                  );
                })}
              </Panel>

              <Panel title={tr('wallet.recentTransactions')} action={<button onClick={() => setTab('Transactions')} className="text-xs font-semibold text-brand-text">{tr('wallet.viewAll')}</button>}>
                <TransactionList txns={txns.slice(0, 6)} onDelete={(t) => del('transactions', t.id, t.name)} />
              </Panel>
            </>
          ) : tab === 'Cards' ? (
            <Panel title={tr('wallet.myCards')} action={<button onClick={() => setAdding('card')} className="text-xs font-semibold text-brand-text">{tr('wallet.addCard')}</button>}>
              {cards.length === 0 ? <EmptyBlock label={tr('wallet.noCardsYet')} onAdd={() => setAdding('card')} addLabel="Add Card" /> : (
                <div className="grid gap-3 sm:grid-cols-2">{cards.map((c) => <CardRow key={c.id} card={c} onDelete={() => del('wallet_cards', c.id, c.name)} />)}</div>
              )}
            </Panel>
          ) : tab === 'Passes' ? (
            <Panel title={tr('wallet.passesMemberships')} action={<button onClick={() => setAdding('pass')} className="text-xs font-semibold text-brand-text">{tr('wallet.addPass')}</button>}>
              {passes.length === 0 ? <EmptyBlock label={tr('wallet.noPassesOrMembershipsYet')} onAdd={() => setAdding('pass')} addLabel="Add Pass" /> : passes.map((p) => (
                <Row key={p.id} onDelete={() => del('wallet_passes', p.id, p.name)}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-300"><Ticket className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{p.name}</p><p className="truncate text-xs text-muted">{[p.status, p.detail].filter(Boolean).join(' · ')}</p></div>
                </Row>
              ))}
            </Panel>
          ) : tab === 'Rewards' ? (
            <Panel title={tr('wallet.rewards')} action={<button onClick={() => setAdding('reward')} className="text-xs font-semibold text-brand-text">{tr('wallet.addProgram')}</button>}>
              {rewards.length === 0 ? <EmptyBlock label={tr('wallet.noRewardProgramsYet')} onAdd={() => setAdding('reward')} addLabel="Add Program" /> : rewards.map((r) => (
                <Row key={r.id} onDelete={() => del('wallet_rewards', r.id, r.name)}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-300"><Award className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{r.name}</p><p className="truncate text-xs text-muted">{fmtCount(r.balance)} {r.unit}{r.program ? ` · ${r.program}` : ''}</p></div>
                  <p className="text-sm font-bold tabular-nums">{fmtUsd(r.value_cents)}</p>
                </Row>
              ))}
            </Panel>
          ) : tab === 'Transactions' ? (
            <Panel title={tr('wallet.allTransactions')} action={
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input value={txnSearch} onChange={(e) => setTxnSearch(e.target.value)} placeholder={tr('wallet.search')}
                  className="h-8 w-40 rounded-lg border border-border bg-surface/60 pl-8 pr-2 text-xs outline-none focus:border-brand" />
              </div>}>
              <TransactionList txns={filteredTxns} onDelete={(t) => del('transactions', t.id, t.name)} emptyLabel={txnSearch ? 'No matching transactions.' : 'No transactions yet.'} />
            </Panel>
          ) : (
            // Documents
            <Panel title={tr('wallet.documents')}>
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated text-muted"><FolderLock className="h-6 w-6" /></span>
                <p className="text-sm text-muted">{tr('wallet.storeStatementsReceiptsAndWarrantiesIn')}</p>
                <LinkButton href="/dashboard/documents">{tr('wallet.openFiles')}</LinkButton>
              </div>
            </Panel>
          )}

          {/* Security footer */}
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-surface/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-400"><ShieldCheck className="h-5 w-5" /></span>
              <div>
                <p className="text-sm font-semibold">{tr('wallet.yourWalletSecureAmpPrivate')}</p>
                <p className="text-xs text-muted">{tr('wallet.weUseBankLevelEncryptionTo')}</p>
              </div>
            </div>
            <LinkButton href="/wallet/settings"><ShieldCheck className="h-4 w-4" /> {tr('wallet.securitySettings')}</LinkButton>
          </div>
        </div>

        {/* RIGHT RAIL */}
        <aside className="space-y-5">
          <RailCard title={tr('wallet.myCards')} onViewAll={() => setTab('Cards')}>
            {cards.length === 0 ? <RailEmpty label={tr('wallet.noCards')} /> : cards.slice(0, 4).map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className={cn('grid h-8 w-11 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white', CARD_TINT[c.brand] ?? CARD_TINT.other)}>{CARD_BRAND_LABEL[c.brand] ?? 'CARD'}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{c.name}</p><p className="text-[11px] text-muted">···· {c.last_four ?? '••••'}</p></div>
                <div className="text-right"><p className="text-sm font-bold tabular-nums">{fmtUsd(c.available_cents)}</p><p className="text-[10px] text-muted">{t('walletHub.available')}</p></div>
              </div>
            ))}
            <RailAdd label={tr('wallet.addCard')} onClick={() => setAdding('card')} />
          </RailCard>

          <RailCard title={tr('wallet.passesMemberships')} onViewAll={() => setTab('Passes')}>
            {passes.length === 0 ? <RailEmpty label={tr('wallet.noPasses')} /> : passes.slice(0, 3).map((p) => (
              <div key={p.id} className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated text-muted"><Ticket className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{p.name}</p><p className="truncate text-[11px] text-muted">{[p.status, p.detail].filter(Boolean).join(' · ')}</p></div>
              </div>
            ))}
            <RailAdd label={tr('wallet.addPass')} onClick={() => setAdding('pass')} />
          </RailCard>

          <RailCard title={tr('wallet.rewards')} onViewAll={() => setTab('Rewards')} viewAllLabel="View All">
            {rewards.length === 0 ? <RailEmpty label={tr('wallet.noRewards')} /> : rewards.slice(0, 3).map((r) => (
              <div key={r.id} className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-300"><Star className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{r.name}</p><p className="text-[11px] text-muted">{fmtCount(r.balance)} {r.unit}</p></div>
              </div>
            ))}
          </RailCard>
        </aside>
      </div>

      {/* Add modals */}
      {adding === 'account' && <AddAccountModal onClose={() => setAdding(null)} onDone={refreshAccounts} />}
      {adding === 'card' && <AddCardModal onClose={() => setAdding(null)} onDone={refreshCards} />}
      {adding === 'pass' && <AddPassModal onClose={() => setAdding(null)} onDone={refreshPasses} />}
      {adding === 'reward' && <AddRewardModal onClose={() => setAdding(null)} onDone={refreshRewards} />}
      {adding === 'transaction' && <AddTransactionModal accounts={accounts} onClose={() => setAdding(null)} onDone={refreshTxns} />}
    </div>
  );
}

// ── Presentational ──────────────────────────────────────────
function StatCard({ tint, icon: Icon, label, value, sub }: { tint: string; icon: typeof Wallet; label: string; value: string; sub: string }) {
  return (
    <div className={cn('rounded-2xl border border-border bg-gradient-to-br p-4', tint)}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{label}</p>
        <Icon className="h-4 w-4 opacity-80" />
      </div>
      <p className="text-lg font-black tabular-nums sm:text-xl">{value}</p>
      <p className="truncate text-[11px] text-muted">{sub}</p>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-semibold">{title}</h3>
        {action}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ children, onDelete }: { children: React.ReactNode; onDelete?: () => void }) {
  const tr = useTranslations();
  return (
    <div className="group flex items-center gap-3 rounded-xl px-1 py-2.5 hover:bg-elevated/40">
      {children}
      {onDelete && (
        <button onClick={onDelete} className="rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={tr('wallet.remove')}>
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function CardRow({ card, onDelete }: { card: Card; onDelete: () => void }) {
  const tr = useTranslations();
  return (
    <div className="group relative flex items-center gap-3 rounded-xl border border-border bg-elevated/40 p-3">
      <span className={cn('grid h-9 w-12 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white', CARD_TINT[card.brand] ?? CARD_TINT.other)}>{CARD_BRAND_LABEL[card.brand] ?? 'CARD'}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{card.name}</p>
        <p className="text-[11px] text-muted">···· {card.last_four ?? '••••'} · {card.kind}</p>
      </div>
      <div className="text-right"><p className="text-sm font-bold tabular-nums">{fmtUsd(card.available_cents)}</p><p className="text-[10px] text-muted">{tr('wallet.available')}</p></div>
      <button onClick={onDelete} className="absolute right-1 top-1 rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={tr('wallet.remove')}><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function TransactionList({ txns, onDelete, emptyLabel = 'No transactions yet.' }: { txns: Txn[]; onDelete: (t: Txn) => void; emptyLabel?: string }) {
  if (txns.length === 0) return <p className="py-6 text-center text-sm text-muted">{emptyLabel}</p>;
  return (
    <>
      {txns.map((t) => {
        const signed = txnSignedCents(t);
        const income = signed >= 0;
        return (
          <Row key={t.id} onDelete={() => onDelete(t)}>
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', income ? 'bg-emerald-500/15 text-emerald-400' : 'bg-elevated text-muted')}>
              {income ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t.merchant || t.name}</p>
              <p className="truncate text-xs text-muted">{fmtTxnDate(t.date)}{t.category ? ` · ${t.category}` : ''}</p>
            </div>
            <div className="text-right">
              <p className={cn('text-sm font-bold tabular-nums', income ? 'text-emerald-400' : 'text-fg')}>{fmtSignedUsd(signed)}</p>
              <p className={cn('text-[11px] capitalize', t.status === 'pending' ? 'text-amber-400' : 'text-muted')}>{t.status}</p>
            </div>
          </Row>
        );
      })}
    </>
  );
}

function RailCard({ title, children, onViewAll, viewAllLabel = 'View All' }: { title: string; children: React.ReactNode; onViewAll?: () => void; viewAllLabel?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        {onViewAll && <button onClick={onViewAll} className="text-xs font-semibold text-brand-text">{viewAllLabel}</button>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-5 text-sm font-semibold text-fg transition hover:bg-elevated/70">
      {children}
    </Link>
  );
}
function RailEmpty({ label }: { label: string }) { return <p className="py-2 text-center text-xs text-muted">{label}</p>; }
function RailAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-muted transition hover:border-brand/40 hover:text-brand-text"><Plus className="h-3.5 w-3.5" /> {label}</button>;
}
function EmptyBlock({ label, onAdd, addLabel }: { label: string; onAdd: () => void; addLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-elevated text-muted"><Sparkles className="h-6 w-6" /></span>
      <p className="text-sm text-muted">{label}</p>
      <Button onClick={onAdd}><Plus className="h-4 w-4" /> {addLabel}</Button>
    </div>
  );
}

// ── Add modals ──────────────────────────────────────────────
function useAddForm(action: (i: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>, onClose: () => void, onDone: () => void) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  async function submit(values: Record<string, unknown>) {
    setSaving(true);
    const res = await action(values);
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save');
    success(t('walletHub.addedToWallet'));
    onDone();
    onClose();
  }
  return { saving, submit };
}

function AddAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const tr = useTranslations();
  const { saving, submit } = useAddForm(addAccountAction, onClose, onDone);
  const [v, setV] = useState({ name: '', type: 'checking', institution: '', last_four: '', balance: '' });
  return (
    <Modal open onClose={onClose} title={tr('wallet.addAccount')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(v); }} className="space-y-4">
        <Field label={tr('wallet.accountName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('walletHub.familyChecking')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.type')}>{(id) => <Select id={id} value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>{['checking', 'savings', 'credit', 'investment', 'retirement'].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</Select>}</Field>
          <Field label={tr('wallet.last4')}>{(id) => <Input id={id} value={v.last_four} onChange={(e) => setV({ ...v, last_four: e.target.value })} maxLength={4} placeholder="3456" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.institution')} hint={t('walletHub.optional')}>{(id) => <Input id={id} value={v.institution} onChange={(e) => setV({ ...v, institution: e.target.value })} placeholder={t('walletHub.chase')} />}</Field>
          <Field label={tr('wallet.balance')}>{(id) => <Input id={id} type="number" step="0.01" value={v.balance} onChange={(e) => setV({ ...v, balance: e.target.value })} placeholder="2735.40" />}</Field>
        </div>
        <ModalFooter saving={saving} onClose={onClose} disabled={!v.name.trim()} />
      </form>
    </Modal>
  );
}

function AddCardModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const tr = useTranslations();
  const { saving, submit } = useAddForm(addCardAction, onClose, onDone);
  const [v, setV] = useState({ name: '', brand: 'visa', kind: 'credit', last_four: '', available: '', limit: '' });
  return (
    <Modal open onClose={onClose} title={tr('wallet.addCard')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(v); }} className="space-y-4">
        <Field label={tr('wallet.cardName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('walletHub.familyCreditCard')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.brand')}>{(id) => <Select id={id} value={v.brand} onChange={(e) => setV({ ...v, brand: e.target.value })}>{['visa', 'mastercard', 'amex', 'discover', 'other'].map((b) => <option key={b} value={b}>{CARD_BRAND_LABEL[b]}</option>)}</Select>}</Field>
          <Field label={tr('wallet.type')}>{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{['credit', 'debit', 'gas', 'store', 'prepaid', 'other'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('wallet.last4')}>{(id) => <Input id={id} value={v.last_four} onChange={(e) => setV({ ...v, last_four: e.target.value })} maxLength={4} placeholder="4242" />}</Field>
          <Field label={tr('wallet.available')}>{(id) => <Input id={id} type="number" step="0.01" value={v.available} onChange={(e) => setV({ ...v, available: e.target.value })} placeholder="1250" />}</Field>
          <Field label={tr('wallet.limit')} hint={t('walletHub.optional')}>{(id) => <Input id={id} type="number" step="0.01" value={v.limit} onChange={(e) => setV({ ...v, limit: e.target.value })} placeholder="5000" />}</Field>
        </div>
        <ModalFooter saving={saving} onClose={onClose} disabled={!v.name.trim()} />
      </form>
    </Modal>
  );
}

function AddPassModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const tr = useTranslations();
  const { saving, submit } = useAddForm(addPassAction, onClose, onDone);
  const [v, setV] = useState({ name: '', kind: 'membership', status: '', detail: '', member_no: '' });
  return (
    <Modal open onClose={onClose} title={tr('wallet.addPassMembership')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(v); }} className="space-y-4">
        <Field label={tr('wallet.name')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('walletHub.samSClub')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.kind')}>{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{['membership', 'loyalty', 'ticket', 'insurance', 'transit', 'other'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</Select>}</Field>
          <Field label={tr('wallet.status')} hint={t('walletHub.optional')}>{(id) => <Input id={id} value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })} placeholder={t('walletHub.member')} />}</Field>
        </div>
        <Field label={tr('wallet.detail')} hint={t('walletHub.eGExpiresDec31')}>{(id) => <Input id={id} value={v.detail} onChange={(e) => setV({ ...v, detail: e.target.value })} placeholder={t('walletHub.expiresDec312025')} />}</Field>
        <ModalFooter saving={saving} onClose={onClose} disabled={!v.name.trim()} />
      </form>
    </Modal>
  );
}

function AddRewardModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const tr = useTranslations();
  const { saving, submit } = useAddForm(addRewardAction, onClose, onDone);
  const [v, setV] = useState({ name: '', kind: 'points', balance: '', value: '', program: '' });
  return (
    <Modal open onClose={onClose} title={tr('wallet.addRewardProgram')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(v); }} className="space-y-4">
        <Field label={tr('wallet.programName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('walletHub.chaseUltimateRewards')} required autoFocus />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('wallet.kind')}>{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{['points', 'miles', 'cashback'].map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</Select>}</Field>
          <Field label={tr('wallet.balance')}>{(id) => <Input id={id} type="number" step="0.01" value={v.balance} onChange={(e) => setV({ ...v, balance: e.target.value })} placeholder="1250" />}</Field>
          <Field label={tr('wallet.value')}>{(id) => <Input id={id} type="number" step="0.01" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} placeholder="125" />}</Field>
        </div>
        <ModalFooter saving={saving} onClose={onClose} disabled={!v.name.trim()} />
      </form>
    </Modal>
  );
}

function AddTransactionModal({ accounts, onClose, onDone }: { accounts: Account[]; onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const tr = useTranslations();
  const { saving, submit } = useAddForm(addTransactionAction, onClose, onDone);
  const [v, setV] = useState({ name: '', merchant: '', amount: '', type: 'expense', status: 'posted', category: '', account_id: '', date: new Date().toISOString().slice(0, 10) });
  return (
    <Modal open onClose={onClose} title={tr('wallet.addTransaction')}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(v); }} className="space-y-4">
        <Field label={tr('wallet.description')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('walletHub.groceryStore')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.amount')}>{(id) => <Input id={id} type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} placeholder="87.65" required />}</Field>
          <Field label={tr('wallet.type')}>{(id) => <Select id={id} value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>{['expense', 'income', 'transfer'].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.status')}>{(id) => <Select id={id} value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{['posted', 'pending', 'cleared', 'scheduled'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select>}</Field>
          <Field label={tr('wallet.date')}>{(id) => <Input id={id} type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('wallet.category')} hint={t('walletHub.optional')}>{(id) => <Input id={id} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} placeholder={t('walletHub.groceries')} />}</Field>
          <Field label={tr('wallet.account')} hint={t('walletHub.optional')}>{(id) => <Select id={id} value={v.account_id} onChange={(e) => setV({ ...v, account_id: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        </div>
        <ModalFooter saving={saving} onClose={onClose} disabled={!v.name.trim() || !v.amount} />
      </form>
    </Modal>
  );
}

function ModalFooter({ saving, onClose, disabled }: { saving: boolean; onClose: () => void; disabled?: boolean }) {
  const tr = useTranslations();
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" onClick={onClose}>{tr('wallet.cancel')}</Button>
      <Button type="submit" loading={saving} disabled={disabled}>Add</Button>
    </div>
  );
}
