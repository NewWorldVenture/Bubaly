'use client';

// Family Wallet goals — create savings goals and fund them from a child's Save
// bucket. Progress + visual forecast. 100% Supabase-wired via the
// createGoalAction / fundGoalAction server actions (immutable goal_transfer).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Target, Plus, PiggyBank, Trophy, X, CalendarDays, TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { progressBarA11y } from '@/lib/ui/a11y';
import { formatCents, goalProgress } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { createGoalAction, fundGoalAction } from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

const GOAL_KIND_META: Record<string, { emoji: string; label: string }> = {
  bike:       { emoji: '🚲', label: 'Bike' },
  vacation:   { emoji: '✈️', label: 'Vacation' },
  college:    { emoji: '🎓', label: 'College' },
  car:        { emoji: '🚗', label: 'Car' },
  giving:     { emoji: '❤️', label: 'Giving' },
  emergency:  { emoji: '🛡️', label: 'Emergency' },
  gaming:     { emoji: '🎮', label: 'Gaming' },
  phone:      { emoji: '📱', label: 'Phone' },
  sports:     { emoji: '⚽', label: 'Sports' },
  custom:     { emoji: '🎯', label: 'Custom' },
};

const GOAL_KINDS = Object.entries(GOAL_KIND_META).map(([value, { emoji, label }]) => ({ value, emoji, label }));

export type GoalView = {
  id: string; title: string; kind: string;
  targetCents: number; savedCents: number; targetDate: string | null;
  childName: string | null; isChildGoal: boolean; status: string;
  weeklyRateCents?: number; weeksToGoal?: number | null;
};
export type ChildOption = { id: string; name: string };

