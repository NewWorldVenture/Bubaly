'use client';

import { useEffect, useState, useTransition } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, CheckCircle2, ChevronRight, Clock, CreditCard, Filter, MoreHorizontal, Plus, Sparkles, TrendingUp } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { LoadingBlock } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDate } from '@/lib/utils/format';
import { isAdmin } from '@/lib/constants/roles';
import { cn } from '@/lib/utils/cn';
import type { Tables, SubscriptionStatus } from '@/lib/database.types';

type Subscription = Tables<'subscriptions'>;

// ── Stripe helpers ──────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<SubscriptionStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; icon: React.ReactNode }> = {
  trialing: { label: 'Trial', tone: 'neutral', icon: <Clock className="h-4 w-4" /> },
  active: { label: 'Active', tone: 'success', icon: <CheckCircle2 className="h-4 w-4" /> },
  past_due: { label: 'Past due', tone: 'warning', icon: <AlertCircle className="h-4 w-4" /> },
  canceled: { label: 'Canceled', tone: 'neutral', icon: <AlertCircle className="h-4 w-4" /> },
  incomplete: { label: 'Incomplete', tone: 'warning', icon: <AlertCircle className="h-4 w-4" /> },
  incomplete_expired: { label: 'Expired', tone: 'danger', icon: <AlertCircle className="h-4 w-4" /> },
  unpaid: { label: 'Unpaid', tone: 'danger', icon: <AlertCircle className="h-4 w-4" /> },
};
const PLAN_LABELS: Record<string, { name: string; description: string; price: string }> = {
  free: { name: 'Free', description: 'Basic family coordination for up to 2 members.', price: '$0/mo' },
  family: { name: 'FamilyOS Family', description: 'Everything you need — unlimited members, AI assistant, and all modules.', price: '$9.99/mo' },
  family_annual: { name: 'FamilyOS Family (Annual)', description: 'Save 20% with an annual subscription.', price: '$95.99/yr' },
};
async function startCheckout(plan: 'family_monthly' | 'family_annual') {
  const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
  const json = await res.json(); if (json.url) window.location.href = json.url;
}
async function openPortal() {
  const res = await fetch('/api/billing/portal', { method: 'POST' });
  const json = await res.json(); if (json.url) window.location.href = json.url;
}

// ── Mock finance data ───────────────────────────────────────────────────────
const TABS = ['Overview', 'Transactions', 'Budgets', 'Bills', 'Savings Goals', 'Investments', 'Reports'] as const;
type Tab = (typeof TABS)[number];

const ACCOUNTS_MOCK = [
  { name: 'Chase Checking', sub: 'Checking ···4823', balance: 8432.15, color: 'bg-blue-500' },
  { name: 'Chase Savings', sub: 'Savings ···2941', balance: 24680.00, color: 'bg-emerald-500' },
  { name: 'Ally HYSA', sub: 'High-Yield ···7730', balance: 15200.50, color: 'bg-violet-500' },
  { name: 'Fidelity 401k', sub: 'Retirement ···1892', balance: 87340.22, color: 'bg-orange-500' },
];

const TRANSACTIONS_MOCK = [
  { icon: '🛒', name: 'Whole Foods Market', cat: 'Groceries', date: 'Today', amount: -127.43, type: 'expense' },
  { icon: '⛽', name: 'Shell Gas Station', cat: 'Auto & Gas', date: 'Today', amount: -62.10, type: 'expense' },
  { icon: '💰', name: 'Direct Deposit', cat: 'Salary', date: 'Yesterday', amount: 3250.00, type: 'income' },
  { icon: '📱', name: 'Netflix', cat: 'Subscriptions', date: 'May 12', amount: -22.99, type: 'expense' },
  { icon: '🏠', name: 'Mortgage Payment', cat: 'Housing', date: 'May 10', amount: -2140.00, type: 'expense' },
  { icon: '🍕', name: 'Domino\'s Pizza', cat: 'Dining Out', date: 'May 9', amount: -38.50, type: 'expense' },
  { icon: '💰', name: 'Freelance Income', cat: 'Side Income', date: 'May 8', amount: 850.00, type: 'income' },
  { icon: '💊', name: 'CVS Pharmacy', cat: 'Health', date: 'May 7', amount: -23.49, type: 'expense' },
];

const BUDGETS_MOCK = [
  { cat: 'Groceries', spent: 380, budget: 600, color: 'bg-emerald-500' },
  { cat: 'Dining Out', spent: 245, budget: 300, color: 'bg-orange-500' },
  { cat: 'Entertainment', spent: 89, budget: 150, color: 'bg-violet-500' },
  { cat: 'Gas', spent: 130, budget: 200, color: 'bg-blue-500' },
  { cat: 'Utilities', spent: 210, budget: 250, color: 'bg-rose-500' },
  { cat: 'Shopping', spent: 420, budget: 400, color: 'bg-yellow-500' },
];

