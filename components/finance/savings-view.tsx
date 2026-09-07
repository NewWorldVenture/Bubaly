'use client';

import { useState } from 'react';
import { Target, Plus, Trash2, TrendingUp } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { contributeToGoalAction, createSavingsGoalAction, deleteSavingsGoalAction } from '@/app/(app)/dashboard/billing/actions';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';
import { usd, pct, fmtDueDate } from '@/lib/finance/hub';
import { useTranslations } from '@/components/i18n/locale-provider';

type Goal = Tables<'savings_goals'>;
const EMOJIS = ['🎯', '🏖️', '🚗', '🏠', '🎓', '🎁', '💍', '🎄', '💻', '⚽'];

export function SavingsView() {
  const t = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: goals, loading } = useRealtimeQuery<Goal>({
    table: 'savings_goals', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('savings_goals').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const [form, setForm] = useState(false);
  const [contribute, setContribute] = useState<Goal | null>(null);
  const rows = goals ?? [];

  async function addAmount(g: Goal, delta: number) {
    // The DELTA, not a total computed here. This used to send
    // `current_amount + delta` from what the page last rendered, so two parents
    // each adding the same amount at once both wrote the same figure and one of
    // the contributions vanished. The service applies it under a compare-and-set.
    const res = await contributeToGoalAction(g.id, delta);
    if (!res.ok) toastError(res.error); else success(t('savingsView.updated'));
    setContribute(null);
  }
  async function remove(id: string) {
    if (!confirm(t('savingsView.deleteThisGoal'))) return;
    const res = await deleteSavingsGoalAction(id);
    if (!res.ok) toastError(res.error); else success(t('savingsView.deleted'));
  }

  return (
    <div className="module-page">
      <PageHeader title={t('savings.savingsGoals')} description={t('savingsView.setTargetsAndWatchYour')}
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('savings.addGoal')}</Button>} />

      {loading ? <SkeletonList /> : rows.length === 0 ? (
        <EmptyState icon={Target} title={t('savings.noSavingsGoals')} description={t('savingsView.createAGoalToStart')}
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('savings.addGoal')}</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((g) => {
            const p = pct(Number(g.current_amount), Number(g.target_amount));
            return (
              <div key={g.id} className="group rounded-2xl border border-border bg-surface/40 p-4">
                <div className="mb-2 flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{g.emoji || '🎯'}</span>
                    <div>
                      <p className="font-semibold">{g.name}</p>
                      {g.target_date && <p className="text-xs text-muted">by {fmtDueDate(g.target_date)}</p>}
                    </div>
                  </div>
                  <button onClick={() => remove(g.id)} className="rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={t('savingsView.delete')}><Trash2 className="h-4 w-4" /></button>
                </div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="font-bold tabular-nums">{usd(Number(g.current_amount))}</span>
                  <span className="text-xs text-muted">of {usd(Number(g.target_amount))} · {p}%</span>
                </div>
                <div className="h-2 rounded-full bg-border"><div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${p}%` }} /></div>
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => setContribute(g)}><TrendingUp className="h-4 w-4" />{' '}{t('savingsView.addFunds')}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {form && <GoalModal familyId={familyId} userId={userId} onClose={() => setForm(false)} />}
      {contribute && <ContributeModal goal={contribute} onAdd={(d) => addAmount(contribute, d)} onClose={() => setContribute(null)} />}
    </div>
  );
}

function GoalModal({ familyId, userId, onClose }: { familyId: string; userId: string; onClose: () => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ name: '', target_amount: '', current_amount: '', target_date: '', emoji: '🎯' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.name.trim() || !v.target_amount) return toastError(t('savingsView.addANameAndTarget'));
    setSaving(true);
    const res = await createSavingsGoalAction({
      name: v.name.trim(),
      targetAmount: Math.abs(parseFloat(v.target_amount) || 0),
      currentAmount: Math.abs(parseFloat(v.current_amount) || 0),
      targetDate: v.target_date || null,
      emoji: v.emoji,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error);
    success(t('savingsView.goalCreated'));
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('savings.addSavingsGoal')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('savings.goalName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('savingsView.familyVacation')} required autoFocus />}</Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('savings.icon')}</p>
          <div className="flex flex-wrap gap-1.5">{EMOJIS.map((e) => <button key={e} type="button" onClick={() => setV({ ...v, emoji: e })} className={`rounded-lg p-1.5 text-lg transition hover:bg-elevated ${v.emoji === e ? 'bg-brand/15 ring-2 ring-brand/40' : ''}`}>{e}</button>)}</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('savings.target')}>{(id) => <Input id={id} type="number" step="0.01" value={v.target_amount} onChange={(e) => setV({ ...v, target_amount: e.target.value })} placeholder="3000" required />}</Field>
          <Field label={t('savings.saved')} hint={t('savingsView.optional')}>{(id) => <Input id={id} type="number" step="0.01" value={v.current_amount} onChange={(e) => setV({ ...v, current_amount: e.target.value })} placeholder="0" />}</Field>
          <Field label="By" hint={t('savingsView.optional')}>{(id) => <Input id={id} type="date" value={v.target_date} onChange={(e) => setV({ ...v, target_date: e.target.value })} />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('savings.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.name.trim() || !v.target_amount}>{t('savings.create')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ContributeModal({ goal, onAdd, onClose }: { goal: Goal; onAdd: (delta: number) => void; onClose: () => void }) {
  const t = useTranslations();
  const [amt, setAmt] = useState('');
  return (
    <Modal open onClose={onClose} title={`Add to ${goal.name}`}>
      <form onSubmit={(e) => { e.preventDefault(); onAdd(Math.abs(parseFloat(amt) || 0)); }} className="space-y-4">
        <Field label={t('savings.amount')}>{(id) => <Input id={id} type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="50" required autoFocus />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('savings.cancel')}</Button>
          <Button type="submit" disabled={!amt}>{t('savings.addFunds')}</Button>
        </div>
      </form>
    </Modal>
  );
}