export function GoalsView({ goals, childOptions, canManage }: {
  goals: GoalView[]; childOptions: ChildOption[]; canManage: boolean;
}) {
  const t = useTranslations();
  const [creating, setCreating] = useState(false);
  const [fundFor, setFundFor] = useState<GoalView | null>(null);

  const active = goals.filter((g) => g.status !== 'reached' && g.status !== 'cancelled');
  const reached = goals.filter((g) => g.status === 'reached');

  return (
    <div className="module-page">
      <PageHeader title={t('goals.familyWallet')} description="Save toward what matters — together."
        action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t('goals.newGoal')}</Button> : undefined} />
      <WalletSubnav />

      {goals.length === 0 ? (
        <EmptyState icon={Target} title={t('goals.noGoalsYet')}
          description="Set a savings goal — a bike, a trip, a giving target — and watch it grow."
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t('goals.newGoal')}</Button> : undefined} />
      ) : (
        <div className="space-y-5">
          {/* Active goals */}
          {active.length > 0 && (
            <div>
              <h2 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted">
                <TrendingUp className="h-3.5 w-3.5" /> {t('goals.inProgress')}{active.length})
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {active.map((g) => (
                  <GoalCard key={g.id} goal={g} canManage={canManage} onFund={() => setFundFor(g)} />
                ))}
              </div>
            </div>
          )}

          {/* Reached goals */}
          {reached.length > 0 && (
            <div>
              <h2 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-muted">
                <Trophy className="h-3.5 w-3.5" /> {t('goals.reached')}{reached.length})
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {reached.map((g) => (
                  <GoalCard key={g.id} goal={g} canManage={false} onFund={() => {}} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {creating && <CreateGoalModal childOptions={childOptions} onClose={() => setCreating(false)} />}
      {fundFor && <FundGoalModal goal={fundFor} onClose={() => setFundFor(null)} />}
    </div>
  );
}

function GoalCard({ goal, canManage, onFund }: { goal: GoalView; canManage: boolean; onFund: () => void }) {
  const t = useTranslations();
  const pct = Math.round(goalProgress(goal.savedCents, goal.targetCents) * 100);
  const reached = goal.status === 'reached' || goal.savedCents >= goal.targetCents;
  const kindMeta = GOAL_KIND_META[goal.kind] ?? GOAL_KIND_META.custom;
  const daysLeft = goal.targetDate
    ? Math.ceil((Date.parse(goal.targetDate) - Date.now()) / 86400000)
    : null;
  const remaining = Math.max(0, goal.targetCents - goal.savedCents);

  // Forecast label derived from server-computed weeksToGoal
  const forecastLabel = !reached && goal.weeksToGoal != null
    ? (goal.weeksToGoal === 0 ? null : `~${goal.weeksToGoal}w away`)
    : null;

  return (
    <div className={cn('rounded-2xl border p-4', reached ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-surface/40')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          {/* Kind emoji icon */}
          <div className={cn('grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl text-xl',
            reached ? 'bg-emerald-500/15' : 'bg-brand/10')}>
            {reached ? '🎉' : kindMeta.emoji}
          </div>
          <div>
            <p className="text-sm font-semibold">{goal.title}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {goal.childName ? `${goal.childName} · ` : 'Family · '}{kindMeta.label}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {goal.targetDate && !reached && (
                <p className={cn('flex items-center gap-1 text-[10px] font-medium',
                  daysLeft != null && daysLeft < 30 ? 'text-amber-500' : 'text-muted')}>
                  <CalendarDays className="h-3 w-3" />
                  {daysLeft != null ? (daysLeft > 0 ? `${daysLeft}d left` : 'Past target') : 'No deadline'}
                </p>
              )}
              {forecastLabel && (
                <p className="flex items-center gap-1 text-[10px] font-medium text-brand-text">
                  <TrendingUp className="h-3 w-3" />
                  {forecastLabel}
                </p>
              )}
            </div>
          </div>
        </div>
        {canManage && goal.isChildGoal && !reached && (
          <button onClick={onFund}
            className="flex-shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">
            {t('goals.fund')}
          </button>
        )}
      </div>

      {/* Progress */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-bold">{formatCents(goal.savedCents)}</span>
          <span className="text-xs text-muted">of {formatCents(goal.targetCents)}</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-border/40" {...progressBarA11y(pct, `${goal.title}: ${pct}% of goal`)}>
          <div
            className={cn('h-full rounded-full transition-all duration-700', reached ? 'bg-emerald-500' : 'bg-brand')}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <p className={cn('text-[11px] font-semibold', reached ? 'text-emerald-500' : 'text-brand-text')}>
            {reached ? '🎉 Goal reached!' : `${pct}% there`}
          </p>
          {!reached && remaining > 0 && (
            <p className="text-[11px] text-muted">{formatCents(remaining)} {t('goals.toGo')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateGoalModal({ childOptions, onClose }: { childOptions: ChildOption[]; onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [childId, setChildId] = useState<string>('');
  const [kind, setKind] = useState('custom');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const target = Number(form.get('target'));
    const targetDate = String(form.get('targetDate') ?? '').trim() || null;
    if (!title) return toastError('Give the goal a name.');
    if (!Number.isFinite(target) || target <= 0) return toastError('Set a target greater than $0.');
    setLoading(true);
    const res = await createGoalAction({
      title, kind, targetCents: Math.round(target * 100),
      childWalletId: childId || null, targetDate,
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not create goal');
    success('Goal created');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title={t('goals.newSavingsGoal')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('goals.whatAreYouSavingFor')}>
          {(id) => <Input id={id} name="title" placeholder="New bike, vacation fund…" autoFocus />}
        </Field>
        <Field label={t('goals.targetAmountUsd')}>
          {(id) => <Input id={id} name="target" type="number" min="0" step="0.01" inputMode="decimal" placeholder="100.00" />}
        </Field>
        <Field label={t('goals.category')}>
          {(id) => (
            <div className="grid grid-cols-4 gap-1.5">
              {GOAL_KINDS.map((k) => (
                <button key={k.value} type="button" onClick={() => setKind(k.value)}
                  className={cn('flex flex-col items-center gap-0.5 rounded-xl border p-2 text-xs transition',
                    kind === k.value ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:border-brand/40')}>
                  <span className="text-base">{k.emoji}</span>
                  <span className="text-[10px]">{k.label}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={t('goals.targetDateOptional')}>
          {(id) => <Input id={id} name="targetDate" type="date" />}
        </Field>
        <Field label={t('goals.whoseGoal')}>
          {(id) => (
            <select id={id} value={childId} onChange={(e) => setChildId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm focus:border-brand/40 focus:outline-none">
              <option value="">Family goal</option>
              {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> {t('goals.cancel')}</Button>
          <Button type="submit" loading={loading}><Target className="h-4 w-4" /> {t('goals.createGoal')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function FundGoalModal({ goal, onClose }: { goal: GoalView; onClose: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const remaining = Math.max(0, goal.targetCents - goal.savedCents);
  const pct = Math.round(goalProgress(goal.savedCents, goal.targetCents) * 100);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) return toastError('Enter an amount greater than $0.');
    setLoading(true);
    const res = await fundGoalAction({ goalId: goal.id, amountCents: Math.round(dollars * 100) });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not fund goal');
    success(`Moved ${formatCents(Math.round(dollars * 100))} into ${goal.title}`);
    onClose();
    router.refresh();
  }

  const kindMeta = GOAL_KIND_META[goal.kind] ?? GOAL_KIND_META.custom;

  return (
    <Modal open onClose={onClose} title={`Fund — ${goal.title}`}>
      <form onSubmit={submit} className="space-y-4">
        {/* Goal progress mini-card */}
        <div className="rounded-xl border border-border bg-surface/40 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">{kindMeta.emoji}</span>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-semibold">{goal.title}</p>
              <p className="text-xs text-muted">{pct}% · {formatCents(remaining)} {t('goals.toGo')}</p>
            </div>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/40" {...progressBarA11y(pct, `${goal.title}: ${pct}% of goal`)}>
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <p className="text-xs text-muted">
          <PiggyBank className="inline h-3.5 w-3.5 mr-0.5 text-emerald-400" />
          {t('goals.movesMoneyFrom')} {goal.childName}{t('goals.aposSSaveBucketIntoThis')}
        </p>

        <Field label={t('goals.amountUsd')}>
          {(id) => <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" autoFocus />}
        </Field>

        {/* Quick amounts */}
        <div className="flex flex-wrap gap-2">
          {[5, 10, 25, Math.ceil(remaining / 100)].filter((v, i, a) => v > 0 && a.indexOf(v) === i).slice(0, 4).map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand-text transition">
              ${q}
            </button>
          ))}
          {remaining > 0 && (
            <button type="button" onClick={() => setAmount((remaining / 100).toFixed(2))}
              className="rounded-lg border border-brand/40 px-3 py-1.5 text-sm text-brand-text hover:bg-brand/5 transition">
              {t('goals.fullRemaining')}
            </button>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> {t('goals.cancel')}</Button>
          <Button type="submit" loading={loading}><PiggyBank className="h-4 w-4" /> {t('goals.moveToGoal')}</Button>
        </div>
      </form>
    </Modal>
  );
}
