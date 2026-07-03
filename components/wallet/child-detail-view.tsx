'use client';

// Child wallet detail — world-class financial dashboard for one child.
// • Smart Split donut (CSS conic-gradient) showing actual bucket allocation
// • Virtual card placeholder (Stripe Issuing when approved)
// • AI Money Coach: inline coaching card
// • Quick actions: Add Funds, Request to Spend, Send to Sibling
// • Goals with animated progress bars + date forecast
// • Activity feed grouped by day with bucket-kind icons
import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Plus, Target, PiggyBank, ShoppingBag, HandHeart, TrendingUp, Receipt,
  Sparkles, CreditCard, Send, HandCoins, X, ChevronRight, ChevronDown,
  ArrowDownLeft, ArrowUpRight, Check, Clock, Banknote,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/states';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtRelative } from '@/lib/utils/format';
import { formatCents, goalProgress, type BucketKind, type Split } from '@/lib/wallet/ledger';
import { txnTypeLabel, signedAmountCents, groupByDay, type ActivityTxn } from '@/lib/wallet/activity';
import { addFundsAction, requestSpendAction, sendMoneyAction, requestAllowanceAction } from '@/app/(app)/wallet/actions';
import { describeDbError } from '@/lib/supabase/errors';

// ─── Types ────────────────────────────────────────────────────────────────────

type Goal = {
  id: string; title: string; target_cents: number; saved_cents: number;
  status: string; kind?: string | null; target_date?: string | null;
};

type Sibling = { id: string; name: string; color: string | null };

type HistoryTxn = ActivityTxn & { bucket_kind?: BucketKind | null; metadata?: Record<string, unknown> | null };

type Child = {
  id: string; name: string; color: string | null; total: number;
  buckets: Record<BucketKind, number>; split: Split; approvalThresholdCents: number;
};

type Coaching = { headline: string; insights: string[]; suggestion: string };

// ─── Bucket metadata ──────────────────────────────────────────────────────────

const BUCKET_META: Record<string, { label: string; icon: typeof PiggyBank; color: string; ring: string; bg: string }> = {
  spend: { label: 'Spend', icon: ShoppingBag, color: 'text-sky-500', ring: '#38bdf8', bg: 'bg-sky-500/10' },
  save:  { label: 'Save',  icon: PiggyBank,  color: 'text-emerald-500', ring: '#34d399', bg: 'bg-emerald-500/10' },
  give:  { label: 'Give',  icon: HandHeart,  color: 'text-rose-500', ring: '#fb7185', bg: 'bg-rose-500/10' },
  invest: { label: 'Invest', icon: TrendingUp, color: 'text-violet-500', ring: '#a78bfa', bg: 'bg-violet-500/10' },
};

const BUCKET_KINDS: BucketKind[] = ['spend', 'save', 'give', 'invest'];

// ─── Smart Split Donut ────────────────────────────────────────────────────────

