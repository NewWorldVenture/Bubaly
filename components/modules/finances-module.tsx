'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  Plus, Link2, MoreHorizontal, Wallet, PiggyBank, CreditCard, TrendingUp, Landmark,
  ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, ChevronRight, Lightbulb,
  Home, ShoppingCart, Car, UtensilsCrossed, Zap, Baby, Film, ShoppingBag, Tv,
  HeartPulse, Shield, GraduationCap, DollarSign, Repeat, Sparkles, ArrowRight, type LucideIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import type { Tables, TransactionType, AccountType } from '@/lib/database.types';

type Account = Tables<'financial_accounts'>;
type Txn = Tables<'transactions'>;
type Budget = Tables<'budgets'>;
type Bill = Tables<'bills'>;
type Goal = Tables<'savings_goals'>;

const CATEGORY_META: Record<string, { color: string; icon: LucideIcon }> = {
  Housing: { color: '#7c5cff', icon: Home },
  Groceries: { color: '#22c55e', icon: ShoppingCart },
  Transportation: { color: '#f59e0b', icon: Car },
  'Dining Out': { color: '#ec4899', icon: UtensilsCrossed },
  Dining: { color: '#ec4899', icon: UtensilsCrossed },
  Utilities: { color: '#3b82f6', icon: Zap },
  Kids: { color: '#06b6d4', icon: Baby },
  Entertainment: { color: '#a855f7', icon: Film },
  Shopping: { color: '#f97316', icon: ShoppingBag },
  Subscriptions: { color: '#eab308', icon: Tv },
  Healthcare: { color: '#ef4444', icon: HeartPulse },
  Insurance: { color: '#14b8a6', icon: Shield },
  Education: { color: '#8b5cf6', icon: GraduationCap },
  Income: { color: '#22c55e', icon: DollarSign },
  Transfer: { color: '#64748b', icon: Repeat },
};
const OTHER_COLOR = '#94a3b8';
function catMeta(cat: string | null) { return CATEGORY_META[cat ?? ''] ?? { color: OTHER_COLOR, icon: DollarSign }; }

const ACCOUNT_ICON: Record<string, LucideIcon> = {
  checking: Wallet, savings: PiggyBank, credit: CreditCard, investment: TrendingUp, retirement: Landmark,
};
const ACCOUNT_TINT: Record<string, string> = {
  checking: 'bg-brand/20 text-brand-text', savings: 'bg-green-500/20 text-green-400',
  credit: 'bg-amber-500/20 text-amber-400', investment: 'bg-blue-500/20 text-blue-400',
  retirement: 'bg-teal-500/20 text-teal-400',
};

const CATEGORIES = ['Groceries', 'Dining Out', 'Housing', 'Transportation', 'Utilities', 'Kids', 'Entertainment', 'Shopping', 'Subscriptions', 'Healthcare', 'Insurance', 'Education', 'Income', 'Transfer'];

const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const usd0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function shortDate(s: string) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

const MANAGE = '/dashboard/billing?view=manage';

