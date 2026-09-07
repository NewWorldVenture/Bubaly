'use client';

import { useEffect, useMemo, useState } from 'react';
import { MoonStar, Plus, Sparkles, Sunrise, BedDouble, Activity, ListChecks, Pencil, Trash2, Check, TrendingUp, TrendingDown, Minus, ClipboardCheck } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { ageOn } from '@/lib/members/age';
import {
  SLEEP_SOURCES, durationMinutes, fmtHours, habitCorrelations, recentLogs, recommendedSleepHours, routineStepIdeas, sleepSummary, weeklyProgram, dayDiff,
} from '@/lib/sleep/coach';
import { useTranslations } from '@/components/i18n/locale-provider';

type Log = Tables<'sleep_logs'>;
type Routine = Tables<'bedtime_routines'>;
type Checkin = Tables<'sleep_checkins'>;

const todayIso = () => new Date().toISOString().slice(0, 10);
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function SleepModule() {
  const t = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const logs = useRealtimeQuery<Log>({
    table: 'sleep_logs', familyId,
    fetcher: (s) => s.from('sleep_logs').select('*').eq('family_id', familyId).order('sleep_date', { ascending: false }).limit(600),
    deps: [familyId],
  });
  const routines = useRealtimeQuery<Routine>({
    table: 'bedtime_routines', familyId,
    fetcher: (s) => s.from('bedtime_routines').select('*').eq('family_id', familyId).eq('is_active', true),
    deps: [familyId],
  });
  const checkins = useRealtimeQuery<Checkin>({
    table: 'sleep_checkins', familyId,
    fetcher: (s) => s.from('sleep_checkins').select('*').eq('family_id', familyId).order('checkin_date', { ascending: false }).limit(400),
    deps: [familyId],
  });

  const [memberId, setMemberId] = useState('');
  useEffect(() => { if (!memberId && members.length) setMemberId(selfMember?.id ?? members[0].id); }, [members, selfMember, memberId]);
  const [logOpen, setLogOpen] = useState(false);
  const [routineOpen, setRoutineOpen] = useState(false);
  const [checkinOpen, setCheckinOpen] = useState(false);

  const today = useMemo(() => new Date(), []);
  const member = members.find((m) => m.id === memberId) ?? null;
  const age = ageOn(member?.birthday, today);
  const routine = routines.data.find((r) => r.member_id === memberId) ?? null;
  const memberLogs = useMemo(() => logs.data.filter((l) => l.member_id === memberId), [logs.data, memberId]);
  const memberCheckins = useMemo(() => checkins.data.filter((c) => c.member_id === memberId), [checkins.data, memberId]);
  const summary = useMemo(() => sleepSummary(memberLogs, routine, age, today, memberId), [memberLogs, routine, age, today, memberId]);
  const fortnight = useMemo(() => recentLogs(memberLogs, memberId, today, 14).slice().reverse(), [memberLogs, memberId, today]);
  const correlations = useMemo(() => habitCorrelations(recentLogs(memberLogs, memberId, today, 30), memberCheckins), [memberLogs, memberCheckins, memberId, today]);
  const program = useMemo(() => weeklyProgram(summary, correlations, routine), [summary, correlations, routine]);
  const todaysCheckin = memberCheckins.find((c) => c.checkin_date === todayIso()) ?? null;
  const maxMinutes = Math.max(summary.target.max * 60, ...fortnight.map((l) => l.duration_min), 1);

  async function deleteLog(log: Log) {
    const { error } = await createClient().from('sleep_logs').delete().eq('id', log.id);
    if (error) return toastError(describeDbError(error));
    success('Night removed');
  }

  async function archiveRoutine(r: Routine) {
    if (!confirm(`Retire “${r.name}”?`)) return;
    const { error } = await createClient().from('bedtime_routines').update({ is_active: false }).eq('id', r.id);
    if (error) return toastError(describeDbError(error));
    success('Routine retired');
  }

  const loading = logs.loading || routines.loading || checkins.loading;
  const error = logs.error || routines.error || checkins.error;
  const refresh = () => { void logs.refresh(); void routines.refresh(); void checkins.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={t('sleepModule.couldNotLoadSleepData')} onRetry={refresh} />;

  const TrendIcon = summary.trend === 'improving' ? TrendingUp : summary.trend === 'slipping' ? TrendingDown : Minus;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('sleep.sleepCoach')}
        description={t('sleepModule.ageAwareTargetsForEvery')}
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="sleep" iconOnly />
            <Button variant="secondary" onClick={() => setCheckinOpen(true)}><ClipboardCheck className="h-4 w-4" /> {todaysCheckin ? 'Edit check-in' : '2-min check-in'}</Button>
            <Button onClick={() => setLogOpen(true)}><Plus className="h-4 w-4" /> {t('sleep.logLastNight')}</Button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('sleep.familyMember')}>
        {members.map((m) => {
          const a = ageOn(m.birthday, today);
          return (
            <button key={m.id} role="tab" aria-selected={m.id === memberId} onClick={() => setMemberId(m.id)}
              className={cn('rounded-full border px-3 py-1.5 text-sm transition coarse:min-h-11', m.id === memberId ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
              {m.display_name}{a !== null ? <span className="ml-1 text-xs opacity-70">· {recommendedSleepHours(a).min}–{recommendedSleepHours(a).max}h</span> : null}
            </button>
          );
        })}
      </div>

      {/* Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><BedDouble className="h-4 w-4 text-brand-text" /> {t('sleep.lastNight')}</div>
          {summary.lastNight ? (
            <>
              <p className="mt-2 text-2xl font-bold">{fmtHours(summary.lastNight.duration_min)}</p>
              <p className="mt-1 text-xs text-muted">{fmtTime(summary.lastNight.bedtime)} → {fmtTime(summary.lastNight.wake_time)}{summary.lastNight.quality ? ` · quality ${summary.lastNight.quality}/5` : ''}{summary.lastNight.awakenings ? ` · woke ${summary.lastNight.awakenings}×` : ''}</p>
            </>
          ) : <p className="mt-2 text-sm text-muted">{t('sleep.notLoggedYet')}</p>}
        </div>
        <div className={cn('rounded-2xl border p-5', summary.status === 'short' ? 'border-amber-500/30 bg-amber-500/10' : summary.status === 'on_track' ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-surface/40')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><MoonStar className="h-4 w-4 text-brand-text" /> {t('sleep.thisWeek')}</div>
          <p className="mt-2 text-lg font-bold">{summary.text}</p>
          <p className="mt-1 text-xs text-muted">{summary.nights} {t('sleep.of7NightsLoggedTarget')} {summary.target.min}–{summary.target.max}{t('sleep.h')}{summary.target.label})</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4 text-brand-text" /> {t('sleep.consistency')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.consistency !== null ? `${summary.consistency}/100` : '—'}</p>
          <p className="mt-1 text-xs text-muted">{summary.adherence !== null ? `${summary.adherence}% of nights within 30 min of the routine` : 'Same bedtime every night scores 100'}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><TrendIcon className="h-4 w-4 text-brand-text" /> {t('sleep.trend')}</div>
          <p className="mt-2 text-2xl font-bold capitalize">{summary.trend === 'unknown' ? '—' : summary.trend}</p>
          <p className="mt-1 text-xs text-muted">{summary.debtMinutes > 0 ? `${fmtHours(summary.debtMinutes)} of sleep debt this week` : 'No sleep debt this week'}</p>
        </div>
      </div>

      {/* Chart */}
      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">{t('sleep.last14Nights')}</span>
          <span className="text-xs text-muted">{t('sleep.band')} {summary.target.min}–{summary.target.max}{t('sleep.hTarget')}</span>
        </div>
        {fortnight.length === 0 ? (
          <EmptyState icon={MoonStar} title={t('sleep.noNightsLogged')} description={t('sleepModule.logLastNightAndThe')} action={<Button onClick={() => setLogOpen(true)}><Plus className="h-4 w-4" /> {t('sleep.logLastNight')}</Button>} />
        ) : (
          <div className="relative h-40">
            <div className="absolute inset-x-0 border-t border-dashed border-emerald-400/40" style={{ bottom: `${(summary.target.min * 60 / maxMinutes) * 100}%` }} />
            <div className="absolute inset-x-0 border-t border-dashed border-emerald-400/25" style={{ bottom: `${(summary.target.max * 60 / maxMinutes) * 100}%` }} />
            <ul className="flex h-full items-end gap-1.5">
              {fortnight.map((l) => {
                const short = l.duration_min < summary.target.min * 60;
                return (
                  <li key={l.id} className="group relative flex h-full flex-1 flex-col justify-end" title={`${l.sleep_date}: ${fmtHours(l.duration_min)}`}>
                    <div className={cn('rounded-t-md transition', short ? 'bg-amber-400/70' : 'bg-brand/70')} style={{ height: `${(l.duration_min / maxMinutes) * 100}%` }} />
                    <span className="mt-1 text-center text-[10px] text-muted">{fmtDay(l.sleep_date)}</span>
                    <button onClick={() => deleteLog(l)} aria-label={`Delete night ${l.sleep_date}`} className="absolute -top-1 right-0 hidden rounded p-0.5 text-muted hover:text-rose-400 group-hover:block"><Trash2 className="h-3 w-3" /></button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Routine */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold"><ListChecks className="h-4 w-4 text-brand-text" /> {t('sleep.bedtimeRoutine')}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setRoutineOpen(true)} aria-label={routine ? 'Edit routine' : 'Create routine'} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
              {routine && <button onClick={() => archiveRoutine(routine)} aria-label={t('sleep.retireRoutine')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}
            </div>
          </div>
          {routine ? (
            <>
              <p className="text-sm">{routine.name} {t('sleep.lightsOut')} <span className="font-semibold">{routine.target_bedtime.slice(0, 5)}</span>{t('sleep.upAt')} <span className="font-semibold">{routine.target_wake.slice(0, 5)}</span></p>
              <p className="mt-1 text-xs text-muted">{routine.wind_down_min} {t('sleep.minWindDown')} {routine.days_of_week.length === 7 ? 'every night' : routine.days_of_week.map((d) => DAYS[d]).join(', ')}</p>
              <ol className="mt-3 space-y-1 text-sm">
                {routine.steps.map((s, i) => <li key={i} className="flex items-center gap-2"><span className="grid h-5 w-5 place-items-center rounded-full bg-brand/15 text-[10px] text-brand-text">{i + 1}</span>{s}</li>)}
              </ol>
            </>
          ) : (
            <div className="text-sm text-muted">
              <p>{t('sleep.noRoutineYetFor')} {member?.display_name ?? 'this member'}.</p>
              <p className="mt-2 text-xs">{t('sleep.ideasForA')} {recommendedSleepHours(age).label}: {routineStepIdeas(age).join(' → ')}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => setRoutineOpen(true)}><Plus className="h-3.5 w-3.5" /> {t('sleep.setOneUp')}</Button>
            </div>
          )}
        </div>

        {/* Program */}
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5 lg:col-span-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-text"><Sparkles className="h-4 w-4" /> {t('sleep.thisWeeksProgramFor')} {member?.display_name ?? 'you'}</div>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {program.map((step) => (
              <li key={step.day} className="flex gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/15 text-xs font-semibold text-brand-text">D{step.day}</span>
                <div className="min-w-0"><p className="text-sm font-medium">{step.title}</p><p className="text-xs text-muted">{step.detail}</p></div>
              </li>
            ))}
          </ol>
          {correlations.some((c) => c.deltaMinutes !== null) && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs font-semibold text-muted">{t('sleep.whatYourOwnNightsSay')}</p>
              <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-3">
                {correlations.filter((c) => c.deltaMinutes !== null).map((c) => (
                  <li key={c.factor} className={cn('rounded-lg border px-2 py-1', (c.deltaMinutes ?? 0) < -15 ? 'border-amber-500/30 text-amber-200' : (c.deltaMinutes ?? 0) > 15 ? 'border-emerald-500/30 text-emerald-200' : 'border-border text-muted')}>
                    {c.factor}: {(c.deltaMinutes ?? 0) >= 0 ? '+' : '−'}{fmtHours(Math.abs(c.deltaMinutes ?? 0))} ({c.nights} nights)
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {logOpen && memberId && (
        <LogForm familyId={familyId} userId={userId} memberId={memberId} existing={memberLogs.find((l) => l.sleep_date === todayIso()) ?? null} onClose={() => setLogOpen(false)} onSaved={() => { setLogOpen(false); success('Night logged'); }} />
      )}
      {routineOpen && memberId && (
        <RoutineForm familyId={familyId} userId={userId} memberId={memberId} age={age} routine={routine} onClose={() => setRoutineOpen(false)} onSaved={() => { setRoutineOpen(false); success('Routine saved'); }} />
      )}
      {checkinOpen && memberId && (
        <CheckinForm familyId={familyId} userId={userId} memberId={memberId} existing={todaysCheckin} onClose={() => setCheckinOpen(false)} onSaved={() => { setCheckinOpen(false); success('Check-in saved'); }} />
      )}
    </div>
  );
}

function LogForm({ familyId, userId, memberId, existing, onClose, onSaved }: { familyId: string; userId: string; memberId: string; existing: Log | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const defaultBed = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(21, 30, 0, 0); return existing ? new Date(existing.bedtime) : d; }, [existing]);
  const defaultWake = useMemo(() => { const d = new Date(); d.setHours(7, 0, 0, 0); return existing ? new Date(existing.wake_time) : d; }, [existing]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const bedtime = new Date(String(f.get('bedtime') ?? ''));
    const wake = new Date(String(f.get('wake_time') ?? ''));
    if (Number.isNaN(bedtime.getTime()) || Number.isNaN(wake.getTime())) return toastError('Enter both times');
    const duration = durationMinutes(bedtime.toISOString(), wake.toISOString());
    if (duration === 0) return toastError('Wake time must be after bedtime');
    setLoading(true);
    const sleepDate = `${wake.getFullYear()}-${String(wake.getMonth() + 1).padStart(2, '0')}-${String(wake.getDate()).padStart(2, '0')}`;
    const { error } = await createClient().from('sleep_logs').upsert({
      family_id: familyId, member_id: memberId, sleep_date: sleepDate, bedtime: bedtime.toISOString(), wake_time: wake.toISOString(), duration_min: duration,
      quality: f.get('quality') ? Number(f.get('quality')) : null, awakenings: Number(f.get('awakenings') ?? 0),
      source: String(f.get('source') ?? 'manual') as Log['source'], notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    }, { onConflict: 'member_id,sleep_date' });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={t('sleep.logANight')} description={t('sleepModule.theNightIsFiledUnder')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('sleep.lightsOut')} required>{(id) => <Input id={id} name="bedtime" type="datetime-local" defaultValue={localInput(defaultBed)} />}</Field>
          <Field label={t('sleep.wokeUp')} required>{(id) => <Input id={id} name="wake_time" type="datetime-local" defaultValue={localInput(defaultWake)} />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('sleep.quality')}>{(id) => <Select id={id} name="quality" defaultValue={existing?.quality ?? ''}><option value="">{t('sleep.skip')}</option>{[5, 4, 3, 2, 1].map((q) => <option key={q} value={q}>{q}/5</option>)}</Select>}</Field>
          <Field label={t('sleep.wokeUpTimes')}>{(id) => <Input id={id} name="awakenings" type="number" min={0} max={50} defaultValue={existing?.awakenings ?? 0} />}</Field>
          <Field label={t('sleep.source')}>{(id) => <Select id={id} name="source" defaultValue={existing?.source ?? 'manual'}>{SLEEP_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
        </div>
        <Field label={t('sleep.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={existing?.notes ?? ''} placeholder={t('sleep.badDreamAt2amSleptIn')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('sleep.cancel')}</Button>
          <Button type="submit" loading={loading}><Sunrise className="h-4 w-4" /> {t('sleep.saveNight')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function RoutineForm({ familyId, userId, memberId, age, routine, onClose, onSaved }: { familyId: string; userId: string; memberId: string; age: number | null; routine: Routine | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState<number[]>(routine?.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const steps = String(f.get('steps') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!days.length) return toastError('Pick at least one night');
    setLoading(true);
    const payload = {
      name: String(f.get('name') ?? '').trim() || 'Bedtime routine',
      target_bedtime: String(f.get('target_bedtime') ?? '21:00'),
      target_wake: String(f.get('target_wake') ?? '07:00'),
      wind_down_min: Number(f.get('wind_down_min') ?? 30),
      steps, days_of_week: days, is_active: true,
    };
    const supabase = createClient();
    const { error } = routine
      ? await supabase.from('bedtime_routines').update(payload).eq('id', routine.id)
      : await supabase.from('bedtime_routines').insert({ family_id: familyId, member_id: memberId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={routine ? 'Edit bedtime routine' : 'Set up a bedtime routine'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('sleep.name')}>{(id) => <Input id={id} name="name" defaultValue={routine?.name ?? 'School-night routine'} />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('sleep.lightsOut')}>{(id) => <Input id={id} name="target_bedtime" type="time" defaultValue={routine?.target_bedtime.slice(0, 5) ?? (age !== null && age < 13 ? '20:30' : '22:00')} />}</Field>
          <Field label={t('sleep.wake')}>{(id) => <Input id={id} name="target_wake" type="time" defaultValue={routine?.target_wake.slice(0, 5) ?? '07:00'} />}</Field>
          <Field label={t('sleep.windDownMin')}>{(id) => <Input id={id} name="wind_down_min" type="number" min={0} max={240} defaultValue={routine?.wind_down_min ?? 30} />}</Field>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{t('sleep.nights')}</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => { const on = days.includes(i); return <button type="button" key={d} aria-pressed={on} onClick={() => setDays(on ? days.filter((x) => x !== i) : [...days, i].sort())} className={cn('rounded-full border px-3 py-1 text-xs coarse:min-h-11', on ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{d}</button>; })}
          </div>
        </div>
        <Field label={t('sleep.stepsOnePerLine')} hint={`Ideas: ${routineStepIdeas(age).join(' → ')}`}>{(id) => <Textarea id={id} name="steps" rows={4} defaultValue={routine?.steps.join('\n') ?? routineStepIdeas(age).join('\n')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('sleep.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {t('sleep.saveRoutine')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CheckinForm({ familyId, userId, memberId, existing, onClose, onSaved }: { familyId: string; userId: string; memberId: string; existing: Checkin | null; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [energy, setEnergy] = useState(existing?.energy ?? 3);
  const [mood, setMood] = useState(existing?.mood ?? 3);
  const [caffeine, setCaffeine] = useState(existing?.caffeine_after_2pm ?? false);
  const [screens, setScreens] = useState(existing?.screens_in_bed ?? false);
  const [exercised, setExercised] = useState(existing?.exercised ?? false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    const { error } = await createClient().from('sleep_checkins').upsert({
      family_id: familyId, member_id: memberId, checkin_date: todayIso(), energy, mood, caffeine_after_2pm: caffeine, screens_in_bed: screens, exercised,
      notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    }, { onConflict: 'member_id,checkin_date' });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  const Scale = ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      <div className="flex gap-2" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((v) => <button type="button" key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={cn('h-10 w-10 rounded-xl border text-sm coarse:min-h-11', value === v ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{v}</button>)}
      </div>
    </div>
  );
  const Toggle = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <button type="button" aria-pressed={value} onClick={() => onChange(!value)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', value ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{label}</button>
  );

  return (
    <Modal open title={t('sleep.twoMinuteCheckIn')} description={t('sleepModule.todaySHabitsSoThe')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Scale label={t('sleep.energyToday')} value={energy} onChange={setEnergy} />
        <Scale label={t('sleep.moodToday')} value={mood} onChange={setMood} />
        <div className="flex flex-wrap gap-2">
          <Toggle label={t('sleep.caffeineAfter2pm')} value={caffeine} onChange={setCaffeine} />
          <Toggle label={t('sleep.screensInBed')} value={screens} onChange={setScreens} />
          <Toggle label={t('sleep.exercised')} value={exercised} onChange={setExercised} />
        </div>
        <Field label={t('sleep.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={existing?.notes ?? ''} placeholder={t('sleep.napAfterSchoolLatePractice')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{t('sleep.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {t('sleep.saveCheckIn')}</Button>
        </div>
      </form>
    </Modal>
  );
}
