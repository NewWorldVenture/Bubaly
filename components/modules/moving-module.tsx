'use client';

import { useEffect, useMemo, useState } from 'react';
import { Truck, Plus, Check, Pencil, Trash2, Package, Wand2, CalendarClock, Wallet, Search, Boxes, SkipForward, RotateCcw, ChevronRight, MapPin } from 'lucide-react';
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
import type { Tables, MoveBoxStatus, MoveKind, MoveStatus, MoveTaskCategory } from '@/lib/database.types';
import {
  MOVE_STATUSES, MOVE_KINDS, TASK_CATEGORIES, BOX_STATUSES, BOX_ORDER, categoryMeta, planTasks, timeline, suggestedStatus, budgetHealth, moveSummary,
  nextBoxNumber, boxesByRoom, findInBoxes, money, isoDate, addDays, dayDiff,
} from '@/lib/moving/planner';
import { useTranslations } from '@/components/i18n/locale-provider';

type Move = Tables<'moves'>;
type Task = Tables<'move_tasks'>;
type Box = Tables<'move_boxes'>;

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtLong = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const statusLabel = (s: MoveStatus) => MOVE_STATUSES.find((x) => x.value === s)?.label ?? s;
const boxStatusLabel = (s: MoveBoxStatus) => BOX_STATUSES.find((x) => x.value === s)?.label ?? s;

