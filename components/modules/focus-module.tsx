'use client';

// Focus Mode — a calm, distraction-reducing view of *today*, one thing at a
// time. Reads existing data (today's events + your open tasks) and presents a
// single focused card with Done/Next, so the family member can stop scanning a
// dashboard and just act. 100% Supabase-wired (reads calendar_events,
// chore_assignments, todo_items; safely completes todos).
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import {
  Focus, Check, ArrowRight, Calendar, CheckSquare, ListChecks, Sparkles, RotateCcw,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { settleAll } from '@/lib/supabase/settle';
import { useToast } from '@/components/ui/toast';
import { SkeletonList } from '@/components/ui/states';
import { fmtTime } from '@/lib/utils/format';
import { describeDbError } from '@/lib/supabase/errors';
import {
  completeFocusTodo, createFocusTimer, focusTimerReducer, runFocusAction, submitFocusChore,
} from '@/lib/focus/session';
import { useTranslations } from '@/components/i18n/locale-provider';

type FocusItem = {
  id: string;
  kind: 'event' | 'chore' | 'todo';
  title: string;
  subtitle: string | null;
  /** Completion and submission are distinct persisted outcomes. */
  complete?: () => Promise<void>;
  submit?: () => Promise<void>;
};

export function FocusModule() {
  const { familyId, userId, selfMember } = useApp();
  return <FocusQueue key={`${familyId}:${userId}:${selfMember?.id ?? 'none'}`} />;
}

function FocusQueue() {
  const tr = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [items, setItems] = useState<FocusItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const active = useRef(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setItems(null);
    setIndex(0);
    setDoneCount(0);
    setSubmittedCount(0);
    try {
      const supabase = createClient();
      const now = new Date();
      const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

      const { data: member, error: memberErr } = await supabase.from('family_members').select('id').eq('family_id', familyId).eq('user_id', userId).maybeSingle();
      if (!active.current || version !== loadVersion.current) return;
      if (memberErr) { setLoadError(true); setItems([]); return; }
      const myMemberId = member?.id ?? null;

      const [{ data: events, error: evErr }, { data: chores, error: chErr }, { data: todos, error: tdErr }] = await settleAll([
        supabase.from('calendar_events').select('id, title, starts_at, all_day, location')
          .eq('family_id', familyId)
          .gte('starts_at', dayStart.toISOString()).lt('starts_at', dayEnd.toISOString())
          .order('starts_at').limit(20),
        myMemberId
          ? supabase.from('chore_assignments').select('id, due_at, chores(title)')
              .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['todo', 'in_progress'])
              .order('due_at', { nullsFirst: false }).limit(20)
          : Promise.resolve({ data: [] as { id: string; due_at: string | null; chores: { title: string } | null }[], error: null }),
        supabase.from('todo_items').select('id, title, is_done')
          .eq('family_id', familyId).eq('is_done', false).order('created_at').limit(20),
      ]);

      if (!active.current || version !== loadVersion.current) return;
      // A failed member, chore, event or todo read is not an empty day.
      if (chErr) { setLoadError(true); setItems([]); return; }
      if (evErr || tdErr) { setLoadError(true); setItems([]); return; }
      setLoadError(false);

      const list: FocusItem[] = [];
      for (const e of events ?? []) {
        list.push({ id: `e-${e.id}`, kind: 'event', title: e.title, subtitle: e.all_day ? 'All day' : `${fmtTime(e.starts_at)}${e.location ? ` · ${e.location}` : ''}` });
      }
      for (const c of (chores ?? []) as { id: string; due_at: string | null; chores: { title: string } | null }[]) {
        list.push({
          id: `c-${c.id}`, kind: 'chore', title: c.chores?.title ?? 'Chore', subtitle: c.due_at ? 'Due today' : 'Open task',
          submit: () => submitFocusChore(supabase, familyId, myMemberId, c.id),
        });
      }
      for (const t of todos ?? []) {
        list.push({
          id: `t-${t.id}`, kind: 'todo', title: t.title, subtitle: 'To-do',
          complete: () => completeFocusTodo(supabase, familyId, t.id),
        });
      }
      setItems(list);
    } catch {
      if (active.current && version === loadVersion.current) {
        setLoadError(true);
        setItems([]);
      }
    }
  }, [familyId, userId]);

  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; loadVersion.current += 1; };
  }, [load]);

  if (items === null) return <SkeletonList />;

  const total = items.length;
  const current = items[index];
  const finished = index >= total;

  async function onDone() {
    if (!current || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await runFocusAction(current, (outcome) => {
        if (!active.current) return;
        if (outcome === 'completed') {
          setDoneCount((n) => n + 1);
          success(tr('focusModule.toDoSavedAsDone'));
        } else if (outcome === 'submitted') {
          setSubmittedCount((n) => n + 1);
          success(tr('focusModule.choreSubmittedForApproval'));
        }
        setIndex((i) => i + 1);
      });
    } catch (err) {
      if (active.current) toastError(describeDbError(err, tr('focusModule.couldNotUpdate')));
    } finally {
      savingRef.current = false;
      if (active.current) setSaving(false);
    }
  }

  function onNext() {
    if (!savingRef.current) setIndex((i) => i + 1);
  }

  return (
    <div aria-busy={saving} className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      {loadError ? (
        <div className="flex flex-col items-center gap-5" role="alert">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-danger/10">
            <RotateCcw className="h-10 w-10 text-danger" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{tr('focus.couldntLoadYourDay')}</h1>
            <p className="mt-1 text-sm text-muted">{tr('focus.somethingWentWrongReachingYourEvents')}</p>
          </div>
          <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-fg transition">
            <RotateCcw className="h-4 w-4" /> {tr('focus.tryAgain')}
          </button>
        </div>
      ) : total === 0 || finished ? (
        <div className="flex flex-col items-center gap-5">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-brand/10">
            <Sparkles className="h-10 w-10 text-brand-text" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{total === 0 ? 'Nothing on your plate' : 'Focus review finished'}</h1>
            <p className="mt-1 text-sm text-muted">
              {total === 0 ? 'No events or open tasks for today. Enjoy the calm.' : `Reviewed ${total} items. ${doneCount} to-dos saved as done; ${submittedCount} chores submitted for approval. Skipped tasks remain open.`}
            </p>
          </div>
          <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-fg transition">
            <RotateCcw className="h-4 w-4" /> {tr('focus.refresh')}
          </button>
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-8">
          {/* progress dots */}
          <div className="flex items-center gap-1.5">
            {items.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i < index ? 'w-1.5 bg-brand' : i === index ? 'w-6 bg-brand' : 'w-1.5 bg-border'}`} />
            ))}
          </div>

          <div className="flex flex-col items-center gap-4">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface/60">
              {current.kind === 'event' ? <Calendar className="h-7 w-7 text-blue-400" />
                : current.kind === 'chore' ? <CheckSquare className="h-7 w-7 text-violet-400" />
                : <ListChecks className="h-7 w-7 text-teal-400" />}
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted">
              {current.kind === 'event' ? 'Happening today' : 'One thing at a time'} · {index + 1} of {total}
            </p>
            <h1 className="text-3xl font-bold leading-tight">{current.title}</h1>
            {current.subtitle && <p className="text-sm text-muted">{current.subtitle}</p>}
          </div>

          <FocusTimer key={current.id} />
          {current.kind === 'chore' && <p className="text-sm text-muted">{tr('focus.submittingRequestsApprovalItDoesNot')}</p>}
          {current.kind === 'event' && <p className="text-sm text-muted">{tr('focus.nextReviewsThisEventOnlyIt')}</p>}
          {saving && <p role="status" className="text-sm text-muted">{tr('focus.savingYourUpdate')}</p>}

          <div className="flex items-center gap-3">
            {current.complete ? (
              <button onClick={onDone} disabled={saving} className="flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 transition disabled:opacity-50">
                <Check className="h-4 w-4" /> {tr('focus.markDone')}
              </button>
            ) : (
              <button onClick={onDone} disabled={saving} className="flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 transition disabled:opacity-50">
                {current.kind === 'chore' ? 'Submit for approval' : 'Next event'} <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <button onClick={onNext} disabled={saving} className="rounded-xl px-4 py-3 text-sm font-medium text-muted hover:text-fg transition disabled:opacity-50">
              {tr('focus.skip')}
            </button>
          </div>

          {doneCount > 0 && <p className="text-xs text-muted">{doneCount} {tr('focus.completedThisSession')}</p>}
        </div>
      )}
    </div>
  );
}

function FocusTimer() {
  const tr = useTranslations();
  const [timer, dispatch] = useReducer(focusTimerReducer, 25, createFocusTimer);
  const durationId = useId();

  useEffect(() => {
    if (timer.status !== 'running') return;
    const interval = window.setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 250);
    return () => window.clearInterval(interval);
  }, [timer.status]);

  const seconds = Math.ceil(timer.remainingMs / 1000);
  const clock = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  const inSession = timer.status === 'running' || timer.status === 'paused';

  return (
    <section aria-label={tr('focus.focusTimer')} className="w-full rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <label htmlFor={durationId} className="text-sm font-semibold">{tr('focus.focusTimer')}</label>
        <select id={durationId} value={timer.durationMs / 60_000} disabled={inSession}
          onChange={(event) => dispatch({ type: 'duration', minutes: Number(event.target.value) })}
          className="rounded-lg border border-border bg-surface px-2 py-1 text-sm disabled:opacity-50">
          {[5, 15, 25, 45].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
        </select>
      </div>
      <p role="timer" aria-label={tr('focus.timeRemaining')} aria-live="off" className="my-3 text-4xl font-semibold tabular-nums">{clock}</p>
      <p role="status" className="text-sm text-muted">
        {timer.status === 'expired' ? 'Time is up. Your task is not marked complete.'
          : timer.status === 'paused' ? 'Paused. Resume when you are ready.'
          : 'The timer never saves or completes work automatically.'}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        {!inSession && <button type="button" onClick={() => dispatch({ type: 'start', now: Date.now() })}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white">{timer.status === 'expired' ? 'Start again' : 'Start timer'}</button>}
        {timer.status === 'running' && <button type="button" onClick={() => dispatch({ type: 'pause', now: Date.now() })}
          className="rounded-xl border border-border px-4 py-2 text-sm font-medium">{tr('focus.pauseTimer')}</button>}
        {timer.status === 'paused' && <button type="button" onClick={() => dispatch({ type: 'resume', now: Date.now() })}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white">{tr('focus.resumeTimer')}</button>}
        {timer.status !== 'idle' && <button type="button" onClick={() => dispatch({ type: 'cancel' })}
          className="rounded-xl border border-border px-4 py-2 text-sm font-medium">{tr('focus.cancelTimer')}</button>}
      </div>
    </section>
  );
}
