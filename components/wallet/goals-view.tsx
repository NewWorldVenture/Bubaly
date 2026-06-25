'use client';

// Family Wallet goals — create savings goals and fund them from a child's Save
// bucket. Progress + a plain-language forecast. 100% Supabase-wired via the
// createGoalAction / fundGoalAction server actions (immutable goal_transfer).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Target, Plus, PiggyBank, Trophy, X } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents, goalProgress } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { createGoalAction, fundGoalAction } from '@/app/(app)/wallet/actions';

export type GoalView = {
  id: string; title: string; kind: string;
  targetCents: number; savedCents: number;
  childName: string | null; isChildGoal: boolean; status: string;
};
export type ChildOption = { id: string; name: string };

export function GoalsView({ goals, childOptions, canManage }: {
  goals: GoalView[]; childOptions: ChildOption[]; canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [fundFor, setFundFor] = useState<GoalView | null>(null);

  return (
    <div className="module-page">
      <PageHeader title="Family Wallet" description="Save toward what matters — together."
        action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Goal</Button> : undefined} />
      <WalletSubnav />

      {goals.length === 0 ? (
        <EmptyState icon={Target} title="No goals yet"
          description="Set a savings goal — a bike, a trip, a giving target — and watch it grow."
          action={canManage ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Goal</Button> : undefined} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.map((g) => {
            const pct = Math.round(goalProgress(g.savedCents, g.targetCents) * 100);
            const reached = g.status === 'reached' || g.savedCents >= g.targetCents;
            return (
              <div key={g.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className={cn('grid h-9 w-9 place-items-center rounded-xl', reached ? 'bg-emerald-500/15 text-emerald-400' : 'bg-brand/15 text-brand')}>
                      {reached ? <Trophy className="h-4 w-4" /> : <Target className="h-4 w-4" />}
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{g.title}</p>
                      <p className="text-[11px] text-muted">{g.childName ? `${g.childName} · ` : 'Family · '}{g.kind}</p>
                    </div>
                  </div>
                  {canManage && g.isChildGoal && !reached && (
                    <button onClick={() => setFundFor(g)} className="rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition">Fund</button>
                  )}
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-semibold">{formatCents(g.savedCents)}</span>
                    <span className="text-muted">of {formatCents(g.targetCents)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-border/60">
                    <div className={cn('h-full rounded-full', reached ? 'bg-emerald-400' : 'bg-brand')} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{reached ? '🎉 Goal reached!' : `${pct}% there`}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && <CreateGoalModal childOptions={childOptions} onClose={() => setCreating(false)} />}
      {fundFor && <FundGoalModal goal={fundFor} onClose={() => setFundFor(null)} />}
    </div>
  );
}

function CreateGoalModal({ childOptions, onClose }: { childOptions: ChildOption[]; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [childId, setChildId] = useState<string>('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const target = Number(form.get('target'));
    if (!title) return toastError('Give the goal a name.');
    if (!Number.isFinite(target) || target <= 0) return toastError('Set a target greater than $0.');
    setLoading(true);
    const res = await createGoalAction({ title, kind: String(form.get('kind') || 'custom'), targetCents: Math.round(target * 100), childWalletId: childId || null });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not create goal');
    success('Goal created');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title="New Goal">
      <form onSubmit={submit} className="space-y-4">
        <Field label="What are you saving for?">{(id) => <Input id={id} name="title" placeholder="New bike" autoFocus />}</Field>
        <Field label="Target amount (USD)">{(id) => <Input id={id} name="target" type="number" min="0" step="0.01" inputMode="decimal" placeholder="100.00" />}</Field>
        <Field label="Category">{(id) => (
          <select id={id} name="kind" className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
            {['custom', 'bike', 'vacation', 'college', 'car', 'giving', 'emergency'].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}</Field>
        <Field label="Whose goal?">{(id) => (
          <select id={id} value={childId} onChange={(e) => setChildId(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
            <option value="">Family goal</option>
            {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}>Create Goal</Button>
        </div>
      </form>
    </Modal>
  );
}

function FundGoalModal({ goal, onClose }: { goal: GoalView; onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const remaining = Math.max(0, goal.targetCents - goal.savedCents);

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

  return (
    <Modal open onClose={onClose} title={`Fund — ${goal.title}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">Moves money from {goal.childName}&apos;s Save bucket into this goal. {formatCents(remaining)} to go.</p>
        <Field label="Amount (USD)">{(id) => <Input id={id} type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" autoFocus />}</Field>
        <div className="flex items-center gap-2 text-xs text-muted"><PiggyBank className="h-3.5 w-3.5" /> Saved {formatCents(goal.savedCents)} of {formatCents(goal.targetCents)}</div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Cancel</Button>
          <Button type="submit" loading={loading}>Move to goal</Button>
        </div>
      </form>
    </Modal>
  );
}