function SmartSplitDonut({ buckets, total }: { buckets: Record<BucketKind, number>; total: number }) {
  if (total <= 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-muted">
        <div className="h-32 w-32 rounded-full border-4 border-dashed border-border/50 flex items-center justify-center">
          <Banknote className="h-8 w-8 text-border" />
        </div>
        <p className="mt-2 text-xs">Add funds to see your split</p>
      </div>
    );
  }

  const segments = BUCKET_KINDS.map((k) => ({
    k,
    amount: buckets[k] ?? 0,
    color: BUCKET_META[k].ring,
    pct: total > 0 ? ((buckets[k] ?? 0) / total) : 0,
  })).filter((s) => s.amount > 0);

  // Build conic-gradient stops
  let acc = 0;
  const stops = segments.map((s) => {
    const start = acc * 360;
    acc += s.pct;
    const end = acc * 360;
    return `${s.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
  });
  // Fill gap if rounding leaves <360 total
  const gradient = stops.length > 0 ? stops.join(', ') : '#e5e7eb 0deg 360deg';

  return (
    <div className="flex flex-col items-center">
      {/* Donut */}
      <div className="relative h-36 w-36">
        <div
          className="h-full w-full rounded-full"
          style={{ background: `conic-gradient(from -90deg, ${gradient})` }}
        />
        {/* Inner hole */}
        <div className="absolute inset-[20%] rounded-full bg-bg flex flex-col items-center justify-center">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Total</p>
          <p className="text-sm font-black leading-tight">{formatCents(total)}</p>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2">
        {segments.map(({ k, amount, pct }) => {
          const m = BUCKET_META[k];
          return (
            <div key={k} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: m.ring }} />
              <span className="text-xs text-muted">{m.label}</span>
              <span className="text-xs font-semibold">{Math.round(pct * 100)}%</span>
              <span className="text-xs text-muted">· {formatCents(amount)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Virtual Card ─────────────────────────────────────────────────────────────

function VirtualCardPlaceholder({ child }: { child: Child }) {
  const spendable = child.buckets.spend ?? 0;
  return (
    <div className="relative overflow-hidden rounded-2xl p-5 text-white select-none"
      style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #1d4ed8 100%)' }}>
      {/* Decorative circles */}
      <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/5" />
      <div className="pointer-events-none absolute -right-3 top-10 h-20 w-20 rounded-full bg-white/5" />
      <div className="pointer-events-none absolute bottom-0 left-0 h-24 w-24 rounded-full bg-white/[0.03]" />

      {/* Top row */}
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">Bubaly Family</p>
          <p className="mt-0.5 text-base font-bold">{child.name}</p>
        </div>
        <div className="flex items-center gap-1.5 rounded-lg bg-white/10 px-2 py-1">
          <CreditCard className="h-3.5 w-3.5 text-white/70" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-white/70">Virtual</span>
        </div>
      </div>

      {/* Balance */}
      <div className="relative mt-4">
        <p className="text-[10px] uppercase tracking-widest text-white/50">Spend balance</p>
        <p className="text-3xl font-black">{formatCents(spendable)}</p>
      </div>

      {/* Card number */}
      <p className="relative mt-3 font-mono text-base tracking-[0.25em] text-white/30">
        ••••  ••••  ••••  ••••
      </p>

      {/* Bottom row */}
      <div className="relative mt-4 flex items-end justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/40">Spending card</p>
          <p className="text-xs font-semibold text-white/60">Coming soon · real-time balance check</p>
        </div>
        <p className="text-xl font-black italic tracking-wider text-white/80">VISA</p>
      </div>
    </div>
  );
}

// ─── AI Money Coach card ──────────────────────────────────────────────────────

function AICoachCard({ childId }: { childId: string }) {
  const { error: toastError } = useToast();
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai/wallet/child/${childId}`, { method: 'POST' });
      const json = (await res.json()) as { coaching?: Coaching; error?: string };
      if (!res.ok || !json.coaching) throw new Error(json.error || 'Could not get coaching');
      setCoaching(json.coaching);
      setDismissed(false);
    } catch (err) {
      toastError(describeDbError(err, 'Coach unavailable'));
    } finally {
      setLoading(false);
    }
  }, [childId, toastError]);

  if (dismissed) return null;

  if (!coaching) {
    return (
      <button
        onClick={load}
        disabled={loading}
        className="flex w-full items-center gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/5 to-violet-500/5 px-4 py-3.5 text-left transition hover:border-brand/30 hover:from-brand/10 disabled:opacity-60"
      >
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
          {loading ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
        </div>
        <div>
          <p className="text-sm font-semibold text-brand">{loading ? 'Thinking…' : 'Ask AI Money Coach'}</p>
          <p className="text-xs text-muted">Get personalised insights for this wallet</p>
        </div>
        {!loading && <ChevronRight className="ml-auto h-4 w-4 text-muted" />}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/8 to-violet-500/5 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand">
          <Sparkles className="h-3.5 w-3.5" /> AI Money Coach
        </span>
        <div className="flex items-center gap-1.5">
          <button onClick={load} disabled={loading} className="rounded-md p-1 text-muted hover:text-brand disabled:opacity-50" title="Refresh">
            {loading
              ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              : <Sparkles className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => setDismissed(true)} className="rounded-md p-1 text-muted hover:text-danger" title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {coaching.headline && <p className="text-sm font-semibold leading-relaxed">{coaching.headline}</p>}
      {coaching.insights.length > 0 && (
        <ul className="mt-2 space-y-1">
          {coaching.insights.map((it, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-muted">
              <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" /> {it}
            </li>
          ))}
        </ul>
      )}
      {coaching.suggestion && (
        <p className="mt-2.5 rounded-xl border border-brand/20 bg-brand/5 p-2.5 text-xs">
          <span className="font-semibold text-brand">Try this: </span>{coaching.suggestion}
        </p>
      )}
    </div>
  );
}

// ─── Goal progress card ───────────────────────────────────────────────────────

function GoalCard({ goal }: { goal: Goal }) {
  const pct = Math.round(goalProgress(goal.saved_cents, goal.target_cents) * 100);
  const reached = goal.status === 'reached';
  const daysLeft = goal.target_date
    ? Math.ceil((Date.parse(goal.target_date) - Date.now()) / 86400000)
    : null;

  return (
    <div className="rounded-xl border border-border bg-surface/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {reached ? '🎉 ' : ''}{goal.title}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {formatCents(goal.saved_cents)} of {formatCents(goal.target_cents)}
            {daysLeft != null && !reached && (
              <span className={cn('ml-1', daysLeft < 14 ? 'text-amber-500' : '')}>
                · {daysLeft > 0 ? `${daysLeft}d left` : 'overdue'}
              </span>
            )}
          </p>
        </div>
        <span className={cn('flex-shrink-0 text-sm font-bold', reached ? 'text-success' : 'text-brand')}>
          {pct}%
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/40">
        <div
          className={cn('h-full rounded-full transition-all duration-500', reached ? 'bg-success' : 'bg-brand')}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Activity feed ────────────────────────────────────────────────────────────

const TXN_TYPE_ICON: Record<string, typeof ArrowDownLeft> = {
  gift_received: ArrowDownLeft,
  parent_top_up: ArrowDownLeft,
  allowance: ArrowDownLeft,
  chore_reward: ArrowDownLeft,
  card_spend: ArrowUpRight,
  card_refund: ArrowDownLeft,
  goal_transfer: Target,
  bucket_transfer: ArrowUpRight,
  withdrawal: ArrowUpRight,
  transfer: Send,
  reversal: Check,
};

const TRUST_BASIS_LABEL: Record<string, string> = {
  role_default: 'Auto',
  allow_grant: 'Allowed',
  policy: 'Policy',
  delegation: 'Delegated',
  emergency: 'Emergency',
};

function TxnRow({ tx }: { tx: HistoryTxn }) {
  const signed = signedAmountCents(tx);
  const credit = signed >= 0;
  const Icon = TXN_TYPE_ICON[tx.type] ?? (credit ? ArrowDownLeft : ArrowUpRight);
  const meta = tx.bucket_kind ? BUCKET_META[tx.bucket_kind] : null;
  const isPending = tx.status === 'requires_parent_approval';

  // Trust badge: only on completed card_spend rows that have a trust_basis stored
  const trustBasis = tx.status === 'completed' && tx.type === 'card_spend' && tx.metadata?.trust_basis
    ? String(tx.metadata.trust_basis)
    : null;
  const trustLabel = trustBasis ? (TRUST_BASIS_LABEL[trustBasis] ?? null) : null;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className={cn('grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg',
        isPending ? 'bg-amber-500/10 text-amber-500' :
        credit ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400',
      )}>
        {isPending ? <Clock className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {tx.description || txnTypeLabel(tx.type)}
        </p>
        <p className="flex items-center gap-1 text-[11px] text-muted">
          {meta && <span className={cn('flex items-center gap-0.5', meta.color)}><meta.icon className="h-3 w-3" /> {meta.label} · </span>}
          {txnTypeLabel(tx.type)} · {fmtRelative(tx.created_at)}
          {isPending && <span className="text-amber-500"> · Pending approval</span>}
          {trustLabel && <span className="ml-1 rounded bg-border/60 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted">{trustLabel}</span>}
        </p>
      </div>
      <span className={cn('flex-shrink-0 text-sm font-semibold',
        isPending ? 'text-amber-500' :
        credit ? 'text-emerald-400' : 'text-rose-400',
      )}>
        {isPending ? '' : (credit ? '+' : '−')}{formatCents(Math.abs(signed))}
      </span>
    </div>
  );
}

// ─── Request to Spend modal ───────────────────────────────────────────────────

function RequestSpendModal({ child, onClose }: { child: Child; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const spendable = child.buckets.spend ?? 0;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    if (!desc.trim()) return toastError('What is it for?');
    setLoading(true);
    const res = await requestSpendAction({ childWalletId: child.id, amountCents: Math.round(dollars * 100), description: desc.trim() });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not submit request');
    success(res.pendingApproval ? 'Sent to a parent for approval' : 'Approved — enjoy!');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Request to spend — ${child.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-surface/60 px-3 py-2 text-xs text-muted">
          {formatCents(spendable)} available in Spend.
          {spendable < child.approvalThresholdCents
            ? ` Requests over ${formatCents(child.approvalThresholdCents)} need a parent's OK.`
            : ' A parent will review this request.'}
        </p>
        <Field label="What for?">
          {(id) => <Input id={id} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Lego set" autoFocus maxLength={120} />}
        </Field>
        <Field label="Amount (USD)">
          {(id) => <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12.00" />}
        </Field>
        <div className="flex flex-wrap gap-2">
          {[5, 10, 20, 50].map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand transition">
              ${q}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}><HandCoins className="h-4 w-4" /> Request</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Send to Sibling modal ────────────────────────────────────────────────────

function SendToSiblingModal({ child, siblings, onClose }: { child: Child; siblings: Sibling[]; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [to, setTo] = useState(siblings[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const spendable = child.buckets.spend ?? 0;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    if (!to) return toastError('Pick a recipient.');
    setLoading(true);
    const res = await sendMoneyAction({ fromChildWalletId: child.id, toChildWalletId: to, amountCents: Math.round(dollars * 100), note: note.trim() || undefined });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not send money');
    success('Money sent');
    onClose();
    router.refresh();
  }

  const selectCls = 'w-full rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm focus:border-brand/40 focus:outline-none';

  return (
    <Modal open onClose={onClose} title={`Send from ${child.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-surface/60 px-3 py-2 text-xs text-muted">
          {formatCents(spendable)} available in {child.name}&apos;s Spend bucket.
        </p>
        <Field label="To">
          {(id) => (
            <select id={id} value={to} onChange={(e) => setTo(e.target.value)} className={selectCls}>
              {siblings.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Amount (USD)">
          {(id) => <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" autoFocus />}
        </Field>
        <Field label="Note (optional)">
          {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Birthday gift" maxLength={120} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}><Send className="h-4 w-4" /> Send</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Funds modal ──────────────────────────────────────────────────────────

function AddFundsModal({ child, onClose }: { child: Child; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    setLoading(true);
    const res = await addFundsAction({ childWalletId: child.id, amountCents: Math.round(dollars * 100), description: 'Parent top-up' });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not add funds');
    success(`Added ${formatCents(Math.round(dollars * 100))} to ${child.name}`);
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Add funds — ${child.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-surface/60 px-3 py-2 text-xs text-muted">
          Split across {child.name}&apos;s buckets: {child.split.spend}% Spend, {child.split.save}% Save,
          {' '}{child.split.give}% Give, {child.split.invest}% Invest.
        </p>
        <Field label="Amount (USD)">
          {(id) => (
            <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" autoFocus
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20.00" />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          {[5, 10, 20, 50].map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand transition">
              ${q}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}><Plus className="h-4 w-4" /> Add funds</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Request Allowance modal ──────────────────────────────────────────────────

function RequestAllowanceModal({ child, onClose }: { child: Child; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    setLoading(true);
    const res = await requestAllowanceAction({ childWalletId: child.id, amountCents: Math.round(dollars * 100), reason: reason.trim() || undefined });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not send request');
    success('Request sent to a parent');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={`Request allowance — ${child.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="rounded-xl bg-surface/60 px-3 py-2 text-xs text-muted">
          A parent will see your request and can add funds directly to your wallet.
        </p>
        <Field label="Amount (USD)">
          {(id) => (
            <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" autoFocus
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          {[5, 10, 20, 50].map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand transition">
              ${q}
            </button>
          ))}
        </div>
        <Field label="Reason (optional)">
          {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Birthday money, extra chores…" maxLength={120} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}><Banknote className="h-4 w-4" /> Send request</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ChildDetailView({
  child, goals, history, canManage, siblings,
}: {
  child: Child;
  goals: Goal[];
  history: HistoryTxn[];
  canManage: boolean;
  siblings: Sibling[];
}) {
  const [adding, setAdding] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestingAllowance, setRequestingAllowance] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);

  const groups = groupByDay(history);
  const visibleGroups = activityExpanded ? groups : groups.slice(0, 3);
  const hasMore = groups.length > 3;
  const activeGoals = goals.filter((g) => g.status !== 'reached' && g.status !== 'cancelled');
  const reachedGoals = goals.filter((g) => g.status === 'reached');

  return (
    <div className="module-page space-y-5">
      {/* Back nav */}
      <Link href="/wallet" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg transition">
        <ArrowLeft className="h-4 w-4" /> All wallets
      </Link>

      {/* ── Hero header ──────────────────────────────────────────────────────── */}
      <div className="rounded-3xl border border-border bg-gradient-to-br from-surface/60 to-bg p-5">
        <div className="flex items-center gap-4">
          <Avatar name={child.name} color={child.color ?? undefined} size={64} className="ring-2 ring-brand/20 ring-offset-2 ring-offset-bg" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-muted">{child.name}&apos;s Wallet</p>
            <p className="text-4xl font-black tabular-nums">{formatCents(child.total)}</p>
            <p className="mt-0.5 text-xs text-muted">
              {formatCents(child.buckets.spend ?? 0)} spendable · {formatCents(child.buckets.save ?? 0)} saved
            </p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <button
            onClick={() => setRequesting(true)}
            className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-bg/40 py-3 text-xs font-semibold transition hover:border-brand/40 hover:text-brand"
          >
            <HandCoins className="h-5 w-5" /> Request
          </button>
          {canManage && (
            <button
              onClick={() => setAdding(true)}
              className="flex flex-col items-center gap-1 rounded-2xl border border-brand/30 bg-brand/10 py-3 text-xs font-semibold text-brand transition hover:bg-brand/15"
            >
              <Plus className="h-5 w-5" /> Add funds
            </button>
          )}
          {siblings.length > 0 && canManage ? (
            <button
              onClick={() => setSending(true)}
              className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-bg/40 py-3 text-xs font-semibold transition hover:border-brand/40 hover:text-brand"
            >
              <Send className="h-5 w-5" /> Send
            </button>
          ) : (
            <Link href="/wallet/cards"
              className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-bg/40 py-3 text-xs font-semibold text-muted transition hover:border-brand/40 hover:text-brand">
              <CreditCard className="h-5 w-5" /> Cards
            </Link>
          )}
        </div>

        {/* Secondary: request allowance (visible to all — child or parent can ask) */}
        <button
          onClick={() => setRequestingAllowance(true)}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2 text-xs font-medium text-muted transition hover:border-brand/40 hover:text-brand"
        >
          <Banknote className="h-3.5 w-3.5" /> Ask for more allowance
        </button>
      </div>

      {/* ── Smart Split donut ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <span className="inline-block h-2 w-2 rounded-full bg-brand" /> Smart Split
          </h2>
          <Link href="/wallet/settings" className="text-xs font-semibold text-brand hover:underline">Edit split →</Link>
        </div>
        <SmartSplitDonut buckets={child.buckets} total={child.total} />

        {/* Target vs actual note */}
        {child.total > 0 && (
          <p className="mt-3 text-center text-[10px] text-muted">
            Target: {child.split.spend}% Spend · {child.split.save}% Save · {child.split.give}% Give · {child.split.invest}% Invest
          </p>
        )}
      </div>

      {/* ── Virtual Card ──────────────────────────────────────────────────────── */}
      <VirtualCardPlaceholder child={child} />

      {/* ── AI Money Coach ────────────────────────────────────────────────────── */}
      <AICoachCard childId={child.id} />

      {/* ── Savings Goals ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Target className="h-4 w-4 text-amber-500" /> Goals
            {activeGoals.length > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-bold text-amber-500">{activeGoals.length}</span>}
          </h2>
          <Link href="/wallet/goals" className="text-xs font-semibold text-brand hover:underline">Manage →</Link>
        </div>
        {goals.length === 0 ? (
          <p className="text-sm text-muted">No goals yet. <Link href="/wallet/goals" className="text-brand hover:underline">Create one →</Link></p>
        ) : (
          <div className="space-y-2">
            {activeGoals.map((g) => <GoalCard key={g.id} goal={g} />)}
            {reachedGoals.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer list-none text-xs font-semibold text-muted hover:text-brand">
                  {reachedGoals.length} reached goal{reachedGoals.length !== 1 ? 's' : ''} 🎉
                </summary>
                <div className="mt-1.5 space-y-2">
                  {reachedGoals.map((g) => <GoalCard key={g.id} goal={g} />)}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ── Bucket breakdown strip ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {BUCKET_KINDS.map((k) => {
          const m = BUCKET_META[k];
          const bal = child.buckets[k] ?? 0;
          const targetPct = child.split[k as keyof Split];
          return (
            <div key={k} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className={cn('flex items-center gap-1.5 text-xs font-medium', m.color)}>
                <m.icon className="h-3.5 w-3.5" /> {m.label}
              </div>
              <p className="mt-1.5 text-lg font-bold">{formatCents(bal)}</p>
              <p className="mt-0.5 text-[10px] text-muted">Target {targetPct}%</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/40">
                <div
                  className="h-full rounded-full opacity-80 transition-all duration-500"
                  style={{
                    width: child.total > 0 ? `${Math.min(100, (bal / child.total) * 100)}%` : '0%',
                    background: m.ring,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Activity feed ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Receipt className="h-4 w-4 text-brand" /> Activity
          </h2>
          <Link href="/wallet/activity" className="text-xs font-semibold text-brand hover:underline">All activity →</Link>
        </div>
        {history.length === 0 ? (
          <div className="py-4">
            <EmptyState icon={Receipt} title="No transactions yet" description="Top-ups, allowance, chores and gifts will show here." />
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {visibleGroups.map((grp) => (
              <div key={grp.date}>
                <p className="bg-bg/50 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted">
                  {new Date(grp.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </p>
                {grp.txns.map((tx) => <TxnRow key={tx.id} tx={tx as HistoryTxn} />)}
              </div>
            ))}
            {hasMore && (
              <button
                onClick={() => setActivityExpanded(!activityExpanded)}
                className="flex w-full items-center justify-center gap-1 py-3 text-xs font-semibold text-muted hover:text-brand transition"
              >
                {activityExpanded ? <><ChevronDown className="h-3.5 w-3.5 rotate-180" /> Show less</> : <><ChevronDown className="h-3.5 w-3.5" /> Show {groups.length - 3} more days</>}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}
      {adding && <AddFundsModal child={child} onClose={() => setAdding(false)} />}
      {requesting && <RequestSpendModal child={child} onClose={() => setRequesting(false)} />}
      {sending && siblings.length > 0 && <SendToSiblingModal child={child} siblings={siblings} onClose={() => setSending(false)} />}
      {requestingAllowance && <RequestAllowanceModal child={child} onClose={() => setRequestingAllowance(false)} />}
    </div>
  );
}