export function MovingModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const moves = useRealtimeQuery<Move>({
    table: 'moves', familyId,
    fetcher: (s) => s.from('moves').select('*').eq('family_id', familyId).order('move_date', { ascending: false }),
    deps: [familyId],
  });
  const tasks = useRealtimeQuery<Task>({
    table: 'move_tasks', familyId,
    fetcher: (s) => s.from('move_tasks').select('*').eq('family_id', familyId).order('due_date', { ascending: true, nullsFirst: false }).limit(600),
    deps: [familyId],
  });
  const boxes = useRealtimeQuery<Box>({
    table: 'move_boxes', familyId,
    fetcher: (s) => s.from('move_boxes').select('*').eq('family_id', familyId).order('box_number').limit(600),
    deps: [familyId],
  });

  const [moveId, setMoveId] = useState('');
  useEffect(() => {
    if (moves.data.length && !moves.data.some((m) => m.id === moveId)) {
      const live = moves.data.find((m) => m.status !== 'done' && m.status !== 'cancelled') ?? moves.data[0];
      setMoveId(live.id);
    }
  }, [moves.data, moveId]);
  const [moveForm, setMoveForm] = useState<{ open: boolean; move: Move | null }>({ open: false, move: null });
  const [taskForm, setTaskForm] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });
  const [boxForm, setBoxForm] = useState<{ open: boolean; box: Box | null }>({ open: false, box: null });
  const [tab, setTab] = useState<'timeline' | 'boxes'>('timeline');
  const [query, setQuery] = useState('');
  const [planning, setPlanning] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const today = useMemo(() => new Date(), []);
  const todayIso = isoDate(today);
  const move = moves.data.find((m) => m.id === moveId) ?? null;
  const summary = useMemo(() => (move ? moveSummary(move, tasks.data, boxes.data, today) : null), [move, tasks.data, boxes.data, today]);
  const budget = move ? budgetHealth(move) : null;
  const plan = useMemo(() => (move ? planTasks(move, tasks.data) : []), [move, tasks.data]);
  const groups = useMemo(() => (move ? timeline(tasks.data, move.id) : []), [tasks.data, move]);
  const rooms = useMemo(() => (move ? boxesByRoom(boxes.data, move.id) : []), [boxes.data, move]);
  const found = useMemo(() => (move ? findInBoxes(boxes.data, move.id, query) : []), [boxes.data, move, query]);
  const suggested = move ? suggestedStatus(move, today) : null;
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;

  async function generateTasks() {
    if (!move) return;
    if (!plan.length) return toastError('The full checklist for this move is already here.');
    setPlanning(true);
    const { error } = await createClient().from('move_tasks').insert(plan.map((p) => ({
      family_id: familyId, move_id: move.id, title: p.title, category: p.category, offset_days: p.offsetDays, due_date: p.dueDate, template_key: p.key, status: 'todo' as const, created_by: userId,
    })));
    setPlanning(false);
    if (error) return toastError(describeDbError(error));
    success(`${plan.length} task${plan.length === 1 ? '' : 's'} added to the timeline`);
  }

  async function setTaskStatus(t: Task, status: Task['status']) {
    const { error } = await createClient().from('move_tasks').update({ status, completed_at: status === 'done' ? new Date().toISOString() : null }).eq('id', t.id);
    if (error) return toastError(describeDbError(error));
    if (status === 'done') success('Done ✓');
  }

  async function deleteTask(t: Task) {
    if (!confirm(`Delete “${t.title}”?`)) return;
    const { error } = await createClient().from('move_tasks').delete().eq('id', t.id);
    if (error) return toastError(describeDbError(error));
    success('Task deleted');
  }

  async function advanceBox(b: Box) {
    const idx = BOX_ORDER.indexOf(b.status);
    const next = BOX_ORDER[Math.min(BOX_ORDER.length - 1, idx + 1)];
    if (next === b.status) return;
    const { error } = await createClient().from('move_boxes').update({ status: next, packed_by: next === 'packed' ? (selfMember?.id ?? b.packed_by) : b.packed_by }).eq('id', b.id);
    if (error) return toastError(describeDbError(error));
  }

  async function deleteBox(b: Box) {
    if (!confirm(`Delete box #${b.box_number} “${b.label}”?`)) return;
    const { error } = await createClient().from('move_boxes').delete().eq('id', b.id);
    if (error) return toastError(describeDbError(error));
    success('Box deleted');
  }

  async function setMoveStatus(status: MoveStatus) {
    if (!move) return;
    const { error } = await createClient().from('moves').update({ status }).eq('id', move.id);
    if (error) return toastError(describeDbError(error));
    success(`Move marked ${statusLabel(status).toLowerCase()}`);
  }

  async function deleteMove(m: Move) {
    if (!confirm(`Delete “${m.title}” with all its tasks and boxes? This cannot be undone.`)) return;
    const { error } = await createClient().from('moves').delete().eq('id', m.id);
    if (error) return toastError(describeDbError(error));
    setMoveId('');
    success('Move deleted');
  }

  const loading = moves.loading || tasks.loading || boxes.loading;
  const error = moves.error || tasks.error || boxes.error;
  const refresh = () => { void moves.refresh(); void tasks.refresh(); void boxes.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load your move. Refresh and try again." onRetry={refresh} />;

  const TaskRow = ({ t }: { t: Task }) => {
  const tr = useTranslations();
    const overdue = t.status !== 'done' && t.status !== 'skipped' && t.due_date && t.due_date < todayIso;
    const meta = categoryMeta(t.category);
    return (
      <li className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', t.status === 'done' ? 'border-border/60 bg-surface/30' : overdue ? 'border-rose-500/30 bg-rose-500/5' : 'border-border bg-surface/60')}>
        <button onClick={() => setTaskStatus(t, t.status === 'done' ? 'todo' : 'done')} aria-label={t.status === 'done' ? `Reopen ${t.title}` : `Complete ${t.title}`}
          className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full border coarse:h-8 coarse:w-8', t.status === 'done' ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border hover:border-brand')}>
          {t.status === 'done' && <Check className="h-3.5 w-3.5" />}
        </button>
        <span className="text-base" aria-hidden>{meta.emoji}</span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', t.status === 'done' && 'text-muted line-through', t.status === 'skipped' && 'text-muted')}>{t.title}</p>
          <p className="text-xs text-muted">
            {t.due_date ? <span className={cn(overdue && 'text-rose-300')}>{overdue ? 'Overdue · ' : ''}{fmtDate(t.due_date)}</span> : 'No date'}
            {' · '}{meta.label}{t.assignee_id ? ` · ${nameOf(t.assignee_id) ?? 'someone'}` : ''}{t.status === 'skipped' ? ' · skipped' : t.status === 'doing' ? ' · in progress' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {t.status === 'todo' && <button onClick={() => setTaskStatus(t, 'doing')} aria-label={tr('moving.markInProgress')} title={tr('moving.inProgress')} className="rounded-lg p-1.5 text-muted hover:text-fg"><ChevronRight className="h-4 w-4" /></button>}
          {(t.status === 'todo' || t.status === 'doing') && <button onClick={() => setTaskStatus(t, 'skipped')} aria-label={`Skip ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><SkipForward className="h-4 w-4" /></button>}
          {t.status === 'skipped' && <button onClick={() => setTaskStatus(t, 'todo')} aria-label={`Restore ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><RotateCcw className="h-4 w-4" /></button>}
          <button onClick={() => setTaskForm({ open: true, task: t })} aria-label={`Edit ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
          <button onClick={() => deleteTask(t)} aria-label={`Delete ${t.title}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
        </div>
      </li>
    );
  };

  const BoxCard = ({ b }: { b: Box }) => (
    <li className={cn('rounded-xl border px-3 py-2', b.status === 'unpacked' ? 'border-border/60 bg-surface/30' : 'border-border bg-surface/60')}>
      <div className="flex items-start gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-xs font-bold text-brand-text">#{b.box_number}</span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', b.status === 'unpacked' && 'text-muted')}>{b.label}{b.is_fragile ? ' 🥂' : ''}{b.is_essential ? ' ⭐' : ''}</p>
          <p className="text-xs text-muted">{b.from_room ? `${b.from_room} → ` : ''}{b.to_room ?? 'unassigned'} · {boxStatusLabel(b.status)}{b.packed_by ? ` by ${nameOf(b.packed_by)}` : ''}</p>
          {b.contents.length > 0 && <p className="mt-1 truncate text-xs text-muted/80">{b.contents.join(', ')}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {b.status !== 'unpacked' && <Button size="sm" variant="secondary" onClick={() => advanceBox(b)}>{boxStatusLabel(BOX_ORDER[BOX_ORDER.indexOf(b.status) + 1])}</Button>}
          <button onClick={() => setBoxForm({ open: true, box: b })} aria-label={`Edit box ${b.box_number}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
          <button onClick={() => deleteBox(b)} aria-label={`Delete box ${b.box_number}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('moving.movePlanner')}
        description="One workflow from “we’re moving” to “settled”: an eight-week checklist built for your family, a numbered box inventory you can search on day one, and a budget that counts the mover’s quote before you spend it."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AiInsight kind="moving" iconOnly />
            {move && <Button variant="secondary" onClick={() => setBoxForm({ open: true, box: null })}><Package className="h-4 w-4" /> Box</Button>}
            {move && <Button variant="secondary" onClick={() => setTaskForm({ open: true, task: null })}><Plus className="h-4 w-4" /> {tr('moving.task')}</Button>}
            <Button onClick={() => setMoveForm({ open: true, move: null })}><Truck className="h-4 w-4" /> {tr('moving.newMove')}</Button>
          </div>
        }
      />

      {moves.data.length === 0 || !move || !summary || !budget ? (
        <EmptyState icon={Truck} title={tr('moving.noMovePlanned')} description="Add the move date and whether kids, pets or a rental are involved. The eight-week checklist and box inventory follow." action={<Button onClick={() => setMoveForm({ open: true, move: null })}><Truck className="h-4 w-4" /> {tr('moving.planAMove')}</Button>} />
      ) : (
        <>
          {moves.data.length > 1 && (
            <div className="flex flex-wrap gap-2" role="tablist" aria-label={tr('moving.move')}>
              {moves.data.map((m) => (
                <button key={m.id} role="tab" aria-selected={m.id === moveId} onClick={() => setMoveId(m.id)}
                  className={cn('rounded-full border px-3 py-1.5 text-sm transition coarse:min-h-11', m.id === moveId ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                  {m.title} <span className="text-xs opacity-70">· {fmtDate(m.move_date)}</span>
                </button>
              ))}
            </div>
          )}

          {/* Move header card */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{move.title}</h2>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{statusLabel(move.status)}</span>
                  {suggested && suggested !== move.status && move.status !== 'done' && move.status !== 'cancelled' && (
                    <button onClick={() => setMoveStatus(suggested)} className="rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs text-brand-text hover:bg-brand/20">{tr('moving.mark')} {statusLabel(suggested).toLowerCase()} →</button>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted"><CalendarClock className="mr-1 inline h-3.5 w-3.5" />{fmtLong(move.move_date)} · {MOVE_KINDS.find((k) => k.value === move.move_kind)?.label}</p>
                {(move.from_address || move.to_address) && <p className="mt-1 text-sm text-muted"><MapPin className="mr-1 inline h-3.5 w-3.5" />{move.from_address ?? '?'} → {move.to_address ?? '?'}</p>}
                {move.mover_name && <p className="mt-1 text-xs text-muted">Movers: {move.mover_name}{move.mover_phone ? ` · ${move.mover_phone}` : ''}{move.mover_quote_cents ? ` · quote ${money(move.mover_quote_cents)}` : ''}</p>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setMoveForm({ open: true, move })} aria-label={tr('moving.editMove')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => deleteMove(move)} aria-label={tr('moving.deleteMove')} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="grid gap-4 md:grid-cols-4">
            <div className={cn('rounded-2xl border p-5', summary.overdue ? 'border-rose-500/30 bg-rose-500/10' : summary.onTrack ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-brand-text" /> {tr('moving.countdown')}</div>
              <p className="mt-2 text-lg font-bold">{summary.text}</p>
              <p className="mt-1 text-xs text-muted">{summary.dueThisWeek} task{summary.dueThisWeek === 1 ? '' : 's'} {tr('moving.dueThisWeek')}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><Check className="h-4 w-4 text-brand-text" /> {tr('moving.checklist')}</div>
              <p className="mt-2 text-2xl font-bold">{summary.pct}%</p>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${summary.pct}%` }} /></div>
              <p className="mt-1 text-xs text-muted">{summary.done} of {summary.total} done</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><Boxes className="h-4 w-4 text-brand-text" /> {tr('moving.boxes')}</div>
              <p className="mt-2 text-2xl font-bold">{summary.boxes.packed}<span className="text-sm font-normal text-muted"> / {summary.boxes.total} packed</span></p>
              <p className="mt-1 text-xs text-muted">{summary.boxes.unpacked} {tr('moving.unpacked')} {summary.boxes.fragile} {tr('moving.fragile')} {summary.boxes.essentials} essentials</p>
            </div>
            <div className={cn('rounded-2xl border p-5', budget.status === 'over' ? 'border-rose-500/30 bg-rose-500/10' : budget.status === 'near' ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Wallet className="h-4 w-4 text-brand-text" /> {tr('moving.budget')}</div>
              {budget.status === 'no_budget' ? (
                <><p className="mt-2 text-2xl font-bold">{money(budget.committedCents)}</p><p className="mt-1 text-xs text-muted">{tr('moving.committedSetABudgetToTrack')}</p></>
              ) : (
                <><p className="mt-2 text-2xl font-bold">{budget.pct}%<span className="text-sm font-normal text-muted"> of {money(move.budget_cents)}</span></p><p className="mt-1 text-xs text-muted">{money(budget.committedCents)} {tr('moving.committedInclMoverQuote')} {budget.remainingCents !== null && budget.remainingCents < 0 ? `${money(-budget.remainingCents)} over` : `${money(budget.remainingCents)} left`}</p></>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-2 border-b border-border" role="tablist">
            {(['timeline', 'boxes'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm capitalize coarse:min-h-11', tab === t ? 'border-brand text-brand-text' : 'border-transparent text-muted hover:text-fg')}>{t === 'timeline' ? `Timeline (${summary.total})` : `Boxes (${summary.boxes.total})`}</button>
            ))}
            <div className="ml-auto flex items-center gap-2 pb-1">
              {tab === 'timeline' && <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="accent-brand" /> {tr('moving.showDone')}</label>}
              {tab === 'timeline' && <Button size="sm" onClick={generateTasks} loading={planning} disabled={!plan.length}><Wand2 className="h-3.5 w-3.5" /> {plan.length ? `Add the ${plan.length}-step checklist` : 'Checklist complete'}</Button>}
            </div>
          </div>

          {tab === 'timeline' && (
            groups.length === 0 ? (
              <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5">
                <p className="text-sm font-semibold text-brand-text">{tr('moving.noTasksYet')}</p>
                <p className="mt-1 text-sm text-muted">{tr('moving.theTemplateHas')} {plan.length} {tr('moving.stepsForA')} {MOVE_KINDS.find((k) => k.value === move.move_kind)?.label.toLowerCase()} move{move.has_kids ? ' with kids' : ''}{move.has_pets ? ' and pets' : ''}{tr('moving.fromEightWeeksOutToTwo')}</p>
                <Button className="mt-3" onClick={generateTasks} loading={planning}><Wand2 className="h-4 w-4" /> {tr('moving.addTheChecklist')}</Button>
              </div>
            ) : (
              <div className="space-y-5">
                {groups.map(({ phase, tasks: list }) => {
                  const visible = showDone ? list : list.filter((t) => t.status !== 'done');
                  if (!visible.length) return null;
                  const doneCount = list.filter((t) => t.status === 'done').length;
                  return (
                    <section key={phase.key}>
                      <div className="mb-2 flex items-baseline justify-between">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{phase.label}</h3>
                        <span className="text-xs text-muted">{doneCount}/{list.length} · {fmtDate(addDays(move.move_date, Math.max(phase.from, -56)))}{phase.from !== phase.to ? ` → ${fmtDate(addDays(move.move_date, Math.min(phase.to, 14)))}` : ''}</span>
                      </div>
                      <ul className="space-y-2">{visible.map((t) => <TaskRow key={t.id} t={t} />)}</ul>
                    </section>
                  );
                })}
              </div>
            )
          )}

          {tab === 'boxes' && (
            <div className="space-y-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('moving.whichBoxIsTheKettleIn')} className="pl-9" aria-label={tr('moving.searchBoxes')} />
              </div>
              {query.trim() ? (
                found.length ? <ul className="grid gap-2 sm:grid-cols-2">{found.map((b) => <BoxCard key={b.id} b={b} />)}</ul> : <p className="text-sm text-muted">{tr('moving.nothingLabelledOrListedAs')}{query}”.</p>
              ) : rooms.length === 0 ? (
                <EmptyState icon={Package} title={tr('moving.noBoxesYet')} description="Number every box, name its destination room and list what is inside. On day one, search instead of opening boxes." action={<Button onClick={() => setBoxForm({ open: true, box: null })}><Package className="h-4 w-4" /> {tr('moving.addBox1')}</Button>} />
              ) : (
                rooms.map(({ room, boxes: list }) => (
                  <section key={room}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{room} · {list.filter((b) => b.status === 'unpacked').length}/{list.length} unpacked</h3>
                    <ul className="grid gap-2 sm:grid-cols-2">{list.map((b) => <BoxCard key={b.id} b={b} />)}</ul>
                  </section>
                ))
              )}
            </div>
          )}
        </>
      )}

      {moveForm.open && (
        <MoveForm familyId={familyId} userId={userId} move={moveForm.move} onClose={() => setMoveForm({ open: false, move: null })} onSaved={(id) => { setMoveForm({ open: false, move: null }); setMoveId(id); success('Move saved'); }} />
      )}
      {taskForm.open && move && (
        <TaskForm familyId={familyId} userId={userId} move={move} members={members} task={taskForm.task} onClose={() => setTaskForm({ open: false, task: null })} onSaved={() => { setTaskForm({ open: false, task: null }); success('Task saved'); }} />
      )}
      {boxForm.open && move && (
        <BoxForm familyId={familyId} userId={userId} move={move} members={members} box={boxForm.box} nextNumber={nextBoxNumber(boxes.data, move.id)} defaultPacker={selfMember?.id ?? null} onClose={() => setBoxForm({ open: false, box: null })} onSaved={() => { setBoxForm({ open: false, box: null }); success('Box saved'); }} />
      )}
    </div>
  );
}

const dollarsToCents = (v: FormDataEntryValue | null) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() ? Math.round(n * 100) : null; };
const centsToDollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));

function MoveForm({ familyId, userId, move, onClose, onSaved }: { familyId: string; userId: string; move: Move | null; onClose: () => void; onSaved: (id: string) => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [kids, setKids] = useState(move?.has_kids ?? true);
  const [pets, setPets] = useState(move?.has_pets ?? false);
  const [renting, setRenting] = useState(move?.is_renting_out ?? false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const title = String(f.get('title') ?? '').trim();
    const moveDate = String(f.get('move_date') ?? '');
    if (!title) return toastError('Name the move');
    if (!moveDate) return toastError('Pick the move date');
    setLoading(true);
    const payload = {
      title, move_date: moveDate, from_address: String(f.get('from_address') ?? '').trim() || null, to_address: String(f.get('to_address') ?? '').trim() || null,
      move_kind: String(f.get('move_kind') ?? 'local') as MoveKind, status: String(f.get('status') ?? 'planning') as MoveStatus,
      budget_cents: dollarsToCents(f.get('budget')), spent_cents: dollarsToCents(f.get('spent')) ?? 0, mover_quote_cents: dollarsToCents(f.get('mover_quote')),
      mover_name: String(f.get('mover_name') ?? '').trim() || null, mover_phone: String(f.get('mover_phone') ?? '').trim() || null,
      has_kids: kids, has_pets: pets, is_renting_out: renting, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { data, error } = move
      ? await supabase.from('moves').update(payload).eq('id', move.id).select('id').single()
      : await supabase.from('moves').insert({ family_id: familyId, created_by: userId, ...payload }).select('id').single();
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(data.id);
  }

  const Toggle = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => (
    <button type="button" aria-pressed={value} onClick={() => onChange(!value)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', value ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{label}</button>
  );

  return (
    <Modal open title={move ? 'Edit move' : 'Plan a move'} description="The date and the family’s situation decide which checklist steps you get." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.move')} required>{(id) => <Input id={id} name="title" defaultValue={move?.title ?? ''} placeholder={tr('moving.moveToMapleStreet')} autoFocus />}</Field>
          <Field label={tr('moving.moveDay')} required>{(id) => <Input id={id} name="move_date" type="date" defaultValue={move?.move_date ?? addDays(isoDate(new Date()), 56)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.from')}>{(id) => <Input id={id} name="from_address" defaultValue={move?.from_address ?? ''} placeholder={tr('moving.12OldRoad')} />}</Field>
          <Field label="To">{(id) => <Input id={id} name="to_address" defaultValue={move?.to_address ?? ''} placeholder={tr('moving.34MapleStreet')} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.kindOfMove')}>{(id) => <Select id={id} name="move_kind" defaultValue={move?.move_kind ?? 'local'}>{MOVE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>}</Field>
          <Field label={tr('moving.status')}>{(id) => <Select id={id} name="status" defaultValue={move?.status ?? 'planning'}>{MOVE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle label={tr('moving.kidsInSchoolChildcare')} value={kids} onChange={setKids} />
          <Toggle label={tr('moving.pets')} value={pets} onChange={setPets} />
          <Toggle label={tr('moving.rentingOutTheOldPlace')} value={renting} onChange={setRenting} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('moving.budget')}>{(id) => <Input id={id} name="budget" type="number" min={0} step={50} defaultValue={centsToDollars(move?.budget_cents)} placeholder="5000" />}</Field>
          <Field label={tr('moving.spentSoFar')}>{(id) => <Input id={id} name="spent" type="number" min={0} step={10} defaultValue={centsToDollars(move?.spent_cents ?? 0)} />}</Field>
          <Field label={tr('moving.moverQuote')}>{(id) => <Input id={id} name="mover_quote" type="number" min={0} step={50} defaultValue={centsToDollars(move?.mover_quote_cents)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.movers')}>{(id) => <Input id={id} name="mover_name" defaultValue={move?.mover_name ?? ''} placeholder={tr('moving.twoGuysATruck')} />}</Field>
          <Field label={tr('moving.moverPhone')}>{(id) => <Input id={id} name="mover_phone" defaultValue={move?.mover_phone ?? ''} />}</Field>
        </div>
        <Field label={tr('moving.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={move?.notes ?? ''} rows={2} placeholder={tr('moving.elevatorBooked812KeysFrom')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('moving.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('moving.saveMove')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function TaskForm({ familyId, userId, move, members, task, onClose, onSaved }: { familyId: string; userId: string; move: Move; members: { id: string; display_name: string }[]; task: Task | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const title = String(f.get('title') ?? '').trim();
    if (!title) return toastError('Give the task a title');
    const dueDate = String(f.get('due_date') ?? '') || null;
    setLoading(true);
    const payload = {
      title, category: String(f.get('category') ?? 'other') as MoveTaskCategory, due_date: dueDate,
      offset_days: dueDate ? Math.max(-365, Math.min(365, dayDiff(move.move_date, dueDate))) : (task?.offset_days ?? 0),
      assignee_id: String(f.get('assignee_id') ?? '') || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = task
      ? await supabase.from('move_tasks').update(payload).eq('id', task.id)
      : await supabase.from('move_tasks').insert({ family_id: familyId, move_id: move.id, created_by: userId, status: 'todo', ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={task ? 'Edit task' : 'Add a task'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('moving.task')} required>{(id) => <Input id={id} name="title" defaultValue={task?.title ?? ''} placeholder={tr('moving.returnTheCableBox')} autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.category')}>{(id) => <Select id={id} name="category" defaultValue={task?.category ?? 'other'}>{TASK_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}</Select>}</Field>
          <Field label="Due" hint={`Move day is ${fmtDate(move.move_date)}`}>{(id) => <Input id={id} name="due_date" type="date" defaultValue={task?.due_date ?? isoDate(new Date())} />}</Field>
        </div>
        <Field label="Who">{(id) => <Select id={id} name="assignee_id" defaultValue={task?.assignee_id ?? ''}><option value="">{tr('moving.anyone')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        <Field label={tr('moving.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={task?.notes ?? ''} rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('moving.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('moving.saveTask')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function BoxForm({ familyId, userId, move, members, box, nextNumber, defaultPacker, onClose, onSaved }: { familyId: string; userId: string; move: Move; members: { id: string; display_name: string }[]; box: Box | null; nextNumber: number; defaultPacker: string | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [fragile, setFragile] = useState(box?.is_fragile ?? false);
  const [essential, setEssential] = useState(box?.is_essential ?? false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const label = String(f.get('label') ?? '').trim();
    if (!label) return toastError('Give the box a label');
    const boxNumber = Math.max(1, Math.round(Number(f.get('box_number') ?? nextNumber)));
    const contents = String(f.get('contents') ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    setLoading(true);
    const payload = {
      box_number: boxNumber, label, from_room: String(f.get('from_room') ?? '').trim() || null, to_room: String(f.get('to_room') ?? '').trim() || null,
      contents, is_fragile: fragile, is_essential: essential, status: String(f.get('status') ?? 'empty') as MoveBoxStatus,
      packed_by: String(f.get('packed_by') ?? '') || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = box
      ? await supabase.from('move_boxes').update(payload).eq('id', box.id)
      : await supabase.from('move_boxes').insert({ family_id: familyId, move_id: move.id, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(error.code === '23505' ? `Box #${boxNumber} already exists for this move` : describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={box ? `Edit box #${box.box_number}` : `Box #${nextNumber}`} description="Write the number and destination room on two sides of the box. List the contents here, not on the cardboard." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-[6rem_1fr] gap-3">
          <Field label={tr('moving.number')} required>{(id) => <Input id={id} name="box_number" type="number" min={1} defaultValue={box?.box_number ?? nextNumber} />}</Field>
          <Field label={tr('moving.label')} required>{(id) => <Input id={id} name="label" defaultValue={box?.label ?? ''} placeholder={tr('moving.kitchenEverydayPlates')} autoFocus />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.fromRoom')}>{(id) => <Input id={id} name="from_room" defaultValue={box?.from_room ?? ''} placeholder={tr('moving.kitchen')} />}</Field>
          <Field label={tr('moving.toRoom')}>{(id) => <Input id={id} name="to_room" defaultValue={box?.to_room ?? ''} placeholder={tr('moving.kitchen')} />}</Field>
        </div>
        <Field label={tr('moving.contentsCommaOrLineSeparated')}>{(id) => <Textarea id={id} name="contents" defaultValue={box?.contents.join(', ') ?? ''} rows={3} placeholder={tr('moving.kettleMugsCoffeeTheGoodKnife')} />}</Field>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={fragile} onClick={() => setFragile(!fragile)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', fragile ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{tr('moving.fragile')}</button>
          <button type="button" aria-pressed={essential} onClick={() => setEssential(!essential)} className={cn('rounded-full border px-3 py-1.5 text-sm coarse:min-h-11', essential ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{tr('moving.firstNightEssentials')}</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('moving.status')}>{(id) => <Select id={id} name="status" defaultValue={box?.status ?? 'packed'}>{BOX_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label={tr('moving.packedBy')}>{(id) => <Select id={id} name="packed_by" defaultValue={box?.packed_by ?? defaultPacker ?? ''}><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <Field label={tr('moving.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={box?.notes ?? ''} rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('moving.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('moving.saveBox')}</Button>
        </div>
      </form>
    </Modal>
  );
}
