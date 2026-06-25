'use client';

// Family Wallet dashboard — mobile-first "financial OS" view. Shows the family
// total, each child's balance + buckets, recent ledger activity, and a parent
// "Add funds" / "Send Money" flow. Balances are derived (never stored) via lib/wallet/ledger.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Wallet, PiggyBank, ShoppingBag, HeartHandshake, TrendingUp, Plus, X, ArrowDownLeft, ArrowUpRight, Sparkles, SendHorizonal,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtRelative } from '@/lib/utils/format';
import { formatCents, type BucketKind } from '@/lib/wallet/ledger';
import { computeFunding, serviceFeeLabel, type WalletTier } from '@/lib/wallet/fees';
import { WALLET_TIERS, aiCoachLevel } from '@/lib/wallet/tiers';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { addFundsAction } from '@/app/(app)/wallet/actions';

const SEND_REASONS = [
  { value: '', label: 'No specific reason' },
  { value: 'Birthday gift', label: '🎂 Birthday gift' },
  { value: 'Great job!', label: '⭐ Great job!' },
  { value: 'Weekly bonus', label: '💰 Weekly bonus' },
  { value: 'Holiday gift', label: '🎁 Holiday gift' },
  { value: 'Special occasion', label: '✨ Special occasion' },
];

type Coaching = { headline: string; insights: string[]; suggestion: string };

export type ChildWalletView = {
  id: string;
  name: string;
  color: string | null;
  total: number;
  buckets: Record<BucketKind, number>;
};

type RecentTxn = {
  id: string;
  childName: string | null;
  type: string;
  status: string;
  direction: 'credit' | 'debit';
  amount_cents: number;
  description: string | null;
  created_at: string;
};

const BUCKET_META: { kind: BucketKind; label: string; icon: typeof PiggyBank; color: string }[] = [
  { kind: 'spend', label: 'Spend', icon: ShoppingBag, color: 'text-blue-400' },
  { kind: 'save', label: 'Save', icon: PiggyBank, color: 'text-emerald-400' },
  { kind: 'give', label: 'Give', icon: HeartHandshake, color: 'text-rose-400' },
  { kind: 'invest', label: 'Invest', icon: TrendingUp, color: 'text-violet-400' },
];

