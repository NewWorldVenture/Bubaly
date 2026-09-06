'use client';

import { useState } from 'react';
import { Target, Plus, Trash2, TrendingUp } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
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
    const next = Math.max(0, Number(g.current_amount) + delta);
    const { error } = await createClient().from('savings_goals').update({ current_amount: next }).eq('id', g.id);
    if (error) toastError(error.message); else success('Updated');
    setContribute(null);
  }
  async function remove(id: string) {
    if (!confirm('Delete this goal?')) return;
    const { error } = await createClient().from('savings_goals').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  return (
    <div className="module-page">
      <PageHeader title={t('savings.savingsGoals')} description="Set targets and watch your family's savings grow."
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('savings.addGoal')}</Button>} />

      {loading ? <SkeletonList /> : rows.length === 0 ? (
        <EmptyState icon={Target} title={t('savings.noSavingsGoals')} description="Create a goal to start saving toward something special."
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
                  <button onClick={() => remove(g.id)} className="rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="font-bold tabular-nums">{usd(Number(g.current_amount))}</span>
                  <span className="text-xs text-muted">of {usd(Number(g.target_amount))} · {p}%</span>
                </div>
                <div className="h-2 rounded-full bg-border"><div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${p}%` }} /></div>
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={() => setContribute(g)}><TrendingUp className="h-4 w-4" /> Add funds</Button>
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
    if (!v.name.trim() || !v.target_amount) return toastError('Add a name and target');
    setSaving(true);
    const { error } = await createClient().from('savings_goals').insert({
      family_id: familyId, name: v.name.trim(), target_amount: Math.abs(parseFloat(v.target_amount) || 0),
      current_amount: Math.abs(parseFloat(v.current_amount) || 0), target_date: v.target_date || null, emoji: v.emoji, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Goal created');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('savings.addSavingsGoal')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('savings.goalName')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Family vacation" required autoFocus />}</Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('savings.icon')}</p>
          <div className="flex flex-wrap gap-1.5">{EMOJIS.map((e) => <button key={e} type="button" onClick={() => setV({ ...v, emoji: e })} className={`rounded-lg p-1.5 text-lg transition hover:bg-elevated ${v.emoji === e ? 'bg-brand/15 ring-2 ring-brand/40' : ''}`}>{e}</button>)}</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('savings.target')}>{(id) => <Input id={id} type="number" step="0.01" value={v.target_amount} onChange={(e) => setV({ ...v, target_amount: e.target.value })} placeholder="3000" required />}</Field>
          <Field label={t('savings.saved')} hint="Optional">{(id) => <Input id={id} type="number" step="0.01" value={v.current_amount} onChange={(e) => setV({ ...v, current_amount: e.target.value })} placeholder="0" />}</Field>
          <Field label="By" hint="Optional">{(id) => <Input id={id} type="date" value={v.target_date} onChange={(e) => setV({ ...v, target_date: e.target.value })} />}</Field>
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
