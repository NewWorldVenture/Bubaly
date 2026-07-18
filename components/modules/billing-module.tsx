'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  DollarSign,
  Filter,
  Landmark,
  Lightbulb,
  Link2,
  PiggyBank,
  Plus,
  Receipt,
  Sparkles,
  Target,
  Trash2,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/app/page-header';
import { Avatar } from '@/components/ui/avatar';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { isAdmin } from '@/lib/constants/roles';
import { BASIC_MONTHLY_CENTS, BASIC_ANNUAL_CENTS, PLUS_MONTHLY_CENTS, PLUS_ANNUAL_CENTS } from '@/lib/constants/plans';
import {
  classifyChange, slugToStripePlan, stripePlanFor, annualSavingsPct,
  CHANGE_LABELS, type StripePlan, type BillingInterval, type PlanChange,
} from '@/lib/billing/plans';
import { cn } from '@/lib/utils/cn';
import type { Tables, SubscriptionStatus, AccountType, TransactionType, BudgetPeriod, BillStatus } from '@/lib/database.types';

type FinancialAccount = Tables<'financial_accounts'>;
type Transaction = Tables<'transactions'>;
type Budget = Tables<'budgets'>;
type Bill = Tables<'bills'>;
type SavingsGoal = Tables<'savings_goals'>;
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
  free: { name: 'Bubaly Free', description: 'The default family organizer for up to 5 members.', price: '$0/mo' },
  basic: { name: 'Family Basic', description: 'Everything a busy household needs — unlimited members, chores, meals, and unlimited AI.', price: '$9.99/mo' },
  basic_annual: { name: 'Family Basic (Annual)', description: 'The Family Basic plan billed yearly.', price: '$99.99/yr' },
  plus: { name: 'Family+', description: 'The AI Family Chief of Staff — concierge, briefings, and command center.', price: '$24.99/mo' },
  plus_annual: { name: 'Family+ (Annual)', description: 'The Family+ plan billed yearly.', price: '$249.99/yr' },
  // Legacy slugs map to Basic.
  family: { name: 'Family Basic', description: 'Everything a busy household needs.', price: '$9.99/mo' },
  family_annual: { name: 'Family Basic (Annual)', description: 'Family Basic billed yearly.', price: '$99.99/yr' },
};

async function openPortal() {
  const res = await fetch('/api/billing/portal', { method: 'POST' });
  const json = await res.json(); if (json.url) window.location.href = json.url;
}

const fmtUsd = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

const TIER_DEFS = [
  {
    level: 1 as const, name: 'Family Basic', featured: false,
    monthlyCents: BASIC_MONTHLY_CENTS, annualCents: BASIC_ANNUAL_CENTS,
    features: ['Unlimited members', 'Chores, meals & grocery planning', 'School & sports hubs', 'Unlimited AI assistant', 'Smart Imports & Kitchen Display'],
  },
  {
    level: 2 as const, name: 'Family+', featured: true,
    monthlyCents: PLUS_MONTHLY_CENTS, annualCents: PLUS_ANNUAL_CENTS,
    features: ['Everything in Basic', 'AI Concierge & daily briefings', 'AI School & Sports assistant', 'Family Command Center', 'Priority support'],
  },
];

/**
 * World-class plan manager: a monthly/annual toggle + a card per tier whose
 * action button is computed from the family's current plan (Choose / Current /
 * Upgrade / Downgrade / Switch billing). One tap calls the in-place change-plan
 * flow (prorated) or Checkout when on Free.
 */