export function WalletDashboard({ familyTotal, mode, tier, canManage, childWallets, recent }: {
  familyTotal: number;
  mode: string;
  tier: WalletTier;
  canManage: boolean;
  childWallets: ChildWalletView[];
  recent: RecentTxn[];
}) {
  const [addFor, setAddFor] = useState<ChildWalletView | null>(null);
  const [sendFor, setSendFor] = useState<ChildWalletView | null>(null);
  const [coach, setCoach] = useState<Coaching | null>(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const { error: toastError } = useToast();
  const sampleGift = computeFunding(5000, tier); // $50 gift fee preview
  const hasCoach = aiCoachLevel(tier) !== 'none';

  async function runCoach() {
    setCoachLoading(true);
    try {
      const res = await fetch('/api/ai/wallet', { method: 'POST' });
      const json = (await res.json()) as { coaching?: Coaching; error?: string };
      if (!res.ok || !json.coaching) throw new Error(json.error || 'Could not get coaching');
      setCoach(json.coaching);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Coach failed');
    } finally {
      setCoachLoading(false);
    }
  }

  return (
    <div className="module-page">
      <PageHeader title="Family Wallet" description="Spend, save, give, and invest — for the whole family."
        action={
          <div className="flex items-center gap-2">
            {canManage && childWallets.length > 0 && (
              <Button variant="ghost" onClick={() => setSendFor(childWallets[0]!)}>
                <SendHorizonal className="h-4 w-4" /> Send Money
              </Button>
            )}
            {hasCoach && (
              <Button variant="ghost" onClick={runCoach} loading={coachLoading}><Sparkles className="h-4 w-4" /> Money Coach</Button>
            )}
          </div>
        }
      />
      <WalletSubnav />

      {coach && (
        <div className="mb-5 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand"><Sparkles className="h-3.5 w-3.5" /> Money Coach</span>
            <button onClick={() => setCoach(null)} className="text-muted hover:text-fg"><X className="h-3.5 w-3.5" /></button>
          </div>
          {coach.headline && <p className="text-sm font-semibold leading-relaxed">{coach.headline}</p>}
          {coach.insights.length > 0 && (
            <ul className="mt-2 space-y-1">
              {coach.insights.map((it, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted"><Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" /> {it}</li>
              ))}
            </ul>
          )}
          {coach.suggestion && <p className="mt-2 rounded-xl border border-brand/20 bg-brand/5 p-2.5 text-xs"><span className="font-semibold text-brand">Try this: </span>{coach.suggestion}</p>}
        </div>
      )}

      {/* Family total */}
      <div className="mb-5 rounded-3xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-6">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <Wallet className="h-4 w-4" /> Total family balance
        </div>
        <p className="mt-1 text-4xl font-black">{formatCents(familyTotal)}</p>
        <p className="text-xs text-muted">
          {mode === 'treasury' ? 'Stripe Treasury account' : 'Virtual ledger · parent-managed'}
        </p>
      </div>

      {/* Plan & gifting-fee transparency (fees disclosed before any payment) */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4 text-xs">
        <div>
          <span className="font-semibold">{WALLET_TIERS[tier].label} plan</span>
          <span className="text-muted"> · Bubaly service fee: {serviceFeeLabel(tier)}</span>
        </div>
        <div className="text-muted">
          A {formatCents(5000)} gift costs the sender{' '}
          <span className="font-semibold text-fg">{formatCents(sampleGift.totalChargedCents)}</span>{' '}
          (processing {formatCents(sampleGift.processingCents)}
          {sampleGift.serviceFeeCents > 0 ? ` + fee ${formatCents(sampleGift.serviceFeeCents)}` : ', no Bubaly fee'}); the child receives the full {formatCents(5000)}.
        </div>
      </div>

      {childWallets.length === 0 ? (
        <EmptyState icon={Wallet} title="No child wallets yet"
          description="Add children to your family and they'll each get a wallet here." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {childWallets.map((c) => (
            <div key={c.id} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Avatar name={c.name} color={c.color ?? undefined} size={36} className="rounded-full" />
                  <div>
                    <p className="text-sm font-semibold">{c.name}</p>
                    <p className="text-lg font-black leading-tight">{formatCents(c.total)}</p>
                  </div>
                </div>
                {canManage && (
                  <button onClick={() => setAddFor(c)}
                    className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {BUCKET_META.map((b) => (
                  <div key={b.kind} className="rounded-xl bg-bg/40 p-2 text-center">
                    <b.icon className={cn('mx-auto mb-1 h-3.5 w-3.5', b.color)} />
                    <p className="text-[11px] font-semibold">{formatCents(c.buckets[b.kind] ?? 0)}</p>
                    <p className="text-[9px] uppercase tracking-wide text-muted">{b.label}</p>
                  </div>
                ))}
              </div>
              <Link href={`/wallet/children/${c.id}`} className="mt-3 block text-center text-xs font-semibold text-brand hover:underline">
                View details &amp; history →
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* Recent activity */}
      <div className="mt-6">
        <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-muted">Recent activity</h2>
        {recent.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">No transactions yet. Add funds to get started.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border divide-y divide-border/50">
            {recent.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className={cn('grid h-8 w-8 place-items-center rounded-lg', t.direction === 'credit' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400')}>
                  {t.direction === 'credit' ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.description || t.type.replace(/_/g, ' ')}</p>
                  <p className="text-[11px] text-muted">{t.childName ? `${t.childName} · ` : ''}{fmtRelative(t.created_at)}{t.status !== 'completed' ? ` · ${t.status.replace(/_/g, ' ')}` : ''}</p>
                </div>
                <span className={cn('text-sm font-semibold', t.direction === 'credit' ? 'text-emerald-400' : 'text-rose-400')}>
                  {t.direction === 'credit' ? '+' : '−'}{formatCents(t.amount_cents)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {addFor && <AddFundsModal child={addFor} onClose={() => setAddFor(null)} />}
      {sendFor && <SendMoneyModal child={sendFor} childOptions={childWallets} onClose={() => setSendFor(null)} />}
    </div>
  );
}

function AddFundsModal({ child, onClose }: { child: ChildWalletView; onClose: () => void }) {
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
        <p className="text-xs text-muted">Funds are split across {child.name}&apos;s buckets using your allocation rule.</p>
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

function SendMoneyModal({ child, childOptions, onClose }: {
  child: ChildWalletView; childOptions: ChildWalletView[]; onClose: () => void;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [recipientId, setRecipientId] = useState(child.id);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const recipient = childOptions.find((c) => c.id === recipientId) ?? child;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    const description = [reason || null, note.trim() || null].filter(Boolean).join(' · ') || `Sent to ${recipient.name}`;
    setLoading(true);
    const res = await addFundsAction({ childWalletId: recipientId, amountCents: Math.round(dollars * 100), description });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not send money');
    success(`${formatCents(Math.round(dollars * 100))} sent to ${recipient.name}!`);
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title="Send Money">
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-3 text-xs text-muted">
          Funds are split across the recipient&apos;s buckets using their allocation rule.
        </div>

        {childOptions.length > 1 && (
          <Field label="Send to">
            {(id) => (
              <select id={id} value={recipientId} onChange={(e) => setRecipientId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
                {childOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {formatCents(c.total)}</option>
                ))}
              </select>
            )}
          </Field>
        )}

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

        <Field label="Reason (optional)">
          {(id) => (
            <select id={id} value={reason} onChange={(e) => setReason(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
              {SEND_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
        </Field>

        <Field label="Note (optional)">
          {(id) => (
            <Input id={id} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Great work this week!" maxLength={120} />
          )}
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}><SendHorizonal className="h-4 w-4" /> Send</Button>
        </div>
      </form>
    </Modal>
  );
}
