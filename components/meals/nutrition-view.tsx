'use client';

import { useMemo, useState } from 'react';
import { Apple, Plus, Trash2, Flame, Droplet } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { dailyTotals, groupByMeal, todayKey, MEAL_META, MEALS } from '@/lib/meals/tracker';
import { useTranslations } from '@/components/i18n/locale-provider';

type Log = Tables<'nutrition_logs'>;

export function NutritionView() {
  const t = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const today = todayKey();
  const [member, setMember] = useState<string>(selfMember?.id ?? members[0]?.id ?? '');
  const [form, setForm] = useState(false);

  const { data: rows, loading, error, refresh } = useRealtimeQuery<Log>({
    table: 'nutrition_logs', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('nutrition_logs').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(400),
  });

  const logs = useMemo(() => rows ?? [], [rows]);
  const todayLogs = useMemo(() => logs.filter((l) => l.logged_on === today && (!member || l.member_id === member)), [logs, today, member]);
  const totals = useMemo(() => dailyTotals(logs, today, member || undefined), [logs, today, member]);
  const byMeal = useMemo(() => groupByMeal(todayLogs), [todayLogs]);

  async function remove(id: string) {
    const { error } = await createClient().from('nutrition_logs').delete().eq('id', id);
    if (error) toastError(error.message);
  }

  // A genuine read failure must surface + be retryable, not silently render as an
  // empty tracker. (Missing-table/offline are already degraded to empty by the hook.)
  if (error) return <ErrorState message={t('nutritionView.couldNotLoadNutritionLogs')} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader title={t('nutrition.nutritionTracker')} description={t('nutritionView.logMealsAndTrackCalories')}
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('nutrition.logFood')}</Button>} />

      {/* Member tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {members.filter((m) => m.is_active).map((m) => (
          <button key={m.id} onClick={() => setMember(m.id)}
            className={cn('flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition', member === m.id ? 'bg-brand text-brand-fg' : 'bg-surface/60 hover:bg-surface')}>
            <Avatar name={m.display_name} color={m.color} size={20} /> {m.display_name}
          </button>
        ))}
      </div>

      {/* Today's totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('nutrition.calories')} value={totals.calories.toLocaleString()} icon={Flame} tint="text-amber-400" />
        <Stat label={t('nutrition.protein')} value={`${totals.protein_g}g`} icon={Apple} tint="text-emerald-400" />
        <Stat label={t('nutrition.carbsFat')} value={`${totals.carbs_g} / ${totals.fat_g}g`} icon={Apple} tint="text-blue-400" />
        <Stat label={t('nutrition.water')} value={`${(totals.water_ml / 1000).toFixed(1)}L`} icon={Droplet} tint="text-sky-400" />
      </div>

      {loading ? <SkeletonList /> : todayLogs.length === 0 ? (
        <EmptyState icon={Apple} title={t('nutrition.nothingLoggedToday')} description={t('nutritionView.logAMealOrSnack')}
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('nutrition.logFood')}</Button>} />
      ) : (
        <div className="space-y-4">
          {byMeal.map(({ meal, items }) => (
            <section key={meal}>
              <h2 className="mb-2 text-sm font-bold">{MEAL_META[meal]?.emoji} {MEAL_META[meal]?.label ?? meal}</h2>
              <div className="space-y-1.5">
                {items.map((l) => (
                  <div key={l.id} className="group flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{l.item}</p>
                      <p className="truncate text-xs text-muted">{l.calories} cal · P {Number(l.protein_g)}g · C {Number(l.carbs_g)}g · F {Number(l.fat_g)}g{l.water_ml ? ` · 💧 ${l.water_ml}ml` : ''}</p>
                    </div>
                    <button onClick={() => remove(l.id)} className="rounded-lg p-1.5 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={t('nutritionView.delete')}><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {form && <LogModal members={members} defaultMember={member} familyId={familyId} userId={userId} onClose={() => setForm(false)} />}
    </div>
  );
}

function Stat({ label, value, icon: Icon, tint }: { label: string; value: string; icon: typeof Apple; tint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">{label}</p><Icon className={cn('h-4 w-4', tint)} /></div>
      <p className={cn('text-xl font-black tabular-nums', tint)}>{value}</p>
    </div>
  );
}

function LogModal({ members, defaultMember, familyId, userId, onClose }: { members: Tables<'family_members'>[]; defaultMember: string; familyId: string; userId: string; onClose: () => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ member_id: defaultMember, meal: 'breakfast', item: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', water_ml: '', logged_on: todayKey() });

  const num = (x: string) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.item.trim()) return toastError('Add a food item');
    setSaving(true);
    const { error } = await createClient().from('nutrition_logs').insert({
      family_id: familyId, member_id: v.member_id || null, logged_on: v.logged_on, meal: v.meal, item: v.item.trim(),
      calories: Math.round(num(v.calories)), protein_g: num(v.protein_g), carbs_g: num(v.carbs_g), fat_g: num(v.fat_g),
      water_ml: Math.round(num(v.water_ml)), created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Logged');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('nutrition.logFood')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('nutrition.foodItem')}>{(id) => <Input id={id} value={v.item} onChange={(e) => setV({ ...v, item: e.target.value })} placeholder={t('nutritionView.oatmealWithBerries')} required autoFocus />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('nutrition.member')}>{(id) => <Select id={id} value={v.member_id} onChange={(e) => setV({ ...v, member_id: e.target.value })}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label={t('nutrition.meal')}>{(id) => <Select id={id} value={v.meal} onChange={(e) => setV({ ...v, meal: e.target.value })}>{MEALS.map((m) => <option key={m} value={m}>{MEAL_META[m].label}</option>)}</Select>}</Field>
          <Field label={t('nutrition.date')}>{(id) => <Input id={id} type="date" value={v.logged_on} onChange={(e) => setV({ ...v, logged_on: e.target.value })} />}</Field>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Field label={t('nutrition.calories')}>{(id) => <Input id={id} type="number" value={v.calories} onChange={(e) => setV({ ...v, calories: e.target.value })} placeholder="320" />}</Field>
          <Field label={t('nutrition.protein')}>{(id) => <Input id={id} type="number" step="0.1" value={v.protein_g} onChange={(e) => setV({ ...v, protein_g: e.target.value })} placeholder="12" />}</Field>
          <Field label={t('nutrition.carbs')}>{(id) => <Input id={id} type="number" step="0.1" value={v.carbs_g} onChange={(e) => setV({ ...v, carbs_g: e.target.value })} placeholder="45" />}</Field>
          <Field label="Fat">{(id) => <Input id={id} type="number" step="0.1" value={v.fat_g} onChange={(e) => setV({ ...v, fat_g: e.target.value })} placeholder="8" />}</Field>
        </div>
        <Field label={t('nutrition.waterMl')} hint={t('nutritionView.optional')}>{(id) => <Input id={id} type="number" value={v.water_ml} onChange={(e) => setV({ ...v, water_ml: e.target.value })} placeholder="250" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('nutrition.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.item.trim()}>Log</Button>
        </div>
      </form>
    </Modal>
  );
}
