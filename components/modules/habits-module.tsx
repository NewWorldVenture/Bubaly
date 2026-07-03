'use client';

// Habit Tracker — build personal & family routines with streaks, a heatmap,
// one-tap check-ins, and an AI coach. 100% Supabase-wired via the `habits` and
// `habit_logs` tables (family-scoped RLS); streak math lives in lib/habits.
import { useMemo, useState } from 'react';
import {
  Flame, Plus, Trash2, Check, Sparkles, X, Pencil, Trophy, Target, CalendarCheck, Archive,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  currentStreak, longestStreak, completionRate, heatmap, isDoneToday, toISODate, type HabitLike,
} from '@/lib/habits/streaks';
import type { HabitCoaching } from '@/lib/habits/ai';

type Habit = Tables<'habits'>;
type HabitLog = Tables<'habit_logs'>;

const COLORS = [
  { id: 'violet', dot: 'bg-violet-500', soft: 'bg-violet-500/10', ring: 'border-violet-500/40', text: 'text-violet-500' },
  { id: 'blue', dot: 'bg-blue-500', soft: 'bg-blue-500/10', ring: 'border-blue-500/40', text: 'text-blue-500' },
  { id: 'teal', dot: 'bg-teal-500', soft: 'bg-teal-500/10', ring: 'border-teal-500/40', text: 'text-teal-500' },
  { id: 'green', dot: 'bg-green-500', soft: 'bg-green-500/10', ring: 'border-green-500/40', text: 'text-green-500' },
  { id: 'amber', dot: 'bg-amber-500', soft: 'bg-amber-500/10', ring: 'border-amber-500/40', text: 'text-amber-500' },
  { id: 'orange', dot: 'bg-orange-500', soft: 'bg-orange-500/10', ring: 'border-orange-500/40', text: 'text-orange-500' },
  { id: 'rose', dot: 'bg-rose-500', soft: 'bg-rose-500/10', ring: 'border-rose-500/40', text: 'text-rose-500' },
  { id: 'pink', dot: 'bg-pink-500', soft: 'bg-pink-500/10', ring: 'border-pink-500/40', text: 'text-pink-500' },
] as const;
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function colorOf(id: string | null | undefined) {
  return COLORS.find((c) => c.id === id) ?? COLORS[0];
}

