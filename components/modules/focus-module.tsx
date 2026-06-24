'use client';

// Focus Mode — a calm, distraction-reducing view of *today*, one thing at a
// time. Reads existing data (today's events + your open tasks) and presents a
// single focused card with Done/Next, so the family member can stop scanning a
// dashboard and just act. 100% Supabase-wired (reads calendar_events,
// chore_assignments, todo_items; safely completes todos).
import { useCallback, useEffect, useState } from 'react';
import {
  Focus, Check, ArrowRight, Calendar, CheckSquare, ListChecks, Sparkles, RotateCcw,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { LoadingBlock } from '@/components/ui/states';
import { fmtTime } from '@/lib/utils/format';

type FocusItem = {
  id: string;
  kind: 'event' | 'chore' | 'todo';
  title: string;
  subtitle: string | null;
  /** present only for completable items (todos) */
  complete?: () => Promise<void>;
};

export function FocusModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [items, setItems] = useState<FocusItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [doneCount, setDoneCount] = useState(0);

  const load = useCallback(async () => {
    const supabase = createClient();
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);

    const { data: member } = await supabase.from('family_members').select('id').eq('family_id', familyId).eq('user_id', userId).maybeSingle();
    const myMemberId = member?.id ?? null;

    const [{ data: events }, { data: chores }, { data: todos }] = await Promise.all([
      supabase.from('calendar_events').select('id, title, starts_at, all_day, location')
        .eq('family_id', familyId)
        .gte('starts_at', dayStart.toISOString()).lt('starts_at', dayEnd.toISOString())
        .order('starts_at').limit(20),
      myMemberId
        ? supabase.from('chore_assignments').select('id, due_at, chores(title)')
            .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['todo', 'in_progress'])
            .order('due_at', { nullsFirst: false }).limit(20)
        : Promise.resolve({ data: [] as { id: string; due_at: string | null; chores: { title: string } | null }[] }),
      supabase.from('todo_items').select('id, title, is_done')
        .eq('family_id', familyId).eq('is_done', false).order('created_at').limit(20),
    ]);

    const list: FocusItem[] = [];
    for (const e of events ?? []) {
      list.push({ id: `e-${e.id}`, kind: 'event', title: e.title, subtitle: e.all_day ? 'All day' : `${fmtTime(e.starts_at)}${e.location ? ` · ${e.location}` : ''}` });
    }
    for (const c of (chores ?? []) as { id: string; due_at: string | null; chores: { title: string } | null }[]) {
      list.push({ id: `c-${c.id}`, kind: 'chore', title: c.chores?.title ?? 'Chore', subtitle: c.due_at ? 'Due today' : 'Open task' });
    }
    for (const t of todos ?? []) {
      list.push({
        id: `t-${t.id}`, kind: 'todo', title: t.title, subtitle: 'To-do',
        complete: async () => {
          const { error } = await supabase.from('todo_items').update({ is_done: true }).eq('id', t.id);
          if (error) throw new Error(error.message);
        },
      });
    }
    setItems(list);
    setIndex(0);
    setDoneCount(0);
  }, [familyId, userId]);

  useEffect(() => { void load(); }, [load]);

  if (items === null) return <LoadingBlock />;

  const total = items.length;
  const current = items[index];
  const finished = index >= total;

  async function onDone() {
    if (!current) return;
    if (current.complete) {
      try { await current.complete(); setDoneCount((n) => n + 1); success('Done — nice.'); }
      catch (err) { return toastError(err instanceof Error ? err.message : 'Could not update'); }
    }
    setIndex((i) => i + 1);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      {total === 0 || finished ? (
        <div className="flex flex-col items-center gap-5">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-brand/10">
            <Sparkles className="h-10 w-10 text-brand" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{total === 0 ? 'Nothing on your plate' : "You're all clear"}</h1>
            <p className="mt-1 text-sm text-muted">
              {total === 0 ? 'No events or open tasks for today. Enjoy the calm.' : `You moved through ${total} thing${total === 1 ? '' : 's'}. Breathe.`}
            </p>
          </div>
          <button onClick={() => load()} className="flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-fg transition">
            <RotateCcw className="h-4 w-4" /> Refresh
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

          <div className="flex items-center gap-3">
            {current.complete ? (
              <button onClick={onDone} className="flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 transition">
                <Check className="h-4 w-4" /> Mark done
              </button>
            ) : (
              <button onClick={onDone} className="flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 transition">
                Got it <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <button onClick={() => setIndex((i) => i + 1)} className="rounded-xl px-4 py-3 text-sm font-medium text-muted hover:text-fg transition">
              Skip
            </button>
          </div>

          {doneCount > 0 && <p className="text-xs text-muted">{doneCount} completed this session 🎉</p>}
        </div>
      )}
    </div>
  );
}