const BILLS_MOCK = [
  { icon: '🏠', name: 'Mortgage', date: 'May 15', amount: 2140, status: 'upcoming' },
  { icon: '💡', name: 'Electric Bill', date: 'May 18', amount: 124, status: 'upcoming' },
  { icon: '🌐', name: 'Internet', date: 'May 20', amount: 79, status: 'upcoming' },
  { icon: '📱', name: 'Cell Phone', date: 'May 22', amount: 145, status: 'upcoming' },
];

const SAVINGS_GOALS = [
  { name: 'Family Vacation', emoji: '🏖️', target: 8000, saved: 5200, color: '#7c5dff' },
  { name: 'Emergency Fund', emoji: '🛡️', target: 20000, saved: 15200, color: '#34d399' },
  { name: 'New Car', emoji: '🚗', target: 35000, saved: 12400, color: '#60a5fa' },
];

const SPEND_BREAKDOWN = [
  { label: 'Housing', pct: 35, color: '#7c5dff' },
  { label: 'Groceries', pct: 18, color: '#34d399' },
  { label: 'Dining', pct: 12, color: '#fbbf24' },
  { label: 'Transport', pct: 10, color: '#60a5fa' },
  { label: 'Other', pct: 25, color: '#f87171' },
];

const MONTHLY_DATA = [
  { month: 'Oct', income: 5200, expense: 3800 },
  { month: 'Nov', income: 5400, expense: 4100 },
  { month: 'Dec', income: 6200, expense: 5200 },
  { month: 'Jan', income: 5100, expense: 3600 },
  { month: 'Feb', income: 5300, expense: 3900 },
  { month: 'Mar', income: 5600, expense: 4200 },
  { month: 'Apr', income: 5400, expense: 3700 },
  { month: 'May', income: 4100, expense: 2600 },
];

const MAX_BAR = 6500;

function fmtCurrency(n: number, showSign = false): string {
  const sign = showSign && n > 0 ? '+' : '';
  return sign + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
}