export function FinancesModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const selfId = selfMember?.id ?? null;

  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  const { data: accounts, loading: la, error: accountsError, refresh: refreshAccounts } = useRealtimeQuery<Account>({
    table: 'financial_accounts', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('financial_accounts').select('*').eq('family_id', familyId).order('created_at'),
  });
  const { data: txns, loading: lt, error: txnsError, refresh: refreshTxns } = useRealtimeQuery<Txn>({
    table: 'transactions', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('transactions').select('*').eq('family_id', familyId).order('date', { ascending: false }).limit(500),
  });
  const { data: budgets, loading: lb, error: budgetsError, refresh: refreshBudgets } = useRealtimeQuery<Budget>({
    table: 'budgets', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('budgets').select('*').eq('family_id', familyId),
  });
  const { data: bills, loading: lbi, error: billsError, refresh: refreshBills } = useRealtimeQuery<Bill>({
    table: 'bills', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('bills').select('*').eq('family_id', familyId).order('due_date'),
  });
  const { data: goals, loading: lg, error: goalsError, refresh: refreshGoals } = useRealtimeQuery<Goal>({
    table: 'savings_goals', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('savings_goals').select('*').eq('family_id', familyId).order('created_at'),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const now = new Date();
  const monthStartStr = ymd(new Date(now.getFullYear(), now.getMonth(), 1));

  const monthTxns = useMemo(() => txns.filter((t) => t.date >= monthStartStr), [txns, monthStartStr]);
  const income = useMemo(() => monthTxns.filter((t) => t.type === 'income').reduce((s, t) => s + num(t.amount), 0), [monthTxns]);
  const expenses = useMemo(() => monthTxns.filter((t) => t.type === 'expense').reduce((s, t) => s + num(t.amount), 0), [monthTxns]);
  const totalBalance = useMemo(() => accounts.reduce((s, a) => s + num(a.balance), 0), [accounts]);
  const savingsBalance = useMemo(() => {
    const sav = accounts.filter((a) => a.type === 'savings').reduce((s, a) => s + num(a.balance), 0);
    return sav > 0 ? sav : goals.reduce((s, g) => s + num(g.current_amount), 0);
  }, [accounts, goals]);
  const netThisMonth = income - expenses;

  // Budget & Spending — this month's expenses by category.
  const spendByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of monthTxns) if (t.type === 'expense') map.set(t.category ?? 'Other', (map.get(t.category ?? 'Other') ?? 0) + num(t.amount));
    const rows = [...map.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
    const top = rows.slice(0, 7);
    const rest = rows.slice(7).reduce((s, r) => s + r.total, 0);
    if (rest > 0) top.push({ category: 'Other', total: rest });
    return top;
  }, [monthTxns]);
  const donutStops = useMemo(() => {
    const total = spendByCat.reduce((s, r) => s + r.total, 0) || 1;
    let acc = 0;
    return spendByCat.map((r) => {
      const start = (acc / total) * 100; acc += r.total; const end = (acc / total) * 100;
      const color = r.category === 'Other' ? OTHER_COLOR : catMeta(r.category).color;
      return `${color} ${start}% ${end}%`;
    }).join(', ');
  }, [spendByCat]);
  const budgetTotal = useMemo(() => budgets.reduce((s, b) => s + num(b.amount), 0), [budgets]);
  const budgetPct = budgetTotal > 0 ? Math.round((expenses / budgetTotal) * 100) : 0;

  const recent = txns.slice(0, 8);

  const upcomingBills = useMemo(
    () => bills.filter((b) => b.status !== 'paid').sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5),
    [bills],
  );

  // Spending by person (this month expenses).
  const byPerson = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of monthTxns) if (t.type === 'expense' && t.member_id) map.set(t.member_id, (map.get(t.member_id) ?? 0) + num(t.amount));
    const rows = [...map.entries()].map(([id, amount]) => ({ member: memberById.get(id), amount })).filter((r) => r.member);
    rows.sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, r) => s + r.amount, 0) || 1;
    const max = rows[0]?.amount || 1;
    return rows.slice(0, 6).map((r) => ({ ...r, pct: Math.round((r.amount / total) * 100), bar: Math.round((r.amount / max) * 100) }));
  }, [monthTxns, memberById]);

  // Money tip — real: biggest category this month.
  const tip = useMemo(() => {
    if (spendByCat.length === 0) return 'Add a few transactions to unlock spending insights.';
    const top = spendByCat.find((r) => r.category !== 'Other') ?? spendByCat[0];
    return `Your biggest category this month is ${top.category} at ${usd(top.total)}. Set a budget to stay on track.`;
  }, [spendByCat]);

  const loading = la || lt || lb || lbi || lg;
  const readError = accountsError || txnsError || budgetsError || billsError || goalsError;
  if (loading) return <SkeletonList count={6} />;
  if (readError) return <ErrorState message="Could not load financial data. Refresh and try again." onRetry={() => { void refreshAccounts(); void refreshTxns(); void refreshBudgets(); void refreshBills(); void refreshGoals(); }} />;

  const STATS = [
    { label: 'Total Balance', value: usd(totalBalance), sub: netThisMonth >= 0 ? `${usd(Math.abs(netThisMonth))} this month` : `${usd(Math.abs(netThisMonth))} this month`, up: netThisMonth >= 0, icon: Wallet, tint: 'bg-brand text-brand-fg' },
    { label: 'Income', value: usd(income), sub: 'This month', up: true, icon: ArrowDownToLine, tint: 'bg-green-500 text-white' },
    { label: 'Expenses', value: usd(expenses), sub: 'This month', up: false, icon: ArrowUpRight, tint: 'bg-rose-500 text-white' },
    { label: 'Savings', value: usd(savingsBalance), sub: 'Set aside', up: true, icon: PiggyBank, tint: 'bg-blue-500 text-white' },
  ];

  return (
    <div className="module-with-sidebar">
      <div className="module-main overflow-y-auto">
        <PageHeader
          title="Finances"
          description="Stay on top of your family's money, budgets, and goals."
          action={
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Transaction</Button>
              <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}><Link2 className="h-4 w-4" /> Link Account</Button>
              <div className="relative">
                <Button variant="outline" size="sm" onClick={() => setMoreOpen((v) => !v)} aria-label="More"><MoreHorizontal className="h-4 w-4" /> More</Button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                    <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-border bg-elevated p-1 shadow-lg">
                      <Link href={MANAGE} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface">Manage budgets, bills &amp; reports</Link>
                      <Link href={MANAGE} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface">Plan &amp; subscription</Link>
                      <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"><AiInsight kind="billing" /> AI insight</div>
                    </div>
                  </>
                )}
              </div>
            </div>
          }
        />

        {/* Financial Copilot — the schedule↔money timeline (deepens the linkage). */}
        <Link
          href="/dashboard/money-timeline"
          className="mb-4 flex items-center gap-3 rounded-2xl border border-brand/30 bg-gradient-to-r from-brand/[0.12] to-transparent p-4 transition hover:border-brand/50"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 ring-1 ring-brand/30">
            <Sparkles className="h-5 w-5 text-brand-text" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold">Financial Copilot</span>
            <span className="block text-xs text-muted">See bills, goals &amp; your calendar on one money timeline — get ahead of heavy weeks.</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-brand-text" />
        </Link>

        {/* Overview stat tiles */}
        <div className="rounded-2xl border border-border bg-surface/30 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Overview</h2>
            <Link href={MANAGE} className="text-xs font-medium text-brand-text hover:underline">View full report ›</Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="rounded-xl border border-border bg-bg/40 p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="text-xs text-muted">{s.label}</p>
                    <p className="mt-1 text-2xl font-bold tracking-tight">{s.value}</p>
                    <p className={cn('mt-1 flex items-center gap-1 text-[11px]', s.up ? 'text-green-400' : 'text-muted')}>
                      {s.label === 'Total Balance' && (s.up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3 rotate-90" />)}{s.sub}
                    </p>
                  </div>
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-full', s.tint)}><s.icon className="h-5 w-5" /></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Budget & Spending + Recent Transactions */}
        <div className="mt-4 grid gap-4 lg:grid-cols-5">
          {/* Budget & Spending */}
          <div className="rounded-2xl border border-border bg-surface/30 p-4 lg:col-span-3">
            <h2 className="mb-3 text-base font-semibold">Budget &amp; Spending</h2>
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <div className="relative h-44 w-44 shrink-0">
                <div className="h-44 w-44 rounded-full" style={{ background: spendByCat.length ? `conic-gradient(${donutStops})` : 'var(--elevated,#2a2a33)' }} />
                <div className="absolute inset-[26px] grid place-items-center rounded-full bg-surface text-center">
                  <span className="text-lg font-bold">{usd(expenses)}</span>
                  <span className="text-[10px] text-muted">Total Spent</span>
                </div>
              </div>
              <div className="w-full space-y-1.5">
                {spendByCat.length === 0 ? <p className="text-xs text-muted">No spending yet this month.</p> : spendByCat.map((r) => {
                  const total = spendByCat.reduce((s, x) => s + x.total, 0) || 1;
                  const meta = r.category === 'Other' ? { color: OTHER_COLOR, icon: MoreHorizontal } : catMeta(r.category);
                  const Icon = meta.icon;
                  return (
                    <div key={r.category} className="flex items-center gap-2 text-sm">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md" style={{ backgroundColor: `${meta.color}22`, color: meta.color }}><Icon className="h-3.5 w-3.5" /></span>
                      <span className="flex-1 truncate text-muted">{r.category}</span>
                      <span className="font-medium">{usd(r.total)}</span>
                      <span className="w-9 text-right text-[11px] text-muted">{Math.round((r.total / total) * 100)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">Budget Progress</span>
                <span className="text-muted">{budgetPct}%</span>
              </div>
              <p className="text-xs text-muted">{usd(expenses)} of {usd(budgetTotal)}</p>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-elevated">
                <div className={cn('h-full rounded-full', budgetPct > 100 ? 'bg-danger' : 'bg-green-500')} style={{ width: `${Math.min(100, budgetPct)}%` }} />
              </div>
              <p className={cn('mt-1 text-xs font-medium', budgetPct > 100 ? 'text-danger' : 'text-green-400')}>
                {budgetPct > 100 ? 'Over budget' : 'You’re on track! 🎉'}
              </p>
            </div>
          </div>

          {/* Recent Transactions */}
          <div className="rounded-2xl border border-border bg-surface/30 p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Recent Transactions</h2>
              <Link href={MANAGE} className="text-xs font-medium text-brand-text hover:underline">View all ›</Link>
            </div>
            {recent.length === 0 ? <p className="text-xs text-muted">No transactions yet.</p> : (
              <div className="space-y-1">
                {recent.map((t) => {
                  const meta = catMeta(t.category);
                  const Icon = meta.icon;
                  const inc = t.type === 'income';
                  return (
                    <div key={t.id} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${meta.color}22`, color: meta.color }}><Icon className="h-4 w-4" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{t.name}</p>
                        <p className="truncate text-[11px] text-muted">{t.category ?? '—'}</p>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted">{shortDate(t.date)}</span>
                      <span className={cn('w-20 shrink-0 text-right text-sm font-semibold', inc ? 'text-green-400' : 'text-fg')}>
                        {inc ? '+' : '-'}{usd(num(t.amount))}
                      </span>
                      <Check className="h-4 w-4 shrink-0 text-muted/50" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Bills & Reminders + Spending by Person */}
        <div className="mt-4 grid gap-4 lg:grid-cols-5">
          {/* Bills & Reminders */}
          <div className="rounded-2xl border border-border bg-surface/30 p-4 lg:col-span-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Bills &amp; Reminders</h2>
              <Link href="/dashboard/calendar" className="text-xs font-medium text-brand-text hover:underline">View calendar ›</Link>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <BillsCalendar month={calMonth} bills={bills} onPrev={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} onNext={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} />
              <div>
                <p className="mb-2 text-sm font-semibold">Upcoming Bills</p>
                {upcomingBills.length === 0 ? <p className="text-xs text-muted">No upcoming bills.</p> : (
                  <div className="space-y-2">
                    {upcomingBills.map((b) => {
                      const meta = catMeta(b.category);
                      const Icon = meta.icon;
                      return (
                        <div key={b.id} className="flex items-center gap-2.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ backgroundColor: `${meta.color}22`, color: meta.color }}><Icon className="h-4 w-4" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{b.name}</p>
                            <p className={cn('text-[11px]', b.status === 'overdue' ? 'text-danger' : 'text-muted')}>{b.status === 'overdue' ? 'Overdue · ' : 'Due '}{shortDate(b.due_date)}</p>
                          </div>
                          <span className="shrink-0 text-sm font-semibold">{usd(num(b.amount))}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-muted">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand" /> Bill Due</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" /> Paid</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Upcoming</span>
                </div>
              </div>
            </div>
          </div>

          {/* Spending by Person */}
          <div className="rounded-2xl border border-border bg-surface/30 p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Spending by Person</h2>
              <span className="rounded-lg bg-elevated px-2 py-0.5 text-[11px] text-muted">This Month</span>
            </div>
            {byPerson.length === 0 ? <p className="text-xs text-muted">No attributed spending this month.</p> : (
              <div className="space-y-3">
                {byPerson.map(({ member, amount, pct, bar }) => member && (
                  <div key={member.id} className="flex items-center gap-2.5">
                    <Avatar name={member.display_name} color={member.color} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-xs font-medium">{member.display_name}{member.id === selfId ? ' (You)' : ''}</span>
                        <span className="text-xs font-semibold">{usd(amount)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-elevated">
                          <div className="h-full rounded-full" style={{ width: `${bar}%`, backgroundColor: member.color ?? '#7c5cff' }} />
                        </div>
                        <span className="w-8 text-right text-[10px] text-muted">{pct}%</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Link href={MANAGE} className="mt-3 block text-center text-xs font-medium text-brand-text hover:underline">View full breakdown ›</Link>
          </div>
        </div>

        {/* Money Tip */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-brand/5 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500/20 text-amber-400"><Lightbulb className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Money Tip</p>
            <p className="text-xs text-muted">{tip}</p>
          </div>
          <Link href={MANAGE} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-elevated">View Insights</Link>
        </div>
      </div>

      {/* Right rail */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* Accounts */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold">Accounts</h3>
            <Link href={MANAGE} className="text-[11px] font-medium text-brand-text hover:underline">View all ›</Link>
          </div>
          {accounts.length === 0 ? (
            <div className="text-center">
              <p className="text-xs text-muted">No accounts linked yet.</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setLinkOpen(true)}><Link2 className="h-4 w-4" /> Link Account</Button>
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => {
                const Icon = ACCOUNT_ICON[a.type] ?? Wallet;
                const bal = num(a.balance);
                return (
                  <div key={a.id} className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-bg/40 p-2.5">
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', ACCOUNT_TINT[a.type] ?? 'bg-elevated text-muted')}><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{a.name}</p>
                      {a.last_four && <p className="text-[11px] text-muted">•••• {a.last_four}</p>}
                    </div>
                    <span className={cn('shrink-0 text-sm font-bold', bal < 0 && 'text-danger')}>{usd(bal)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Savings Goals */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold">Savings Goals</h3>
            <Link href={MANAGE} className="text-[11px] font-medium text-brand-text hover:underline">View all ›</Link>
          </div>
          {goals.length === 0 ? <p className="text-xs text-muted">No savings goals yet.</p> : (
            <div className="space-y-3">
              {goals.map((g) => {
                const cur = num(g.current_amount), tgt = num(g.target_amount) || 1;
                const pct = Math.min(100, Math.round((cur / tgt) * 100));
                return (
                  <div key={g.id} className="flex items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-base">{g.emoji ?? '🎯'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-xs font-semibold">{g.name}</span>
                        <span className="text-xs font-bold">{pct}%</span>
                      </div>
                      <p className="text-[10px] text-muted">{usd0(cur)} of {usd0(tgt)}</p>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {addOpen && (
        <AddTransactionModal familyId={familyId} userId={userId} selfId={selfId} accounts={accounts} members={members}
          onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void refreshTxns(); success('Transaction added'); }}
          onError={toastError} />
      )}
      {linkOpen && (
        <LinkAccountModal familyId={familyId} userId={userId}
          onClose={() => setLinkOpen(false)} onSaved={() => { setLinkOpen(false); void refreshAccounts(); success('Account linked'); }}
          onError={toastError} />
      )}
    </div>
  );
}

function BillsCalendar({ month, bills, onPrev, onNext }: { month: Date; bills: Bill[]; onPrev: () => void; onNext: () => void }) {
  const y = month.getFullYear(), m = month.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startOffset = (new Date(y, m, 1).getDay());
  const today = new Date(); const todayStr = ymd(today);
  const statusByDay = useMemo(() => {
    const map = new Map<number, string>();
    for (const b of bills) {
      const [by, bm, bd] = b.due_date.split('-').map(Number);
      if (by === y && bm - 1 === m) {
        const prev = map.get(bd);
        // overdue wins, then upcoming, then paid
        const rank = (s: string) => (s === 'overdue' ? 0 : s === 'upcoming' ? 1 : 2);
        if (prev === undefined || rank(b.status) < rank(prev)) map.set(bd, b.status);
      }
    }
    return map;
  }, [bills, y, m]);
  const dotColor = (s: string) => (s === 'overdue' ? 'bg-amber-500' : s === 'paid' ? 'bg-green-500' : 'bg-brand');
  const cells: (number | null)[] = [...Array(startOffset).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button onClick={onPrev} aria-label="Previous month" className="rounded p-1 hover:bg-elevated"><ChevronLeft className="h-3.5 w-3.5" /></button>
        <span className="text-sm font-semibold">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button onClick={onNext} aria-label="Next month" className="rounded p-1 hover:bg-elevated"><ChevronRight className="h-3.5 w-3.5" /></button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="py-1 text-[10px] font-semibold text-muted">{d}</div>)}
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const isToday = ymd(new Date(y, m, d)) === todayStr;
          const status = statusByDay.get(d);
          return (
            <div key={i} className="flex flex-col items-center py-1">
              <span className={cn('grid h-6 w-6 place-items-center rounded-full text-xs', isToday ? 'bg-brand font-bold text-brand-fg' : 'text-fg')}>{d}</span>
              {status ? <span className={cn('mt-0.5 h-1.5 w-1.5 rounded-full', dotColor(status))} /> : <span className="mt-0.5 h-1.5 w-1.5" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddTransactionModal({ familyId, userId, selfId, accounts, members, onClose, onSaved, onError }: {
  familyId: string; userId: string; selfId: string | null; accounts: Account[];
  members: ReturnType<typeof useApp>['members']; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    const amount = Number(f.get('amount'));
    if (!name) return onError('Add a description');
    if (!amount || amount <= 0) return onError('Enter a valid amount');
    setLoading(true);
    const { error } = await createClient().from('transactions').insert({
      family_id: familyId, created_by: userId,
      name, amount,
      type: String(f.get('type') ?? 'expense') as TransactionType,
      category: String(f.get('category') ?? '') || null,
      date: String(f.get('date') ?? '') || new Date().toISOString().slice(0, 10),
      account_id: String(f.get('account_id') ?? '') || null,
      member_id: String(f.get('member_id') ?? '') || null,
    });
    setLoading(false);
    if (error) return onError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Add Transaction" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Description" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Whole Foods Market" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" required>{(id) => <Input id={id} name="amount" type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00" />}</Field>
          <Field label="Type">{(id) => <Select id={id} name="type" defaultValue="expense"><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) => <Select id={id} name="category"><option value="">—</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
          <Field label="Date">{(id) => <Input id={id} name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Account">{(id) => <Select id={id} name="account_id"><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="Person">{(id) => <Select id={id} name="member_id" defaultValue={selfId ?? ''}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add Transaction</Button>
        </div>
      </form>
    </Modal>
  );
}

function LinkAccountModal({ familyId, userId, onClose, onSaved, onError }: {
  familyId: string; userId: string; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return onError('Name the account');
    setLoading(true);
    const { error } = await createClient().from('financial_accounts').insert({
      family_id: familyId, created_by: userId, name,
      type: String(f.get('type') ?? 'checking') as AccountType,
      institution: String(f.get('institution') ?? '') || null,
      last_four: String(f.get('last_four') ?? '') || null,
      balance: Number(f.get('balance')) || 0,
      currency: 'USD',
    });
    setLoading(false);
    if (error) return onError(describeDbError(error));
    onSaved();
  }
  return (
    <Modal open title="Link Account" description="Add an account to track balances and spending." onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Account name" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Joint Checking" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(id) => <Select id={id} name="type" defaultValue="checking"><option value="checking">Checking</option><option value="savings">Savings</option><option value="credit">Credit</option><option value="investment">Investment</option><option value="retirement">Retirement</option></Select>}</Field>
          <Field label="Balance">{(id) => <Input id={id} name="balance" type="number" inputMode="decimal" step="0.01" placeholder="0.00" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Institution" hint="Optional">{(id) => <Input id={id} name="institution" placeholder="Chase" />}</Field>
          <Field label="Last 4" hint="Optional">{(id) => <Input id={id} name="last_four" maxLength={4} placeholder="4567" />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Link Account</Button>
        </div>
      </form>
    </Modal>
  );
}