export function HabitsModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const today = toISODate(new Date());
  const [editing, setEditing] = useState<Habit | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [coachLoading, setCoachLoading] = useState(false);
  const [coaching, setCoaching] = useState<HabitCoaching | null>(null);

  const habitsQ = useRealtimeQuery<Habit>({
    table: 'habits',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('habits').select('*').eq('family_id', familyId).eq('is_active', true)
        .order('sort_order').order('created_at'),
  });

  const logsQ = useRealtimeQuery<HabitLog>({
    table: 'habit_logs',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('habit_logs').select('*').eq('family_id', familyId)
        .gte('log_date', toISODate(new Date(Date.now() - 120 * 86400000)))
        .order('log_date', { ascending: false }),
  });

  const logsByHabit = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of logsQ.data) {
      const arr = map.get(l.habit_id) ?? [];
      arr.push(l.log_date);
      map.set(l.habit_id, arr);
    }
    return map;
  }, [logsQ.data]);

  async function toggleToday(habit: Habit) {
    const supabase = createClient();
    const dates = logsByHabit.get(habit.id) ?? [];
    const done = isDoneToday(dates, today);
    if (done) {
      const { error } = await supabase.from('habit_logs').delete()
        .eq('family_id', familyId).eq('habit_id', habit.id).eq('log_date', today);
      if (error) return toastError(describeDbError(error));
    } else {
      const { error } = await supabase.from('habit_logs').insert({
        family_id: familyId, habit_id: habit.id,
        member_id: habit.member_id ?? selfMember?.id ?? null,
        log_date: today, count: 1, created_by: userId,
      });
      if (error) return toastError(describeDbError(error));
      success('Nice! Checked in for today 🔥');
    }
    void logsQ.refresh();
  }

  async function archive(habit: Habit) {
    const supabase = createClient();
    const { error } = await supabase.from('habits')
      .update({ is_active: false, archived_at: new Date().toISOString() }).eq('id', habit.id);
    if (error) return toastError(describeDbError(error));
    success('Habit archived');
    void habitsQ.refresh();
  }

  async function runCoach() {
    setCoachOpen(true);
    setCoachLoading(true);
    setCoaching(null);
    try {
      const res = await fetch('/api/ai/habits', { method: 'POST' });
      const json = (await res.json()) as { coaching?: HabitCoaching; error?: string };
      if (!res.ok || !json.coaching) throw new Error(json.error || 'Could not generate coaching');
      setCoaching(json.coaching);
    } catch (err) {
      toastError(describeDbError(err, 'Coach failed'));
      setCoachOpen(false);
    } finally {
      setCoachLoading(false);
    }
  }

  if (habitsQ.loading) return <SkeletonList />;
  if (habitsQ.error) return <ErrorState message={habitsQ.error} onRetry={habitsQ.refresh} />;

  const habits = habitsQ.data;
  const doneTodayCount = habits.filter((h) => isDoneToday(logsByHabit.get(h.id) ?? [], today)).length;
  const bestStreak = habits.reduce((m, h) => {
    const habit: HabitLike = { cadence: h.cadence, target_per_period: h.target_per_period, weekdays: h.weekdays };
    return Math.max(m, currentStreak(habit, logsByHabit.get(h.id) ?? [], today));
  }, 0);

  return (
    <div className="module-page">
      <PageHeader
        title="Habits"
        description="Build routines that stick — streaks, check-ins, and an AI coach."
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={runCoach}>
              <Sparkles className="h-4 w-4" /> AI Coach
            </Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> New Habit</Button>
          </div>
        }
      />

      {habits.length > 0 && (
        <div className="mb-5 grid grid-cols-3 gap-3">
          <StatCard icon={CalendarCheck} label="Done today" value={`${doneTodayCount}/${habits.length}`} />
          <StatCard icon={Flame} label="Best streak" value={`${bestStreak}d`} />
          <StatCard icon={Target} label="Active habits" value={`${habits.length}`} />
        </div>
      )}

      {habits.length === 0 ? (
        <EmptyState icon={Target} title="No habits yet"
          description="Start small — one habit, checked in daily, builds the routine."
          action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> New Habit</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {habits.map((h) => (
            <HabitCard key={h.id} habit={h} today={today} logDates={logsByHabit.get(h.id) ?? []}
              memberName={members.find((m) => m.id === h.member_id)?.display_name}
              onToggle={() => toggleToday(h)} onEdit={() => setEditing(h)} onArchive={() => archive(h)} />
          ))}
        </div>
      )}

      {(addOpen || editing) && (
        <HabitModal habit={editing} familyId={familyId} userId={userId}
          members={members} defaultMemberId={selfMember?.id ?? null}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void habitsQ.refresh(); }} />
      )}

      {coachOpen && (
        <Modal open onClose={() => setCoachOpen(false)} title="AI Habit Coach">
          {coachLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Sparkles className="h-4 w-4 animate-pulse text-brand" /> Analyzing your streaks…
            </div>
          ) : coaching ? (
            <div className="space-y-4">
              {coaching.headline && <p className="text-base font-semibold leading-relaxed">{coaching.headline}</p>}
              {coaching.nudges.length > 0 && (
                <ul className="space-y-2">
                  {coaching.nudges.map((n, i) => (
                    <li key={i} className="flex items-start gap-2 rounded-xl bg-surface/60 p-3 text-sm">
                      <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" /> {n}
                    </li>
                  ))}
                </ul>
              )}
              {coaching.suggestion && (
                <div className="rounded-xl border border-brand/30 bg-brand/5 p-3 text-sm">
                  <span className="font-semibold text-brand">Try this: </span>{coaching.suggestion}
                </div>
              )}
            </div>
          ) : null}
        </Modal>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Flame; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <Icon className="mb-2 h-4 w-4 text-muted" />
      <p className="text-xl font-bold">{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

function HabitCard({ habit, today, logDates, memberName, onToggle, onEdit, onArchive }: {
  habit: Habit; today: string; logDates: string[]; memberName?: string;
  onToggle: () => void; onEdit: () => void; onArchive: () => void;
}) {
  const c = colorOf(habit.color);
  const h: HabitLike = { cadence: habit.cadence, target_per_period: habit.target_per_period, weekdays: habit.weekdays };
  const streak = currentStreak(h, logDates, today);
  const best = longestStreak(h, logDates);
  const rate = Math.round(completionRate(h, logDates, today, 30) * 100);
  const cells = heatmap(h, logDates, today, 28);
  const done = isDoneToday(logDates, today);

  return (
    <div className={cn('group flex flex-col rounded-2xl border-2 p-4', c.soft, c.ring)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', c.dot)} />
            <p className="truncate font-semibold">{habit.title}</p>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {habit.cadence === 'weekly' ? `${habit.target_per_period}× / week` : 'Daily'}
            {memberName ? ` · ${memberName}` : ' · Family'}
          </p>
        </div>
        <button onClick={onToggle} aria-label="Toggle today"
          className={cn('flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 transition',
            done ? cn(c.dot, 'border-transparent text-white') : cn('border-border text-muted hover:border-current', c.text))}>
          <Check className="h-4 w-4" />
        </button>
      </div>

      {/* streak + stats */}
      <div className="mt-3 flex items-center gap-4 text-xs">
        <span className="flex items-center gap-1 font-semibold"><Flame className={cn('h-3.5 w-3.5', streak > 0 ? 'text-orange-500' : 'text-muted')} /> {streak}d</span>
        <span className="flex items-center gap-1 text-muted"><Trophy className="h-3.5 w-3.5" /> {best}d</span>
        <span className="text-muted">{rate}% · 30d</span>
      </div>

      {/* 28-day heatmap */}
      <div className="mt-3 grid grid-cols-7 gap-1">
        {cells.map((cell) => (
          <div key={cell.date} title={cell.date}
            className={cn('aspect-square rounded',
              !cell.scheduled ? 'bg-transparent' : cell.done ? c.dot : 'bg-border/50')} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1 text-center text-[9px] text-muted">
        {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>

      <div className="mt-3 flex justify-end gap-1 opacity-0 transition group-hover:opacity-100">
        <button onClick={onEdit} aria-label="Edit habit" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
        <button onClick={() => { if (confirm('Archive this habit?')) onArchive(); }} aria-label="Archive habit" className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Archive className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

function HabitModal({ habit, familyId, userId, members, defaultMemberId, onClose, onSaved }: {
  habit: Habit | null; familyId: string; userId: string;
  members: Tables<'family_members'>[]; defaultMemberId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [color, setColor] = useState(habit?.color ?? 'violet');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>(habit?.cadence ?? 'daily');
  const [target, setTarget] = useState(habit?.target_per_period ?? (habit?.cadence === 'weekly' ? 3 : 1));
  const [memberId, setMemberId] = useState<string | null>(habit ? habit.member_id : defaultMemberId);
  const [weekdays, setWeekdays] = useState<number[]>(habit?.weekdays ?? []);

  function toggleWeekday(i: number) {
    setWeekdays((w) => (w.includes(i) ? w.filter((x) => x !== i) : [...w, i].sort()));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const description = String(form.get('description') ?? '').trim() || null;
    if (!title) return toastError('Give your habit a name');
    setLoading(true);
    const supabase = createClient();
    const patch = {
      title, description, color, cadence,
      target_per_period: cadence === 'weekly' ? Math.max(1, target) : 1,
      member_id: memberId,
      weekdays: cadence === 'daily' ? weekdays : [],
    };
    const { error } = habit
      ? await supabase.from('habits').update(patch).eq('id', habit.id)
      : await supabase.from('habits').insert({ family_id: familyId, created_by: userId, ...patch });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    success(habit ? 'Habit saved' : 'Habit created');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={habit ? 'Edit Habit' : 'New Habit'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Habit">
          {(id) => <Input id={id} name="title" defaultValue={habit?.title ?? ''} placeholder="e.g. Morning walk, Read 20 min" autoFocus />}
        </Field>
        <Field label="Description (optional)">
          {(id) => <Textarea id={id} name="description" defaultValue={habit?.description ?? ''} placeholder="Why does this matter to you?" className="min-h-[60px]" />}
        </Field>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Color</label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button key={c.id} type="button" onClick={() => setColor(c.id)}
                className={cn('h-7 w-7 rounded-full transition hover:scale-110', c.dot,
                  color === c.id && 'ring-2 ring-white ring-offset-2 ring-offset-bg scale-110')} />
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Cadence</label>
          <div className="flex gap-2">
            {(['daily', 'weekly'] as const).map((cd) => (
              <button key={cd} type="button" onClick={() => setCadence(cd)}
                className={cn('flex-1 rounded-xl border-2 px-3 py-2 text-sm font-medium capitalize transition',
                  cadence === cd ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:border-brand/40')}>
                {cd}
              </button>
            ))}
          </div>
        </div>

        {cadence === 'weekly' ? (
          <Field label="Times per week">
            {(id) => <Input id={id} type="number" min={1} max={7} value={target} onChange={(e) => setTarget(Number(e.target.value))} />}
          </Field>
        ) : (
          <div>
            <label className="mb-1.5 block text-sm font-medium">Days (optional — leave blank for every day)</label>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((d, i) => (
                <button key={i} type="button" onClick={() => toggleWeekday(i)}
                  className={cn('h-9 w-9 rounded-full text-sm font-medium transition',
                    weekdays.includes(i) ? 'bg-brand text-white' : 'bg-surface/60 text-muted hover:bg-elevated')}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        <Field label="Who's it for?">
          {(id) => (
            <select id={id} value={memberId ?? ''} onChange={(e) => setMemberId(e.target.value || null)}
              className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm">
              <option value="">Whole family</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          )}
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{habit ? 'Save' : 'Create Habit'}</Button>
        </div>
      </form>
    </Modal>
  );
}