export function BillingModule() {
  const { familyId, role } = useApp();
  const admin = isAdmin(role);
  const [tab, setTab] = useState<Tab>('Overview');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const sb = createClient();
    sb.from('subscriptions').select('*').eq('family_id', familyId).maybeSingle()
      .then(({ data }) => { setSubscription(data); setSubLoading(false); });
  }, [familyId]);

  const totalBalance = ACCOUNTS_MOCK.reduce((s, a) => s + a.balance, 0);
  const income = 8100;
  const expenses = 4214;
  const netSavings = income - expenses;

  // Spending donut
  const circ = 251.2;
  let spendOff = 0;
  const spendArcs = SPEND_BREAKDOWN.map((s) => { const dash = (s.pct / 100) * circ; const arc = { dash, offset: circ - spendOff, color: s.color, label: s.label }; spendOff += dash; return arc; });

  const status = subscription?.status ?? 'trialing';
  const subConfig = STATUS_CONFIG[status];
  const plan = PLAN_LABELS[subscription?.plan ?? 'free'] ?? PLAN_LABELS.free;
  const hasActiveAccess = ['active', 'trialing'].includes(status);

  return (
    <div className="flex gap-6 xl:gap-8">
      <div className="min-w-0 flex-1 space-y-5">
        <div className="flex items-start justify-between">
          <div><h1 className="text-2xl font-bold">Finances</h1><p className="mt-1 text-sm text-white/55">Track spending, budgets, bills, and savings goals.</p></div>
          <button className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-4 py-2.5 text-sm font-bold shadow-glow"><Plus className="h-4 w-4" /> Add Transaction</button>
        </div>
        <div className="flex items-center justify-between border-b border-white/8">
          <div className="flex overflow-x-auto">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={cn('px-4 py-3 text-sm font-medium transition whitespace-nowrap', tab === t ? 'border-b-2 border-violet-400 text-white' : 'text-white/50 hover:text-white/80')}>{t}</button>)}</div>
          <div className="flex gap-2 pb-1 shrink-0">
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55"><Filter className="h-3 w-3" /> Filter</button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { icon: CreditCard, label: 'Total Balance', value: fmtCurrency(totalBalance), sub: 'Across all accounts', bg: 'bg-violet-600/20 text-violet-300', trend: null },
            { icon: ArrowDownLeft, label: 'Income', value: fmtCurrency(income), sub: 'This month', bg: 'bg-emerald-600/20 text-emerald-300', trend: '+12%' },
            { icon: ArrowUpRight, label: 'Expenses', value: fmtCurrency(expenses), sub: 'This month', bg: 'bg-rose-600/20 text-rose-300', trend: '-5%' },
            { icon: TrendingUp, label: 'Net Savings', value: fmtCurrency(netSavings), sub: 'This month', bg: 'bg-blue-600/20 text-blue-300', trend: '+8%' },
          ].map(({ icon: Icon, label, value, sub, bg, trend }) => (
            <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className={cn('mb-3 flex items-center justify-between')}>
                <div className={cn('grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
                {trend && <span className={cn('text-xs font-bold', trend.startsWith('+') ? 'text-emerald-400' : 'text-red-400')}>{trend}</span>}
              </div>
              <p className="text-xl font-black">{value}</p>
              <p className="text-sm font-semibold">{label}</p>
              <p className="text-xs text-white/40">{sub}</p>
            </div>
          ))}
        </div>

        {/* Income vs Expenses chart */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-semibold">Income vs Expenses</h2>
            <div className="flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" /> Income</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-400 inline-block" /> Expenses</span>
              <button className="text-white/40 hover:text-white/70">6 months</button>
            </div>
          </div>
          <div className="flex items-end gap-3 h-32">
            {MONTHLY_DATA.map(({ month, income: inc, expense: exp }) => (
              <div key={month} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="flex w-full items-end justify-center gap-0.5 flex-1">
                  <div className="w-1/2 rounded-t-sm bg-emerald-500/70" style={{ height: `${(inc / MAX_BAR) * 100}%` }} />
                  <div className="w-1/2 rounded-t-sm bg-rose-400/70" style={{ height: `${(exp / MAX_BAR) * 100}%` }} />
                </div>
                <span className="text-[10px] text-white/40">{month}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Transactions + Budgets */}
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Recent Transactions</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
            <div className="space-y-1">
              {TRANSACTIONS_MOCK.slice(0, 6).map((tx, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.03]">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-xl">{tx.icon}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{tx.name}</p>
                    <p className="text-xs text-white/40">{tx.cat} · {tx.date}</p>
                  </div>
                  <p className={cn('text-sm font-bold shrink-0', tx.type === 'income' ? 'text-emerald-400' : 'text-white')}>
                    {tx.type === 'income' ? '+' : ''}{fmtCurrency(tx.amount)}
                  </p>
                </div>
              ))}
            </div>
            <button className="mt-3 flex items-center gap-1 text-xs font-semibold text-violet-300">View all transactions <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Budget Overview</h2><button className="text-xs font-semibold text-violet-300">Manage budgets →</button></div>
            <div className="space-y-3.5">
              {BUDGETS_MOCK.map((b) => {
                const pct = Math.min((b.spent / b.budget) * 100, 100);
                const over = b.spent > b.budget;
                return (
                  <div key={b.cat}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="font-medium">{b.cat}</span>
                      <span className={cn('text-xs font-semibold', over ? 'text-red-400' : 'text-white/60')}>{fmtCurrency(b.spent)} / {fmtCurrency(b.budget)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-white/8">
                      <div className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : b.color)} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Savings Goals */}
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Savings Goals</h2><button className="text-xs font-semibold text-violet-300">View all goals →</button></div>
          <div className="grid gap-4 sm:grid-cols-3">
            {SAVINGS_GOALS.map((g) => {
              const pct = Math.min((g.saved / g.target) * 100, 100);
              return (
                <div key={g.name} className="rounded-xl border border-white/8 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-2xl">{g.emoji}</span>
                    <div><p className="font-semibold text-sm">{g.name}</p><p className="text-xs text-white/40">{pct.toFixed(0)}% saved</p></div>
                  </div>
                  <div className="mb-2 h-2 rounded-full bg-white/8"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: g.color }} /></div>
                  <div className="flex justify-between text-xs text-white/60">
                    <span>{fmtCurrency(g.saved)}</span>
                    <span>{fmtCurrency(g.target)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Stripe Subscription Section ────────────────────────────────── */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
          <div className="mb-4 flex items-center gap-3">
            <CreditCard className="h-5 w-5 text-violet-300" />
            <h2 className="font-semibold">FamilyOS Subscription</h2>
          </div>
          {subLoading ? <LoadingBlock /> : (
            <>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <p className="text-lg font-bold">{plan.name}</p>
                  <p className="mt-1 text-sm text-white/55">{plan.description}</p>
                  {subscription?.current_period_end && (
                    <p className="mt-2 text-sm text-white/40">
                      {['canceled', 'incomplete_expired'].includes(status) ? 'Access until' : 'Renews'} {fmtDate(subscription.current_period_end)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge tone={subConfig.tone as 'success' | 'warning' | 'danger' | 'neutral'}>
                    <span className="flex items-center gap-1">{subConfig.icon} {subConfig.label}</span>
                  </Badge>
                  {admin && subscription && (
                    <Button size="sm" variant="ghost" loading={pending} onClick={() => startTransition(() => void openPortal())}>Manage</Button>
                  )}
                </div>
              </div>
              {(!subscription || status === 'trialing' || status === 'canceled') && admin && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <p className="font-semibold">Monthly</p>
                    <p className="mt-1 text-2xl font-bold">$9.99<span className="text-sm font-normal text-white/40">/mo</span></p>
                    <Button className="mt-3 w-full" loading={pending} onClick={() => startTransition(() => void startCheckout('family_monthly'))}>Get started</Button>
                  </div>
                  <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
                    <div className="flex items-center justify-between"><p className="font-semibold">Annual</p><Badge tone="success">Save 20%</Badge></div>
                    <p className="mt-1 text-2xl font-bold">$7.99<span className="text-sm font-normal text-white/40">/mo</span></p>
                    <Button className="mt-3 w-full" loading={pending} onClick={() => startTransition(() => void startCheckout('family_annual'))}>Get annual</Button>
                  </div>
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {['Unlimited family members', 'AI family assistant', 'All modules', 'Real-time sync', 'Document vault', 'Meal planning', 'School & sports', 'Priority support'].map((f) => (
                  <div key={f} className="flex items-center gap-2 text-xs text-white/65">
                    <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', hasActiveAccess ? 'text-emerald-400' : 'text-white/25')} />{f}
                  </div>
                ))}
              </div>
              {!admin && <p className="mt-4 text-center text-sm text-white/40">Contact your family admin to manage billing.</p>}
            </>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <aside className="hidden w-72 shrink-0 space-y-5 xl:block">
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Accounts</h2><button className="text-xs font-semibold text-violet-300">Manage →</button></div>
          <div className="space-y-3">
            {ACCOUNTS_MOCK.map((a) => (
              <div key={a.name} className="flex items-center gap-3">
                <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white text-sm font-black', a.color + '/20')}>
                  <div className={cn('h-3 w-3 rounded-full', a.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{a.name}</p>
                  <p className="text-xs text-white/40">{a.sub}</p>
                </div>
                <p className="text-sm font-bold shrink-0">{fmtCurrency(a.balance)}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-white/8 pt-3 flex items-center justify-between">
            <span className="text-sm text-white/60">Total</span>
            <span className="text-sm font-black">{fmtCurrency(totalBalance)}</span>
          </div>
          <button className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-xs font-semibold text-white/60 hover:text-white/80"><Plus className="h-3.5 w-3.5" /> Add Account</button>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <h2 className="mb-4 font-semibold">Spending Breakdown</h2>
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
                {spendArcs.map((a, i) => a.dash > 0 && <circle key={i} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="14" strokeDasharray={`${a.dash} ${circ}`} strokeDashoffset={a.offset} />)}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-lg font-black">May</span><span className="text-[9px] text-white/40">2024</span></div>
            </div>
            <div className="space-y-1.5">
              {SPEND_BREAKDOWN.map(({ label, pct, color }) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="flex-1 text-white/60">{label}</span><span className="font-bold">{pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming Bills</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
          <div className="space-y-3">
            {BILLS_MOCK.map((b) => (
              <div key={b.name} className="flex items-center gap-3">
                <span className="text-xl">{b.icon}</span>
                <div className="flex-1"><p className="text-sm font-semibold">{b.name}</p><p className="text-xs text-white/40">Due {b.date}</p></div>
                <p className="text-sm font-bold shrink-0">{fmtCurrency(b.amount)}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-white/8 pt-3 flex justify-between text-sm">
            <span className="text-white/60">Total Due</span>
            <span className="font-black">{fmtCurrency(BILLS_MOCK.reduce((s, b) => s + b.amount, 0))}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-violet-600/20"><Sparkles className="h-6 w-6 text-violet-300" /></div>
          <h3 className="font-bold">AI Financial Advisor</h3>
          <p className="mt-2 text-xs leading-5 text-white/55">Get personalized budgeting tips and financial insights.</p>
          <button className="mt-4 w-full rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 py-2.5 text-sm font-bold shadow-glow">Ask AI</button>
        </div>
      </aside>
    </div>
  );
}