function PlanManager({
  currentSlug, highlight, pending, onChoose,
}: {
  currentSlug: string | null;
  highlight?: number;
  pending: boolean;
  onChoose: (plan: StripePlan) => void;
}) {
  const [interval, setInterval] = useState<BillingInterval>('annual');
  const annual = interval === 'annual';
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight]);

  return (
    <div ref={ref} className="space-y-3 scroll-mt-20">
      {highlight ? (
        <div className="rounded-xl border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
          <span className="font-semibold">{highlight === 2 ? 'Family+' : 'Family Basic'}</span> unlocks the feature you tapped — pick a billing period below.
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-surface/60 p-1 text-xs">
          <button onClick={() => setInterval('monthly')} className={cn('rounded-full px-3 py-1 font-semibold transition', !annual ? 'bg-brand text-white' : 'text-muted')}>Monthly</button>
          <button onClick={() => setInterval('annual')} className={cn('rounded-full px-3 py-1 font-semibold transition', annual ? 'bg-brand text-white' : 'text-muted')}>Yearly</button>
        </div>
        {annual && <Badge tone="success">Save up to {Math.max(annualSavingsPct(1), annualSavingsPct(2))}%</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TIER_DEFS.map((t) => {
          const plan = stripePlanFor(t.level, interval);
          const change: PlanChange = classifyChange(currentSlug, plan);
          const perMonth = annual ? Math.round(t.annualCents / 12) : t.monthlyCents;
          const sub = annual ? `${fmtUsd(t.annualCents)}/yr · save ${annualSavingsPct(t.level)}%` : 'billed monthly';
          const isCurrent = change === 'current';
          return (
            <div key={t.name} className={cn('rounded-xl border p-4', t.featured ? 'border-brand/40 bg-brand/5' : 'border-border bg-surface/40', highlight === t.level && 'ring-2 ring-brand ring-offset-2 ring-offset-bg')}>
              <div className="flex items-center justify-between">
                <p className="font-semibold">{t.name}</p>
                {isCurrent ? <Badge tone="success">Current</Badge> : t.featured && <Badge tone="brand">Most popular</Badge>}
              </div>
              <p className="mt-1 text-2xl font-bold">{fmtUsd(perMonth)}<span className="text-sm font-normal text-muted">/mo</span></p>
              <p className="text-xs text-muted">{sub}</p>
              <Button
                className="mt-3 w-full"
                variant={change === 'downgrade' ? 'secondary' : 'primary'}
                loading={pending}
                disabled={isCurrent}
                onClick={() => onChoose(plan)}
              >
                {isCurrent ? 'Current plan' : change === 'new' ? `Choose ${t.name}` : CHANGE_LABELS[change]}
                {change === 'switch_interval' ? ` to ${annual ? 'annual' : 'monthly'}` : ''}
              </Button>
              <ul className="mt-3 space-y-1.5">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />{f}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Transactions', 'Budgets', 'Bills', 'Savings Goals', 'Reports'] as const;
type Tab = (typeof TABS)[number];

// ── Helpers ─────────────────────────────────────────────────────────────────
function fmtCurrency(n: number, showSign = false): string {
  const sign = showSign && n > 0 ? '+' : '';
  return sign + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(n));
}

const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  checking: 'bg-blue-500',
  savings: 'bg-emerald-500',
  credit: 'bg-rose-500',
  investment: 'bg-violet-500',
  retirement: 'bg-orange-500',
};

const CATEGORY_COLORS: Record<string, string> = {
  Housing: '#7c5dff',
  Groceries: '#34d399',
  Dining: '#fbbf24',
  Transport: '#60a5fa',
  Utilities: '#f87171',
  Entertainment: '#a78bfa',
  Health: '#fb923c',
  Shopping: '#f472b6',
  Subscriptions: '#38bdf8',
  Other: '#94a3b8',
};

function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.Other;
}

/** Age in whole years from an ISO birthday, or null if unknown/invalid. */
function memberAge(birthday: string | null): number | null {
  if (!birthday) return null;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

const EXPENSE_CATEGORIES = [
  'Housing', 'Groceries', 'Dining', 'Transport', 'Utilities',
  'Entertainment', 'Health', 'Shopping', 'Subscriptions', 'Insurance',
  'Education', 'Auto & Gas', 'Personal Care', 'Gifts', 'Other',
];

// ── CRUD Modals ─────────────────────────────────────────────────────────────

function AddAccountModal({ open, onClose, familyId, userId, onDone }: {
  open: boolean; onClose: () => void; familyId: string; userId: string; onDone: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [institution, setInstitution] = useState('');
  const [lastFour, setLastFour] = useState('');
  const [balance, setBalance] = useState('');

  function reset() { setName(''); setType('checking'); setInstitution(''); setLastFour(''); setBalance(''); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('financial_accounts').insert({
      family_id: familyId, created_by: userId,
      name: name.trim(), type, institution: institution.trim() || null,
      last_four: lastFour.trim() || null, balance: parseFloat(balance) || 0, currency: 'USD',
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Account added');
    reset(); onClose(); onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Account">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Account Name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chase Checking" required />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit">Credit Card</option>
            <option value="investment">Investment</option>
            <option value="retirement">Retirement</option>
          </Select>
        )}</Field>
        <Field label="Institution">{(id) => <Input id={id} value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="e.g. Chase, Ally, Fidelity" />}</Field>
        <Field label="Last 4 Digits">{(id) => <Input id={id} value={lastFour} onChange={(e) => setLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4823" maxLength={4} />}</Field>
        <Field label="Current Balance" required>{(id) => <Input id={id} type="number" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" required />}</Field>
        <Button type="submit" className="w-full" loading={saving}>Add Account</Button>
      </form>
    </Modal>
  );
}

function AddTransactionModal({ open, onClose, familyId, userId, accounts, onDone }: {
  open: boolean; onClose: () => void; familyId: string; userId: string; accounts: FinancialAccount[]; onDone: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Other');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<'expense' | 'income' | 'transfer'>('expense');
  const [accountId, setAccountId] = useState('');

  function reset() { setName(''); setAmount(''); setCategory('Other'); setDate(new Date().toISOString().slice(0, 10)); setType('expense'); setAccountId(''); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !amount) return;
    setSaving(true);
    const parsedAmount = parseFloat(amount);
    const finalAmount = type === 'expense' ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
    const supabase = createClient();
    const { error } = await supabase.from('transactions').insert({
      family_id: familyId, created_by: userId,
      name: name.trim(), amount: finalAmount, category, date, type,
      account_id: accountId || null, notes: null,
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Transaction added');
    reset(); onClose(); onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Transaction">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Whole Foods Market" required />}</Field>
        <Field label="Amount" required>{(id) => <Input id={id} type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value as 'expense' | 'income' | 'transfer')}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </Select>
        )}</Field>
        <Field label="Category">{(id) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}</Field>
        <Field label="Date" required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
        {accounts.length > 0 && (
          <Field label="Account">{(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">None</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          )}</Field>
        )}
        <Button type="submit" className="w-full" loading={saving}>Add Transaction</Button>
      </form>
    </Modal>
  );
}

function AddBudgetModal({ open, onClose, familyId, userId, onDone }: {
  open: boolean; onClose: () => void; familyId: string; userId: string; onDone: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [category, setCategory] = useState('Groceries');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');

  function reset() { setCategory('Groceries'); setAmount(''); setPeriod('monthly'); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!amount) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('budgets').insert({
      family_id: familyId, created_by: userId,
      category, amount: parseFloat(amount), period,
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Budget added');
    reset(); onClose(); onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Budget">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Category" required>{(id) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}</Field>
        <Field label="Budget Amount" required>{(id) => <Input id={id} type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500.00" required />}</Field>
        <Field label="Period">{(id) => (
          <Select id={id} value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </Select>
        )}</Field>
        <Button type="submit" className="w-full" loading={saving}>Add Budget</Button>
      </form>
    </Modal>
  );
}

function AddBillModal({ open, onClose, familyId, userId, onDone }: {
  open: boolean; onClose: () => void; familyId: string; userId: string; onDone: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrence, setRecurrence] = useState('monthly');
  const [category, setCategory] = useState('Other');

  function reset() { setName(''); setAmount(''); setDueDate(''); setIsRecurring(false); setRecurrence('monthly'); setCategory('Other'); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !amount || !dueDate) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('bills').insert({
      family_id: familyId, created_by: userId,
      name: name.trim(), amount: parseFloat(amount), due_date: dueDate,
      is_recurring: isRecurring, recurrence: isRecurring ? recurrence : null,
      status: 'upcoming', category,
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Bill added');
    reset(); onClose(); onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Bill">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Bill Name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mortgage" required />}</Field>
        <Field label="Amount" required>{(id) => <Input id={id} type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />}</Field>
        <Field label="Due Date" required>{(id) => <Input id={id} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />}</Field>
        <Field label="Category">{(id) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        )}</Field>
        <div className="flex items-center gap-3">
          <input type="checkbox" id="recurring" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} className="h-4 w-4 rounded border-border" />
          <label htmlFor="recurring" className="text-sm font-medium">Recurring</label>
        </div>
        {isRecurring && (
          <Field label="Recurrence">{(id) => (
            <Select id={id} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </Select>
          )}</Field>
        )}
        <Button type="submit" className="w-full" loading={saving}>Add Bill</Button>
      </form>
    </Modal>
  );
}

function AddSavingsGoalModal({ open, onClose, familyId, userId, onDone }: {
  open: boolean; onClose: () => void; familyId: string; userId: string; onDone: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currentAmount, setCurrentAmount] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [emoji, setEmoji] = useState('🎯');

  function reset() { setName(''); setTargetAmount(''); setCurrentAmount(''); setTargetDate(''); setEmoji('🎯'); }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !targetAmount) return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('savings_goals').insert({
      family_id: familyId, created_by: userId,
      name: name.trim(), target_amount: parseFloat(targetAmount),
      current_amount: parseFloat(currentAmount) || 0,
      target_date: targetDate || null, emoji,
    });
    setSaving(false);
    if (error) return toastError(describeDbError(error));
    success('Savings goal added');
    reset(); onClose(); onDone();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Savings Goal">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Goal Name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Family Vacation" required />}</Field>
        <Field label="Emoji">{(id) => <Input id={id} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🎯" />}</Field>
        <Field label="Target Amount" required>{(id) => <Input id={id} type="number" step="0.01" min="0.01" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="5000.00" required />}</Field>
        <Field label="Saved So Far">{(id) => <Input id={id} type="number" step="0.01" min="0" value={currentAmount} onChange={(e) => setCurrentAmount(e.target.value)} placeholder="0.00" />}</Field>
        <Field label="Target Date">{(id) => <Input id={id} type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />}</Field>
        <Button type="submit" className="w-full" loading={saving}>Add Goal</Button>
      </form>
    </Modal>
  );
}

// ── Main Module ─────────────────────────────────────────────────────────────

export function BillingModule({ serviceFeeNotice = null }: { serviceFeeNotice?: string | null } = {}) {
  const { familyId, userId, role, members } = useApp();
  const admin = isAdmin(role);
  const { success, error: toastError } = useToast();
  const search = useSearchParams();
  const wantsUpgrade = search.get('upgrade') === '1';
  // `?checkout=basic|plus` (from the demo upgrade flow) pre-selects a tier and
  // opens Stripe Checkout automatically once the family + subscription load, so a
  // visitor who already chose a plan in the demo doesn't have to pick it again.
  const checkoutTier = search.get('checkout');
  const checkoutLevel: 1 | 2 | undefined = checkoutTier === 'plus' ? 2 : checkoutTier === 'basic' ? 1 : undefined;
  const needLevel = checkoutLevel ?? (search.get('need') === '2' ? 2 : wantsUpgrade ? 1 : undefined);
  const [tab, setTab] = useState<Tab>('Overview');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [pending, startTransition] = useTransition();

  // Modal state
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddTransaction, setShowAddTransaction] = useState(false);
  const [showAddBudget, setShowAddBudget] = useState(false);
  const [showAddBill, setShowAddBill] = useState(false);
  const [showAddGoal, setShowAddGoal] = useState(false);

  // ── Data queries ────────────────────────────────────────────────────────
  const { data: accounts, loading: accLoading, error: accError, refresh: refreshAccounts } = useRealtimeQuery<FinancialAccount>({
    table: 'financial_accounts',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('financial_accounts').select('*').eq('family_id', familyId).order('name'),
  });

  const { data: transactions, loading: txLoading, error: txError, refresh: refreshTransactions } = useRealtimeQuery<Transaction>({
    table: 'transactions',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('transactions').select('*').eq('family_id', familyId).order('date', { ascending: false }),
  });

  const { data: budgets, loading: budLoading, error: budError, refresh: refreshBudgets } = useRealtimeQuery<Budget>({
    table: 'budgets',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('budgets').select('*').eq('family_id', familyId).order('category'),
  });

  const { data: bills, loading: billLoading, error: billError, refresh: refreshBills } = useRealtimeQuery<Bill>({
    table: 'bills',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('bills').select('*').eq('family_id', familyId).order('due_date'),
  });

  const { data: savingsGoals, loading: goalLoading, error: goalError, refresh: refreshGoals } = useRealtimeQuery<SavingsGoal>({
    table: 'savings_goals',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('savings_goals').select('*').eq('family_id', familyId).order('name'),
  });

  // ── Stripe subscription (live: realtime + after self-serve changes) ──────
  const loadSub = useCallback(async () => {
    const sb = createClient();
    const { data } = await sb.from('subscriptions').select('*').eq('family_id', familyId).maybeSingle();
    setSubscription(data);
    setSubLoading(false);
  }, [familyId]);

  useEffect(() => {
    void loadSub();
    const sb = createClient();
    const channel = sb
      .channel(`subscription:${familyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'subscriptions', filter: `family_id=eq.${familyId}` }, () => { void loadSub(); })
      .subscribe();
    return () => { void sb.removeChannel(channel); };
  }, [familyId, loadSub]);

  // Self-serve plan change (upgrade / downgrade / switch interval). Updates the
  // live Stripe subscription in place, or redirects to Checkout when on Free.
  const changePlan = useCallback((plan: StripePlan) => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/change-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
        const json = await res.json();
        if (!res.ok) { toastError(json.error ?? 'Could not change the plan.'); return; }
        if (json.url) { window.location.href = json.url; return; }       // Free → Checkout
        if (json.changed) { success('Plan updated. Your next invoice is prorated.'); }
        else if (json.message) { success(json.message); }
        await loadSub();
      } catch { toastError('Could not change the plan.'); }
    });
  }, [loadSub, success, toastError]);

  // One-tap checkout from the demo upgrade flow: if `?checkout=basic|plus` is
  // present and the family is still on Free, open Stripe Checkout for that tier
  // automatically (monthly to start; they can switch to annual later). Fires once,
  // only for admins (non-admins can't purchase), only after the subscription loads.
  const autoCheckoutFired = useRef(false);
  useEffect(() => {
    if (autoCheckoutFired.current) return;
    if (!checkoutLevel || subLoading) return;
    if (!admin) return;
    // Only when there's no paid plan yet — never re-charge an already-subscribed family.
    if (slugToStripePlan(subscription?.plan) !== null) return;
    autoCheckoutFired.current = true;
    changePlan(stripePlanFor(checkoutLevel, 'monthly'));
  }, [checkoutLevel, subLoading, admin, subscription, changePlan]);

  // Schedule a downgrade to Free at period end, or undo it.
  const setCancel = useCallback((resume: boolean) => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/billing/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume }) });
        const json = await res.json();
        if (!res.ok) { toastError(json.error ?? 'Could not update the subscription.'); return; }
        success(resume ? 'Your plan will continue.' : 'Your plan will end at the period’s end.');
        await loadSub();
      } catch { toastError('Could not update the subscription.'); }
    });
  }, [loadSub, success, toastError]);

  // ── Computed values ─────────────────────────────────────────────────────
  const totalBalance = useMemo(() => accounts.reduce((s, a) => s + (a.balance ?? 0), 0), [accounts]);

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const currentMonthTransactions = useMemo(() =>
    transactions.filter((tx) => {
      const d = new Date(tx.date);
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    }),
    [transactions, currentMonth, currentYear],
  );

  const income = useMemo(() =>
    currentMonthTransactions.filter((tx) => tx.type === 'income').reduce((s, tx) => s + Math.abs(tx.amount), 0),
    [currentMonthTransactions],
  );

  const expenses = useMemo(() =>
    currentMonthTransactions.filter((tx) => tx.type === 'expense').reduce((s, tx) => s + Math.abs(tx.amount), 0),
    [currentMonthTransactions],
  );

  const netSavings = income - expenses;

  const spendBreakdown = useMemo(() => {
    const byCategory: Record<string, number> = {};
    currentMonthTransactions
      .filter((tx) => tx.type === 'expense')
      .forEach((tx) => {
        const cat = tx.category || 'Other';
        byCategory[cat] = (byCategory[cat] ?? 0) + Math.abs(tx.amount);
      });
    const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    return Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([label, amt]) => ({ label, pct: Math.round((amt / total) * 100), color: categoryColor(label) }));
  }, [currentMonthTransactions]);

  // Budget progress: compute spent per category from current month transactions
  const budgetProgress = useMemo(() => {
    const spentByCategory: Record<string, number> = {};
    currentMonthTransactions
      .filter((tx) => tx.type === 'expense')
      .forEach((tx) => {
        const cat = tx.category || 'Other';
        spentByCategory[cat] = (spentByCategory[cat] ?? 0) + Math.abs(tx.amount);
      });
    return budgets.map((b) => ({
      ...b,
      spent: spentByCategory[b.category] ?? 0,
    }));
  }, [budgets, currentMonthTransactions]);

  // Upcoming bills
  const upcomingBills = useMemo(() =>
    bills.filter((b) => b.status === 'upcoming' || new Date(b.due_date) >= now).slice(0, 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bills],
  );

  const circ = 251.2;

  // Full category breakdown WITH dollar amounts (Budget & Spending panel).
  const spendByCategory = useMemo(() => {
    const byCategory: Record<string, number> = {};
    currentMonthTransactions
      .filter((tx) => tx.type === 'expense')
      .forEach((tx) => {
        const cat = tx.category || 'Other';
        byCategory[cat] = (byCategory[cat] ?? 0) + Math.abs(tx.amount);
      });
    const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    return Object.entries(byCategory)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([label, amount]) => ({ label, amount, pct: Math.round((amount / total) * 100), color: categoryColor(label) }));
  }, [currentMonthTransactions]);

  // Big donut arcs (Budget & Spending) from the amount-bearing breakdown.
  const bigArcs = useMemo(() => {
    let offset = 0;
    return spendByCategory.map((s) => {
      const dash = (s.pct / 100) * circ;
      const arc = { dash, offset: circ - offset, color: s.color, key: s.label };
      offset += dash;
      return arc;
    });
  }, [spendByCategory]);

  // Budget Progress: total monthly budget vs total spent this month.
  const totalMonthlyBudget = useMemo(
    () => budgets.reduce((s, b) => s + (b.period === 'yearly' ? b.amount / 12 : b.period === 'weekly' ? b.amount * 4.33 : b.amount), 0),
    [budgets],
  );
  const budgetPct = totalMonthlyBudget > 0 ? Math.min(Math.round((expenses / totalMonthlyBudget) * 100), 999) : 0;

  // Spending by Person: this-month expenses grouped by the member who logged
  // them (transactions.created_by → family_members.user_id).
  const spendingByPerson = useMemo(() => {
    const byUser: Record<string, number> = {};
    currentMonthTransactions
      .filter((tx) => tx.type === 'expense' && tx.created_by)
      .forEach((tx) => { byUser[tx.created_by as string] = (byUser[tx.created_by as string] ?? 0) + Math.abs(tx.amount); });
    const total = Object.values(byUser).reduce((s, v) => s + v, 0);
    if (total === 0) return [];
    return Object.entries(byUser)
      .map(([uid, amount]) => {
        const m = members.find((mm) => mm.user_id === uid);
        return {
          uid,
          name: m?.display_name ?? 'Someone',
          color: m?.color ?? null,
          age: memberAge(m?.birthday ?? null),
          isSelf: uid === userId,
          amount,
          pct: Math.round((amount / total) * 100),
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [currentMonthTransactions, members, userId]);

  // Month-over-month expense delta → the "Money Tip" banner.
  const lastMonthExpenses = useMemo(() => {
    const d = new Date(currentYear, currentMonth - 1, 1);
    return transactions
      .filter((tx) => tx.type === 'expense' && new Date(tx.date).getMonth() === d.getMonth() && new Date(tx.date).getFullYear() === d.getFullYear())
      .reduce((s, tx) => s + Math.abs(tx.amount), 0);
  }, [transactions, currentMonth, currentYear]);
  const spendDeltaPct = lastMonthExpenses > 0 ? Math.round(((expenses - lastMonthExpenses) / lastMonthExpenses) * 100) : 0;

  // Mini calendar for Bills & Reminders: cells for the current month, each
  // carrying any bills due that day (colored by status).
  const calendar = useMemo(() => {
    const first = new Date(currentYear, currentMonth, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const billsByDay: Record<number, Bill[]> = {};
    bills.forEach((b) => {
      const d = new Date(b.due_date);
      if (d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
        (billsByDay[d.getDate()] ??= []).push(b);
      }
    });
    const cells: ({ day: number; bills: Bill[] } | null)[] = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push({ day, bills: billsByDay[day] ?? [] });
    return cells;
  }, [bills, currentMonth, currentYear]);
  const todayDate = now.getDate();

  function billDotColor(b: Bill): string {
    if (b.status === 'paid') return 'bg-emerald-500';
    if (b.status === 'overdue') return 'bg-rose-500';
    return new Date(b.due_date) > now ? 'bg-amber-500' : 'bg-brand';
  }

  // ── CRUD helpers ────────────────────────────────────────────────────────
  async function deleteTransaction(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('transactions').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Transaction removed');
    void refreshTransactions();
  }

  async function deleteBudget(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('budgets').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Budget removed');
    void refreshBudgets();
  }

  async function deleteBill(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('bills').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Bill removed');
    void refreshBills();
  }

  async function markBillPaid(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('bills').update({ status: 'paid' }).eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Bill marked as paid');
    void refreshBills();
  }

  async function deleteGoal(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('savings_goals').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Goal removed');
    void refreshGoals();
  }

  async function deleteAccount(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('financial_accounts').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Account removed');
    void refreshAccounts();
  }

  function refreshAll() {
    void refreshAccounts();
    void refreshTransactions();
    void refreshBudgets();
    void refreshBills();
    void refreshGoals();
  }

  // ── Loading / Error states ──────────────────────────────────────────────
  const anyLoading = accLoading || txLoading || budLoading || billLoading || goalLoading;
  const anyError = accError || txError || budError || billError || goalError;

  const status = subscription?.status ?? 'trialing';
  const subConfig = STATUS_CONFIG[status];
  const plan = PLAN_LABELS[subscription?.plan ?? 'free'] ?? PLAN_LABELS.free;
  const hasActiveAccess = ['active', 'trialing'].includes(status);
  // A live paid plan (drives the Cancel control) + whether a cancel is scheduled.
  const hasPaidPlan = slugToStripePlan(subscription?.plan) !== null && ['active', 'trialing', 'past_due'].includes(status);
  const subCanceling = Boolean(subscription?.cancel_at_period_end) && hasPaidPlan;

  if (anyLoading) return <SkeletonList />;
  if (anyError) return <ErrorState message={anyError} onRetry={refreshAll} />;

  // ── Render helpers ──────────────────────────────────────────────────────
  const renderOverview = () => (
    <>
      {/* Overview */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Overview</h2>
          <button onClick={() => setTab('Reports')} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">View full report <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { icon: Wallet, label: 'Total Balance', value: fmtCurrency(totalBalance), circle: 'bg-violet-600',
              foot: (
                <span className={cn('flex items-center gap-1 font-medium', netSavings >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                  {netSavings >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                  {fmtCurrency(Math.abs(netSavings))} this month
                </span>
              ) },
            { icon: ArrowDownLeft, label: 'Income', value: fmtCurrency(income), circle: 'bg-emerald-500', foot: <span className="text-muted">This month</span> },
            { icon: ArrowUpRight, label: 'Expenses', value: fmtCurrency(expenses), circle: 'bg-rose-500', foot: <span className="text-muted">This month</span> },
            { icon: PiggyBank, label: 'Savings', value: fmtCurrency(netSavings), circle: 'bg-blue-500', foot: <span className="text-muted">This month</span> },
          ].map(({ icon: Icon, label, value, circle, foot }) => (
            <div key={label} className="rounded-xl border border-border bg-bg/40 p-3 sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium text-muted">{label}</p>
                <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full text-white sm:h-10 sm:w-10', circle)}><Icon className="h-4 w-4 sm:h-5 sm:w-5" /></div>
              </div>
              <p className="mt-1.5 text-lg font-black tabular-nums sm:text-2xl">{value}</p>
              <p className="mt-0.5 truncate text-xs">{foot}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Budget & Spending + Recent Transactions */}
      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        {/* Budget & Spending */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Budget &amp; Spending</h2>
          {spendByCategory.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">No spending recorded this month. Add a transaction to see your breakdown.</p>
          ) : (
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="relative mx-auto h-40 w-40 shrink-0">
                <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                  {bigArcs.map((a) => a.dash > 0 && (
                    <circle key={a.key} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="12"
                      strokeDasharray={`${a.dash} ${circ}`} strokeDashoffset={a.offset} strokeLinecap="butt" />
                  ))}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-black tabular-nums">{fmtCurrency(expenses)}</span>
                  <span className="text-[10px] text-muted">Total Spent</span>
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {spendByCategory.map((s) => (
                  <div key={s.label} className="flex items-center gap-2.5 text-sm">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="flex-1 truncate text-muted">{s.label}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{fmtCurrency(s.amount)}</span>
                    <span className="w-8 shrink-0 text-right text-xs text-muted tabular-nums">{s.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Budget Progress */}
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-semibold">Budget Progress</p>
              <span className="text-xs font-semibold text-muted tabular-nums">{totalMonthlyBudget > 0 ? `${budgetPct}%` : '—'}</span>
            </div>
            {totalMonthlyBudget > 0 ? (
              <>
                <p className="mb-2 text-xs text-muted tabular-nums">{fmtCurrency(expenses)} of {fmtCurrency(totalMonthlyBudget)}</p>
                <div className="h-2.5 rounded-full bg-border">
                  <div className={cn('h-full rounded-full transition-all', budgetPct > 100 ? 'bg-rose-500' : 'bg-emerald-500')} style={{ width: `${Math.min(budgetPct, 100)}%` }} />
                </div>
                <p className={cn('mt-2 text-xs font-medium', budgetPct > 100 ? 'text-rose-400' : 'text-emerald-400')}>
                  {budgetPct > 100 ? `Over budget by ${fmtCurrency(expenses - totalMonthlyBudget)}` : "You're on track! 🎉"}
                </p>
              </>
            ) : (
              <button onClick={() => setTab('Budgets')} className="text-xs font-semibold text-brand-text hover:underline">Set a monthly budget →</button>
            )}
          </div>
        </div>

        {/* Recent Transactions */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Recent Transactions</h2>
            <button onClick={() => setTab('Transactions')} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">View all <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          {transactions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No transactions yet.</p>
          ) : (
            <div className="space-y-0.5">
              {transactions.slice(0, 8).map((tx) => (
                <div key={tx.id} className="flex items-center gap-3 rounded-xl px-1.5 py-2 hover:bg-bg/40">
                  <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', tx.type === 'income' ? 'bg-emerald-500/15' : 'bg-bg/60')}
                    style={tx.type !== 'income' ? { background: `${categoryColor(tx.category || 'Other')}22` } : undefined}>
                    {tx.type === 'income'
                      ? <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
                      : <span className="h-2.5 w-2.5 rounded-full" style={{ background: categoryColor(tx.category || 'Other') }} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{tx.name}</p>
                    <p className="truncate text-xs text-muted">{tx.category || 'Other'}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn('text-sm font-bold tabular-nums', tx.type === 'income' ? 'text-emerald-400' : 'text-fg')}>
                      {tx.type === 'income' ? '+' : '-'}{fmtCurrency(Math.abs(tx.amount))}
                    </p>
                    <p className="text-[11px] text-muted">{fmtDate(tx.date)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bills & Reminders + Spending by Person */}
      <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        {/* Bills & Reminders */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Bills &amp; Reminders</h2>
            <button onClick={() => setTab('Bills')} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">View calendar <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {/* Mini calendar */}
            <div>
              <p className="mb-2 text-center text-sm font-semibold">{now.toLocaleString('default', { month: 'long', year: 'numeric' })}</p>
              <div className="grid grid-cols-7 gap-y-1 text-center text-[10px] text-muted">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, idx) => <span key={idx}>{d}</span>)}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-y-1 text-center text-xs">
                {calendar.map((cell, idx) => (
                  <div key={idx} className="flex flex-col items-center gap-0.5 py-0.5">
                    {cell ? (
                      <>
                        <span className={cn('grid h-6 w-6 place-items-center rounded-full tabular-nums',
                          cell.day === todayDate ? 'bg-brand font-bold text-white' : 'text-fg')}>{cell.day}</span>
                        <span className="flex h-1.5 items-center gap-0.5">
                          {cell.bills.slice(0, 3).map((b) => <span key={b.id} className={cn('h-1.5 w-1.5 rounded-full', billDotColor(b))} />)}
                        </span>
                      </>
                    ) : <span className="h-6 w-6" />}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[10px] text-muted">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand" /> Bill Due</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Paid</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Upcoming</span>
              </div>
            </div>
            {/* Upcoming bills */}
            <div>
              <p className="mb-2 text-sm font-semibold">Upcoming Bills</p>
              {upcomingBills.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted">Nothing due soon.</p>
              ) : (
                <div className="space-y-2.5">
                  {upcomingBills.map((b) => (
                    <div key={b.id} className="flex items-center gap-2.5">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: `${categoryColor(b.category || 'Other')}22` }}>
                        <Receipt className="h-4 w-4" style={{ color: categoryColor(b.category || 'Other') }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{b.name}</p>
                        <p className="text-xs text-muted">Due {fmtDate(b.due_date)}</p>
                      </div>
                      <p className="shrink-0 text-sm font-bold tabular-nums">{fmtCurrency(b.amount)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Spending by Person */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Spending by Person</h2>
            <span className="text-xs text-muted">This Month</span>
          </div>
          {spendingByPerson.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No attributed spending yet this month.</p>
          ) : (
            <div className="space-y-3.5">
              {spendingByPerson.map((p) => (
                <div key={p.uid} className="flex items-center gap-3">
                  <Avatar name={p.name} color={p.color} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">
                        {p.name}{p.isSelf ? ' (You)' : p.age != null ? ` (${p.age})` : ''}
                      </p>
                      <p className="shrink-0 text-sm font-bold tabular-nums">{fmtCurrency(p.amount)}</p>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-border">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${p.pct}%` }} />
                      </div>
                      <span className="w-8 shrink-0 text-right text-[11px] text-muted tabular-nums">{p.pct}%</span>
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={() => setTab('Reports')} className="flex w-full items-center justify-center gap-0.5 pt-1 text-sm font-semibold text-brand-text hover:underline">
                View full breakdown <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Money Tip */}
      <div className="flex flex-col gap-3 rounded-2xl border border-brand/25 bg-gradient-to-r from-violet-600/10 to-blue-900/10 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-400/20 text-amber-300"><Lightbulb className="h-5 w-5" /></div>
          <div className="min-w-0">
            <p className="text-sm font-bold">Money Tip</p>
            <p className="text-xs text-muted">
              {lastMonthExpenses === 0
                ? 'Log a full month of spending to unlock personalized insights.'
                : spendDeltaPct < 0
                  ? `You've spent ${Math.abs(spendDeltaPct)}% less this month compared to last month. Great job! 🎉`
                  : spendDeltaPct > 0
                    ? `You're spending ${spendDeltaPct}% more this month than last. Tap for ways to trim it.`
                    : 'Your spending is right in line with last month.'}
            </p>
          </div>
        </div>
        <AiInsight kind="billing" label="View Insights" variant="primary" className="shrink-0 justify-center" />
      </div>
    </>
  );

  const renderTransactions = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">All Transactions</h2>
        <Button size="sm" onClick={() => setShowAddTransaction(true)}><Plus className="h-4 w-4" /> Add</Button>
      </div>
      {transactions.length === 0 ? (
        <EmptyState icon={Receipt} title="No transactions" description="Add your first transaction to start tracking your finances."
          action={<Button onClick={() => setShowAddTransaction(true)}><Plus className="h-4 w-4" /> Add Transaction</Button>} />
      ) : (
        <div className="rounded-2xl border border-border bg-surface/40 divide-y divide-border">
          {transactions.map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 px-4 py-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface/40">
                {tx.type === 'income' ? <ArrowDownLeft className="h-5 w-5 text-emerald-400" /> : <ArrowUpRight className="h-5 w-5 text-rose-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{tx.name}</p>
                <p className="text-xs text-muted">{tx.category} · {fmtDate(tx.date)}</p>
              </div>
              <p className={cn('text-sm font-bold shrink-0', tx.type === 'income' ? 'text-emerald-400' : 'text-fg')}>
                {tx.type === 'income' ? '+' : '-'}{fmtCurrency(Math.abs(tx.amount))}
              </p>
              <button onClick={() => deleteTransaction(tx.id)} className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-surface/40">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderBudgets = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Budgets</h2>
        <Button size="sm" onClick={() => setShowAddBudget(true)}><Plus className="h-4 w-4" /> Add Budget</Button>
      </div>
      {budgetProgress.length === 0 ? (
        <EmptyState icon={Wallet} title="No budgets" description="Set spending limits by category to stay on track."
          action={<Button onClick={() => setShowAddBudget(true)}><Plus className="h-4 w-4" /> Add Budget</Button>} />
      ) : (
        <div className="space-y-4">
          {budgetProgress.map((b) => {
            const pct = Math.min((b.spent / b.amount) * 100, 100);
            const over = b.spent > b.amount;
            const remaining = b.amount - b.spent;
            return (
              <div key={b.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{b.category}</p>
                    <p className="text-xs text-muted capitalize">{b.period}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-bold', over ? 'text-red-400' : 'text-muted')}>
                      {fmtCurrency(b.spent)} / {fmtCurrency(b.amount)}
                    </span>
                    <button onClick={() => deleteBudget(b.id)} className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-surface/40">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="h-2.5 rounded-full bg-border">
                  <div className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                </div>
                <p className={cn('mt-1.5 text-xs', over ? 'text-red-400' : 'text-muted')}>
                  {over ? `Over budget by ${fmtCurrency(Math.abs(remaining))}` : `${fmtCurrency(remaining)} remaining`}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderBills = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Bills</h2>
        <Button size="sm" onClick={() => setShowAddBill(true)}><Plus className="h-4 w-4" /> Add Bill</Button>
      </div>
      {bills.length === 0 ? (
        <EmptyState icon={Receipt} title="No bills" description="Track your recurring bills and due dates."
          action={<Button onClick={() => setShowAddBill(true)}><Plus className="h-4 w-4" /> Add Bill</Button>} />
      ) : (
        <div className="space-y-3">
          {bills.map((b) => (
            <div key={b.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface/40">
                <Receipt className="h-5 w-5 text-brand-text" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">{b.name}</p>
                <p className="text-xs text-muted">
                  Due {fmtDate(b.due_date)}
                  {b.is_recurring && ` · ${b.recurrence}`}
                  {b.category && ` · ${b.category}`}
                </p>
              </div>
              <Badge tone={b.status === 'paid' ? 'success' : b.status === 'overdue' ? 'danger' : 'neutral'}>
                {b.status}
              </Badge>
              <p className="text-sm font-bold shrink-0">{fmtCurrency(b.amount)}</p>
              <div className="flex gap-1">
                {b.status !== 'paid' && (
                  <button onClick={() => markBillPaid(b.id)} className="p-1.5 rounded-lg text-muted hover:text-emerald-400 hover:bg-surface/40" title="Mark paid">
                    <CheckCircle2 className="h-4 w-4" />
                  </button>
                )}
                <button onClick={() => deleteBill(b.id)} className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-surface/40">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderSavingsGoals = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Savings Goals</h2>
        <Button size="sm" onClick={() => setShowAddGoal(true)}><Plus className="h-4 w-4" /> Add Goal</Button>
      </div>
      {savingsGoals.length === 0 ? (
        <EmptyState icon={PiggyBank} title="No savings goals" description="Set a savings goal to track your progress."
          action={<Button onClick={() => setShowAddGoal(true)}><Plus className="h-4 w-4" /> Add Goal</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {savingsGoals.map((g) => {
            const pct = g.target_amount > 0 ? Math.min((g.current_amount / g.target_amount) * 100, 100) : 0;
            return (
              <div key={g.id} className="rounded-2xl border border-border bg-surface/40 p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{g.emoji || '🎯'}</span>
                    <div>
                      <p className="font-semibold text-sm">{g.name}</p>
                      <p className="text-xs text-muted">{pct.toFixed(0)}% saved</p>
                    </div>
                  </div>
                  <button onClick={() => deleteGoal(g.id)} className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-surface/40">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mb-2 h-2.5 rounded-full bg-border">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted">
                  <span>{fmtCurrency(g.current_amount)}</span>
                  <span>{fmtCurrency(g.target_amount)}</span>
                </div>
                {g.target_date && (
                  <p className="mt-2 text-xs text-muted">Target: {fmtDate(g.target_date)}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderReports = () => (
    <div className="space-y-5">
      <h2 className="font-semibold">Monthly Report</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
          <p className="text-xs text-muted">Total Income</p>
          <p className="text-2xl font-black text-emerald-400">{fmtCurrency(income)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
          <p className="text-xs text-muted">Total Expenses</p>
          <p className="text-2xl font-black text-rose-400">{fmtCurrency(expenses)}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4 text-center">
          <p className="text-xs text-muted">Net Savings</p>
          <p className={cn('text-2xl font-black', netSavings >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtCurrency(netSavings)}</p>
        </div>
      </div>

      {spendBreakdown.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h3 className="mb-4 font-semibold">Spending by Category</h3>
          <div className="space-y-3">
            {spendBreakdown.map(({ label, pct, color }) => (
              <div key={label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="font-medium">{label}</span>
                  <span className="text-muted">{pct}%</span>
                </div>
                <div className="h-2 rounded-full bg-border">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <h3 className="mb-4 font-semibold">Accounts Summary</h3>
        {accounts.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">No accounts linked.</p>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{a.name}</p>
                  <p className="text-xs text-muted capitalize">{a.type}{a.last_four ? ` ···${a.last_four}` : ''}</p>
                </div>
                <p className="text-sm font-bold">{fmtCurrency(a.balance ?? 0)}</p>
              </div>
            ))}
            <div className="border-t border-border pt-3 flex justify-between">
              <span className="text-sm text-muted">Total</span>
              <span className="text-sm font-black">{fmtCurrency(totalBalance)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderTabContent = () => {
    switch (tab) {
      case 'Overview': return renderOverview();
      case 'Transactions': return renderTransactions();
      case 'Budgets': return renderBudgets();
      case 'Bills': return renderBills();
      case 'Savings Goals': return renderSavingsGoals();
      case 'Reports': return renderReports();
      default: return renderOverview();
    }
  };

  return (
    <div className="module-with-sidebar">
      <div className="module-main module-page">
        <PageHeader
          title="Finances"
          description="Stay on top of your family's money, budgets, and goals."
          action={
            <div className="flex items-center gap-2">
              <Button onClick={() => setShowAddTransaction(true)}><Plus className="h-4 w-4" /> Add Transaction</Button>
              <Button variant="secondary" onClick={() => setShowAddAccount(true)}><Link2 className="h-4 w-4" /> Link Account</Button>
              <AiInsight kind="billing" iconOnly />
            </div>
          }
        />

        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {renderTabContent()}

        {/* ── Stripe Subscription Section ────────────────────────────────── */}
        <div className="rounded-2xl border border-border bg-surface/30 p-5">
          <div className="mb-4 flex items-center gap-3">
            <CreditCard className="h-5 w-5 text-brand-text" />
            <h2 className="font-semibold">Bubaly Subscription</h2>
          </div>
          {subLoading ? <SkeletonList /> : (
            <>
              <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-lg font-bold">{plan.name}</p>
                  <p className="mt-1 text-sm text-muted">{plan.description}</p>
                  {subscription?.current_period_end && (
                    <p className="mt-2 text-sm text-muted">
                      {subCanceling
                        ? `Cancels — access until ${fmtDate(subscription.current_period_end)}`
                        : `${['canceled', 'incomplete_expired'].includes(status) ? 'Access until' : 'Renews'} ${fmtDate(subscription.current_period_end)}`}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge tone={subConfig.tone as 'success' | 'warning' | 'danger' | 'neutral'}>
                    <span className="flex items-center gap-1">{subConfig.icon} {subConfig.label}</span>
                  </Badge>
                  {admin && subscription && (
                    <Button size="sm" variant="ghost" loading={pending} onClick={() => startTransition(() => void openPortal())}>Payment &amp; invoices</Button>
                  )}
                </div>
              </div>

              {/* Scheduled-cancel banner with one-tap Resume. */}
              {admin && subCanceling && (
                <div className="mb-4 flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span>Your plan ends on {subscription?.current_period_end ? fmtDate(subscription.current_period_end) : 'the period end'} and drops to Free.</span>
                  <Button size="sm" loading={pending} onClick={() => setCancel(true)}>Resume plan</Button>
                </div>
              )}

              {/* Plan picker — always available to admins so they can upgrade,
                  downgrade, or switch billing interval at any time. */}
              {admin && (
                <PlanManager currentSlug={subscription?.plan ?? null} highlight={needLevel} pending={pending} onChoose={changePlan} />
              )}
              {admin && serviceFeeNotice && (
                <p className="mt-3 text-center text-xs text-muted">{serviceFeeNotice}</p>
              )}

              {/* Cancel control for paying families that aren't already canceling. */}
              {admin && hasPaidPlan && !subCanceling && (
                <div className="mt-3 text-right">
                  <button onClick={() => setCancel(false)} disabled={pending} className="text-xs text-muted underline underline-offset-2 hover:text-danger disabled:opacity-50">
                    Cancel &amp; downgrade to Free
                  </button>
                </div>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {['Unlimited family members', 'AI family assistant', 'All modules', 'Real-time sync', 'Document vault', 'Meal planning', 'School & sports', 'Priority support'].map((f) => (
                  <div key={f} className="flex items-center gap-2 text-xs text-muted">
                    <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', hasActiveAccess ? 'text-emerald-400' : 'text-muted/60')} />{f}
                  </div>
                ))}
              </div>
              {!admin && <p className="mt-4 text-center text-sm text-muted">Contact your family admin to manage billing.</p>}
            </>
          )}
        </div>
      </div>

      {/* Sidebar — stacks below the main column on mobile, right rail on desktop */}
      <aside className="module-sidebar flex flex-col gap-5">
        {/* Accounts */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Accounts</h2>
          </div>
          {accounts.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">No accounts linked yet.</p>
          ) : (
            <div className="space-y-3">
              {accounts.map((a) => {
                const color = ACCOUNT_TYPE_COLORS[a.type] ?? 'bg-gray-500';
                return (
                  <div key={a.id} className="flex items-center gap-3 group">
                    <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', color + '/20')}>
                      <div className={cn('h-3 w-3 rounded-full', color)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{a.name}</p>
                      <p className="text-xs text-muted capitalize">{a.type}{a.last_four ? ` ···${a.last_four}` : ''}</p>
                    </div>
                    <p className="text-sm font-bold shrink-0">{fmtCurrency(a.balance ?? 0)}</p>
                    <button onClick={() => deleteAccount(a.id)} className="p-1 rounded text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-400">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {accounts.length > 0 && (
            <div className="mt-4 border-t border-border pt-3 flex items-center justify-between">
              <span className="text-sm text-muted">Total</span>
              <span className="text-sm font-black">{fmtCurrency(totalBalance)}</span>
            </div>
          )}
          <button onClick={() => setShowAddAccount(true)} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-xs font-semibold text-muted hover:text-fg">
            <Plus className="h-3.5 w-3.5" /> Add Account
          </button>
        </div>

        {/* Savings Goals */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Savings Goals</h2>
            <button onClick={() => setTab('Savings Goals')} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">View all <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          {savingsGoals.length === 0 ? (
            <div className="py-2 text-center">
              <p className="text-sm text-muted">No savings goals yet.</p>
              <button onClick={() => setShowAddGoal(true)} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-xs font-semibold text-muted hover:text-fg">
                <Plus className="h-3.5 w-3.5" /> Add Goal
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {savingsGoals.slice(0, 4).map((g) => {
                const pct = g.target_amount > 0 ? Math.min(Math.round((g.current_amount / g.target_amount) * 100), 100) : 0;
                return (
                  <div key={g.id}>
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-lg">{g.emoji || '🎯'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{g.name}</p>
                        <p className="truncate text-xs text-muted tabular-nums">{fmtCurrency(g.current_amount)} of {fmtCurrency(g.target_amount)}</p>
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums">{pct}%</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-border">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Modals */}
      <AddAccountModal open={showAddAccount} onClose={() => setShowAddAccount(false)} familyId={familyId} userId={userId} onDone={() => void refreshAccounts()} />
      <AddTransactionModal open={showAddTransaction} onClose={() => setShowAddTransaction(false)} familyId={familyId} userId={userId} accounts={accounts} onDone={() => void refreshTransactions()} />
      <AddBudgetModal open={showAddBudget} onClose={() => setShowAddBudget(false)} familyId={familyId} userId={userId} onDone={() => void refreshBudgets()} />
      <AddBillModal open={showAddBill} onClose={() => setShowAddBill(false)} familyId={familyId} userId={userId} onDone={() => void refreshBills()} />
      <AddSavingsGoalModal open={showAddGoal} onClose={() => setShowAddGoal(false)} familyId={familyId} userId={userId} onDone={() => void refreshGoals()} />
    </div>
  );
}
