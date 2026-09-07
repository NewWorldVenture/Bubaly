'use client';

import { useMemo, useRef, useState } from 'react';
import {
  CheckSquare, Plus, Trash2, Check, Flag, Calendar as CalendarIcon, Search, X,
  Pencil, Loader2, ListChecks, Sparkles, User as UserIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { completeTodoAction, createTodoAction, deleteTodoAction, updateTodoAction } from '@/app/(app)/dashboard/todos/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type TodoList = Tables<'todo_lists'>;
type TodoItem = Tables<'todo_items'>;

const PRIORITY_META = {
  low:    { label: 'Low',    color: 'text-muted',     flag: 'text-muted/50' },
  medium: { label: 'Medium', color: 'text-blue-400',  flag: 'text-blue-400' },
  high:   { label: 'High',   color: 'text-amber-400', flag: 'text-amber-400' },
  urgent: { label: 'Urgent', color: 'text-danger',    flag: 'text-danger' },
} as const;

const LIST_COLORS: Record<string, string> = {
  violet: 'bg-violet-500/20 text-violet-400',
  blue:   'bg-blue-500/20 text-blue-400',
  green:  'bg-green-500/20 text-green-400',
  amber:  'bg-amber-500/20 text-amber-400',
  rose:   'bg-rose-500/20 text-rose-400',
  teal:   'bg-teal-500/20 text-teal-400',
};

const LIST_ICONS = ['📋', '🏠', '💼', '🛒', '🎯', '📚', '🏋️', '✈️', '💡', '🎉'];

// Donut segment palette (explicit hex — conic-gradient needs real colors).
const DONUT = {
  overdue:   { label: 'Overdue',       hex: '#f43f5e' },
  today:     { label: 'Due Today',     hex: '#f59e0b' },
  week:      { label: 'Due This Week', hex: '#6366f1' },
  completed: { label: 'Completed',     hex: '#22c55e' },
};

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dueLabel(due: string, todayStr: string, tomorrowStr: string): string {
  if (due === todayStr) return 'Today';
  if (due === tomorrowStr) return 'Tomorrow';
  // due is 'YYYY-MM-DD' — render without TZ surprises.
  const [y, m, d] = due.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TodosModule() {
  const tr = useTranslations();
  const { familyId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });
  const selfId = selfMember?.id ?? null;

  const [tab, setTab] = useState<'all' | 'mine' | 'assigned' | 'completed'>('all');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<TodoItem | null>(null);
  const [newListOpen, setNewListOpen] = useState(false);
  const [quickTitle, setQuickTitle] = useState('');
  // Held across retries of one quick add and cleared once the row lands, so a
  // second press after a lost response is deduplicated while a task typed again
  // tomorrow is a new one. See lib/utils/submission-id.ts.
  const quickSubmission = useRef('');
  const [quickBusy, setQuickBusy] = useState(false);

  const { data: lists, loading: listsLoading, error: listsError, refresh: refreshLists } = useRealtimeQuery<TodoList>({
    table: 'todo_lists', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('todo_lists').select('*').eq('family_id', familyId).is('archived_at', null)
        .order('sort_order').order('created_at'),
  });

  const { data: items, loading: itemsLoading, error: itemsError, refresh: refreshItems } = useRealtimeQuery<TodoItem>({
    table: 'todo_items', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('todo_items').select('*').eq('family_id', familyId)
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('priority', { ascending: false }),
  });

  const loading = listsLoading || itemsLoading;
  const error = listsError || itemsError;
  const refresh = () => { void refreshLists(); void refreshItems(); };

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const now = new Date();
  const todayStr = ymd(now);
  const tomorrowStr = ymd(new Date(now.getTime() + 86400000));
  const weekEndStr = ymd(new Date(now.getTime() + 7 * 86400000));

  const active = useMemo(() => items.filter((i) => !i.is_done), [items]);
  const completed = useMemo(() => items.filter((i) => i.is_done), [items]);

  const counts = {
    all: active.length,
    mine: active.filter((i) => i.created_by === selfId).length,
    assigned: active.filter((i) => i.assigned_to_id === selfId).length,
    completed: completed.length,
  };

  // Tab → base set, then search.
  const tabItems = useMemo(() => {
    let res: TodoItem[];
    if (tab === 'completed') res = completed;
    else if (tab === 'mine') res = active.filter((i) => i.created_by === selfId);
    else if (tab === 'assigned') res = active.filter((i) => i.assigned_to_id === selfId);
    else res = active;
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter((i) => i.title.toLowerCase().includes(q));
    }
    return res;
  }, [tab, active, completed, selfId, search]);

  // Group the active tabs by due date.
  const groups = useMemo(() => {
    const g = { overdue: [] as TodoItem[], today: [] as TodoItem[], upcoming: [] as TodoItem[], noDate: [] as TodoItem[] };
    if (tab === 'completed') return g;
    for (const i of tabItems) {
      if (!i.due_date) g.noDate.push(i);
      else if (i.due_date < todayStr) g.overdue.push(i);
      else if (i.due_date === todayStr) g.today.push(i);
      else g.upcoming.push(i);
    }
    return g;
  }, [tabItems, tab, todayStr]);

  // Right-rail summary metrics (computed from ALL items, not the active tab).
  const summary = {
    total: active.length,
    overdue: active.filter((i) => i.due_date && i.due_date < todayStr).length,
    today: active.filter((i) => i.due_date === todayStr).length,
    week: active.filter((i) => i.due_date && i.due_date > todayStr && i.due_date <= weekEndStr).length,
    completed: completed.length,
  };

  const priorities = useMemo(() => {
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    return active
      .filter((i) => i.created_by === selfId || i.assigned_to_id === selfId)
      .sort((a, b) => {
        const ao = a.due_date && a.due_date < todayStr ? 0 : 1;
        const bo = b.due_date && b.due_date < todayStr ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const pr = (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2);
        if (pr !== 0) return pr;
        return (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999');
      })
      .slice(0, 4);
  }, [active, selfId, todayStr]);

  const assignedToOthers = useMemo(
    () => active.filter((i) => i.assigned_to_id && i.assigned_to_id !== selfId).slice(0, 6),
    [active, selfId],
  );

  function toggleItem(item: TodoItem) {
    return run(`toggle:${item.id}`, async () => {
      const result = await completeTodoAction(item.id, !item.is_done);
      if (!result.ok) throw new Error(result.error);
      void refreshItems();
    });
  }

  function deleteItem(id: string) {
    if (!confirm('Delete this task?')) return;
    return run(`delete:${id}`, async () => {
      // Through the service, which filters `family_id` as well as `id`. The
      // client delete filtered on `id` alone and left tenancy to RLS.
      const result = await deleteTodoAction(id);
      if (!result.ok) throw new Error(result.error);
      void refreshItems();
    });
  }

  // Ensure there's a list to attach a task to (Quick Add / first Add Task).
  async function ensureListId(): Promise<string | null> {
    if (lists.length > 0) return lists[0].id;
    const { data, error } = await createClient().from('todo_lists')
      .insert({ family_id: familyId, name: 'Tasks', icon: '📋', color: 'violet', is_shared: true })
      .select('id').single();
    if (error || !data) { toastError(describeDbError(error)); return null; }
    void refreshLists();
    return data.id;
  }

  async function quickAdd(when: 'today' | 'tomorrow' | 'week') {
    const title = quickTitle.trim();
    if (!title) { toastError('Type a task first'); return; }
    setQuickBusy(true);
    try {
      const listId = await ensureListId();
      if (!listId) return;
      const due = when === 'today' ? todayStr : when === 'tomorrow' ? tomorrowStr : weekEndStr;
      // One id per quick-add attempt, minted when the title is typed and cleared
      // when the row lands. A second press after a lost response is the same
      // task; typing "Call the dentist" again tomorrow is a different one.
      quickSubmission.current ||= newSubmissionId();
      const result = await createTodoAction({
        title, listId, dueDate: due, priority: 'medium',
        assigneeId: selfId, submissionId: quickSubmission.current,
      });
      if (!result.ok) { toastError(result.error); return; }
      quickSubmission.current = '';
      setQuickTitle('');
      success('Task added');
      void refreshItems();
    } finally {
      setQuickBusy(false);
    }
  }

  async function openAdd() {
    if (lists.length === 0) { await ensureListId(); }
    setAddOpen(true);
  }

  const TABS = [
    { id: 'all' as const, label: 'All Tasks', n: counts.all },
    { id: 'mine' as const, label: 'My Tasks', n: counts.mine },
    { id: 'assigned' as const, label: 'Assigned to Me', n: counts.assigned },
    { id: 'completed' as const, label: 'Completed', n: counts.completed },
  ];

  function TaskRow({ item }: { item: TodoItem }) {
  const tr = useTranslations();
    const p = PRIORITY_META[item.priority as keyof typeof PRIORITY_META] ?? PRIORITY_META.medium;
    const list = item.list_id ? listById.get(item.list_id) : undefined;
    const assignee = item.assigned_to_id ? memberById.get(item.assigned_to_id) : undefined;
    const overdue = !item.is_done && !!item.due_date && item.due_date < todayStr;
    const busyToggle = isPending(`toggle:${item.id}`);
    return (
      <div className="group flex items-center gap-3 rounded-xl border border-border/70 bg-surface/30 px-3 py-2.5 transition hover:bg-elevated/40">
        <button onClick={() => toggleItem(item)} disabled={busyToggle}
          aria-label={item.is_done ? 'Mark not done' : 'Mark done'}
          className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition disabled:opacity-60',
            item.is_done ? 'border-success bg-success' : 'border-border hover:border-success/60')}>
          {busyToggle ? <Loader2 className="h-3 w-3 animate-spin text-muted" /> : item.is_done && <Check className="h-3 w-3 text-white" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={cn('truncate text-sm font-medium', item.is_done && 'text-muted line-through')}>{item.title}</p>
            {overdue && <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">{tr('todos.overdue')}</span>}
            {!overdue && item.priority === 'urgent' && <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">{tr('todos.urgent')}</span>}
            {!overdue && item.priority === 'high' && <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">{tr('todos.important')}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            {list && <span aria-hidden>{list.icon}</span>}
            <span className="truncate">
              {assignee ? `${assignee.display_name} · ${list?.name ?? 'Tasks'}` : (list?.name ?? 'Tasks')}
            </span>
          </div>
        </div>

        <div className="hidden items-center gap-1 opacity-0 transition group-hover:opacity-100 sm:flex">
          <button onClick={() => setEditingItem(item)} aria-label={tr('todos.editTask')} className="rounded p-1 text-muted hover:text-fg">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => deleteItem(item.id)} disabled={isPending(`delete:${item.id}`)} aria-label={tr('todos.deleteTask')}
            className="rounded p-1 text-muted hover:text-danger disabled:opacity-50">
            {isPending(`delete:${item.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {item.due_date && (
            <span className={cn('whitespace-nowrap text-xs', overdue ? 'font-semibold text-danger' : 'text-muted')}>
              {dueLabel(item.due_date, todayStr, tomorrowStr)}
            </span>
          )}
          {assignee
            ? <Avatar name={assignee.display_name} color={assignee.color} size={26} />
            : <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-elevated text-muted"><UserIcon className="h-3.5 w-3.5" /></span>}
        </div>
      </div>
    );
  }

  function Section({ label, tone, list }: { label: string; tone: string; list: TodoItem[] }) {
    if (list.length === 0) return null;
    return (
      <div className="mb-5">
        <div className="mb-2 flex items-center gap-2">
          <h3 className={cn('text-sm font-bold', tone)}>{label}</h3>
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-elevated px-1.5 text-[11px] font-bold text-muted">{list.length}</span>
        </div>
        <div className="space-y-1.5">{list.map((i) => <TaskRow key={i.id} item={i} />)}</div>
      </div>
    );
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('todosModule.couldNotLoadTasksRefresh')} onRetry={refresh} />;

  const nothing = tabItems.length === 0;

  return (
    <div className="module-with-sidebar">
      {/* Main column */}
      <div className="module-main">
        <PageHeader
          title={tr('todos.tasks')}
          description={tr('todosModule.stayOrganizedAndGetThings')}
          action={
            <div className="flex items-center gap-2">
              <AiInsight kind="todos" />
              <Button variant="outline" size="sm" onClick={() => setTab('assigned')}>
                <UserIcon className="h-4 w-4" /> {tr('todos.myTasks')}
              </Button>
              <Button size="sm" onClick={openAdd}><Plus className="h-4 w-4" /> {tr('todos.addTask')}</Button>
            </div>
          }
        />

        {/* Tabs + search */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition',
                  tab === t.id ? 'bg-brand/15 text-brand-text' : 'text-muted hover:bg-elevated hover:text-fg')}>
                {t.label}
                <span className={cn('grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-bold',
                  tab === t.id ? 'bg-brand/25 text-brand-text' : 'bg-elevated text-muted')}>{t.n}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('todos.searchTasks')}
              className="w-32 bg-transparent text-sm placeholder:text-muted outline-none sm:w-40" />
            {search && <button onClick={() => setSearch('')} aria-label={tr('todos.clearSearch')}><X className="h-3.5 w-3.5 text-muted" /></button>}
          </div>
        </div>

        {/* Body */}
        <div className="mt-4">
          {nothing ? (
            <EmptyState icon={CheckSquare}
              title={tab === 'completed' ? 'No completed tasks' : 'All clear!'}
              description={tab === 'completed' ? 'Finished tasks will show up here.' : 'No tasks here yet — add one to get started.'}
              action={tab !== 'completed' ? <Button onClick={openAdd}><Plus className="h-4 w-4" /> {tr('todos.addTask')}</Button> : undefined} />
          ) : tab === 'completed' ? (
            <div className="space-y-1.5">{tabItems.map((i) => <TaskRow key={i.id} item={i} />)}</div>
          ) : (
            <>
              <Section label={tr('todos.overdue')} tone="text-danger" list={groups.overdue} />
              <Section label={tr('todos.today')} tone="text-brand-text" list={groups.today} />
              <Section label={tr('todos.upcoming')} tone="text-fg" list={groups.upcoming} />
              <Section label={tr('todos.noDueDate')} tone="text-muted" list={groups.noDate} />
            </>
          )}

          <button onClick={openAdd}
            className="mt-2 flex w-full items-center gap-2 rounded-xl border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted transition hover:border-brand/40 hover:text-brand-text">
            <Plus className="h-4 w-4" /> {tr('todos.addTask')}
          </button>
        </div>
      </div>

      {/* Right rail */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* Task Summary */}
        <div className="sidebar-card">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><ListChecks className="h-4 w-4 text-brand-text" /> {tr('todos.taskSummary')}</h3>
          <SummaryDonut summary={summary} />
          <div className="mt-3 space-y-1.5">
            {([['overdue', summary.overdue], ['today', summary.today], ['week', summary.week], ['completed', summary.completed]] as const).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: DONUT[k].hex }} />
                <span className="flex-1 text-muted">{DONUT[k].label}</span>
                <span className="font-semibold">{v}</span>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => setTab('all')}>{tr('todos.viewAllTasks')}</Button>
        </div>

        {/* My Top Priorities */}
        <div className="sidebar-card">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><Flag className="h-4 w-4 text-brand-text" /> {tr('todos.myTopPriorities')}</h3>
          {priorities.length === 0 ? (
            <p className="text-xs text-muted">{tr('todos.nothingAssignedToYouYet')}</p>
          ) : (
            <div className="space-y-2">
              {priorities.map((i) => {
                const overdue = i.due_date && i.due_date < todayStr;
                return (
                  <button key={i.id} onClick={() => setEditingItem(i)} className="flex w-full items-center gap-2 text-left">
                    <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-border" />
                    <span className="flex-1 truncate text-xs font-medium">{i.title}</span>
                    {i.due_date && (
                      <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                        overdue ? 'bg-danger/15 text-danger' : i.due_date === todayStr ? 'bg-amber-500/15 text-amber-400' : 'bg-elevated text-muted')}>
                        {overdue ? 'Overdue' : dueLabel(i.due_date, todayStr, tomorrowStr)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => setTab('mine')}>{tr('todos.viewMyTasks')}</Button>
        </div>

        {/* Assigned to Others */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-bold"><UserIcon className="h-4 w-4 text-brand-text" /> {tr('todos.assignedToOthers')}</h3>
            <button onClick={() => setTab('all')} className="text-[11px] font-medium text-brand-text hover:underline">{tr('todos.viewAll')}</button>
          </div>
          {assignedToOthers.length === 0 ? (
            <p className="text-xs text-muted">{tr('todos.noTasksAssignedToOthers')}</p>
          ) : (
            <div className="space-y-2.5">
              {assignedToOthers.map((i) => {
                const m = i.assigned_to_id ? memberById.get(i.assigned_to_id) : undefined;
                return (
                  <button key={i.id} onClick={() => setEditingItem(i)} className="flex w-full items-center gap-2.5 text-left">
                    {m && <Avatar name={m.display_name} color={m.color} size={28} />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">{m?.display_name ?? 'Member'}</p>
                      <p className="truncate text-[11px] text-muted">{i.title}</p>
                    </div>
                    {i.due_date && <span className="shrink-0 text-[11px] text-muted">{dueLabel(i.due_date, todayStr, tomorrowStr)}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Quick Add */}
        <div className="sidebar-card">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold"><Sparkles className="h-4 w-4 text-brand-text" /> {tr('todos.quickAdd')}</h3>
          <Input value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void quickAdd('today'); } }}
            placeholder={tr('todos.whatNeedsToBeDone')} disabled={quickBusy} />
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {([['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This Week']] as const).map(([w, label]) => (
              <button key={w} onClick={() => void quickAdd(w)} disabled={quickBusy}
                className="flex flex-col items-center gap-1 rounded-lg border border-border bg-surface/40 py-2 text-[10px] font-medium text-muted transition hover:border-brand/40 hover:text-brand-text disabled:opacity-50">
                <CalendarIcon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
            <button onClick={openAdd} disabled={quickBusy}
              className="flex flex-col items-center gap-1 rounded-lg border border-border bg-surface/40 py-2 text-[10px] font-medium text-muted transition hover:border-brand/40 hover:text-brand-text disabled:opacity-50">
              <CalendarIcon className="h-3.5 w-3.5" /> {tr('todos.pickDate')}
            </button>
          </div>
        </div>
      </div>

      {/* Modals */}
      {newListOpen && (
        <NewListModal familyId={familyId}
          onClose={() => setNewListOpen(false)}
          onCreated={() => { setNewListOpen(false); void refreshLists(); }} />
      )}
      {(addOpen || editingItem) && (
        <ItemModal familyId={familyId} selfId={selfId} members={members} lists={lists}
          item={editingItem ?? undefined}
          onNewList={() => setNewListOpen(true)}
          onClose={() => { setAddOpen(false); setEditingItem(null); }}
          onSaved={() => { setAddOpen(false); setEditingItem(null); void refreshItems(); }} />
      )}
    </div>
  );
}

function SummaryDonut({ summary }: { summary: { total: number; overdue: number; today: number; week: number; completed: number } }) {
  const tr = useTranslations();
  const segs = [
    { v: summary.overdue, hex: DONUT.overdue.hex },
    { v: summary.today, hex: DONUT.today.hex },
    { v: summary.week, hex: DONUT.week.hex },
    { v: summary.completed, hex: DONUT.completed.hex },
  ];
  const sum = segs.reduce((a, s) => a + s.v, 0);
  let acc = 0;
  const stops = sum === 0
    ? 'var(--elevated, #2a2a33) 0% 100%'
    : segs.filter((s) => s.v > 0).map((s) => {
        const start = (acc / sum) * 100; acc += s.v; const end = (acc / sum) * 100;
        return `${s.hex} ${start}% ${end}%`;
      }).join(', ');
  return (
    <div className="flex justify-center">
      <div className="relative h-32 w-32">
        <div className="h-32 w-32 rounded-full" style={{ background: `conic-gradient(${stops})` }} />
        <div className="absolute inset-[14px] grid place-items-center rounded-full bg-surface">
          <span className="text-2xl font-bold leading-none">{summary.total}</span>
          <span className="mt-0.5 text-[10px] text-muted">{tr('todos.totalTasks')}</span>
        </div>
      </div>
    </div>
  );
}

function NewListModal({ familyId, onClose, onCreated }: {
  familyId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📋');
  const [color, setColor] = useState('violet');
  const [isShared, setIsShared] = useState(true);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = name.trim();
    if (!trimmed) { toastError('Give your category a name'); return; }
    if (trimmed.length > 80) { toastError('Name is too long (max 80 characters)'); return; }
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from('todo_lists').insert({
        family_id: familyId, name: trimmed, icon, color, is_shared: isShared,
      }).select('id').single();
      if (error || !data) { toastError(describeDbError(error)); return; }
      onCreated(data.id);
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={tr('todos.newCategory')}>
      <form onSubmit={create} className="space-y-4">
        <Field label={tr('todos.name')} required>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('todos.schoolShoppingChores')} autoFocus />}
        </Field>
        <Field label={tr('todos.icon')}>
          {() => (
            <div className="flex flex-wrap gap-2">
              {LIST_ICONS.map((e) => (
                <button key={e} type="button" onClick={() => setIcon(e)}
                  className={cn('rounded-xl p-2 text-xl hover:bg-elevated transition', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>
                  {e}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={tr('todos.color')}>
          {() => (
            <div className="flex gap-2">
              {Object.keys(LIST_COLORS).map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={cn('h-7 w-7 rounded-full', LIST_COLORS[c], color === c && 'ring-2 ring-offset-2 ring-brand')} />
              ))}
            </div>
          )}
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={isShared} onChange={(e) => setIsShared(e.target.checked)} className="accent-brand" />
          {tr('todos.sharedWithFamily')}
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('todos.cancel')}</Button>
          <Button type="submit" loading={loading}>{tr('todos.create')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({ familyId, selfId, lists, members, item, onClose, onSaved, onNewList }: {
  familyId: string; selfId: string | null;
  lists: TodoList[];
  members: ReturnType<typeof useApp>['members'];
  item?: TodoItem; onClose: () => void; onSaved: () => void; onNewList: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState(item?.title ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [priority, setPriority] = useState(item?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(item?.due_date ?? '');
  const [assignedTo, setAssignedTo] = useState(item?.assigned_to_id ?? '');
  const [listId, setListId] = useState(item?.list_id ?? lists[0]?.id ?? '');
  // One id for this composition of this task, held across every retry of it. The
  // modal unmounts on save and on close, so the next New Task mints a new one and
  // two children each needing "Pack the kit" both get a row; a Save pressed again
  // after a response that never arrived reuses this one and gets the first back.
  const submissionId = useRef('');
  if (!submissionId.current) submissionId.current = newSubmissionId();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = title.trim();
    if (!trimmed) { toastError('Add a task title'); return; }
    if (trimmed.length > 200) { toastError('Title is too long (max 200 characters)'); return; }
    if (!listId) { toastError('Pick a category'); return; }
    setLoading(true);
    try {
      // list_id is fixed at creation, so it is a create-only field — the service's
      // update patch has no way to express a move between lists either.
      const fields = {
        title: trimmed, notes: notes.trim() || null, priority,
        dueDate: dueDate || null, assigneeId: assignedTo || null,
      };
      // No family_id and no created_by: the action reads both from the session.
      const result = item
        ? await updateTodoAction(item.id, fields)
        : await createTodoAction({ ...fields, listId, submissionId: submissionId.current });
      if (!result.ok) { toastError(result.error); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={item ? 'Edit Task' : 'New Task'}>
      <form onSubmit={save} className="space-y-4">
        <Field label={tr('todos.title')} required>
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('todos.whatNeedsToBeDone')} autoFocus />}
        </Field>
        <Field label={tr('todos.notes')}>
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder={tr('todos.optionalDetails')} />}
        </Field>
        <Field label={tr('todos.category')} hint={item ? 'Set when the task is created' : undefined}>
          {(id) => (
            <div className="flex gap-2">
              <select id={id} value={listId} onChange={(e) => setListId(e.target.value)} disabled={!!item}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60">
                {lists.length === 0 && <option value="">{tr('todos.noCategoriesYet')}</option>}
                {lists.map((l) => <option key={l.id} value={l.id}>{l.icon} {l.name}</option>)}
              </select>
              {!item && <Button type="button" variant="secondary" size="sm" onClick={onNewList}>New</Button>}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('todos.priority')}>
            {(id) => (
              <select id={id} value={priority} onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand">
                {Object.entries(PRIORITY_META).map(([val, meta]) => <option key={val} value={val}>{meta.label}</option>)}
              </select>
            )}
          </Field>
          <Field label={tr('todos.dueDate')}>
            {(id) => <Input id={id} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
          </Field>
        </div>
        <Field label={tr('todos.assignTo')}>
          {(id) => (
            <select id={id} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}
              className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand">
              <option value="">{tr('todos.unassigned')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          )}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('todos.cancel')}</Button>
          <Button type="submit" loading={loading}>{item ? 'Save' : 'Add Task'}</Button>
        </div>
      </form>
    </Modal>
  );
}
