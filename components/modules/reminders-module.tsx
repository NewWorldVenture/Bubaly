'use client';

import { useMemo, useState } from 'react';
import {
  Bell, Plus, Check, Clock, MapPin, Repeat, Pill, CreditCard,
  GraduationCap, CheckSquare, Trash2, Edit2, Sparkles, X,
  AlertTriangle, Calendar, User, AlarmClock, Loader2,
  Flag, Link2, Image as ImageIcon, Tag, ListChecks, ListTodo, ChevronDown, Search,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError, isMissingRelationError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { fmtDate, fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import {
  EARLY_REMINDER_OPTIONS, earlyReminderLabel, parseTags, formatTags, normalizeSubtasks, newSubtask, subtaskProgress, nextRemindAt,
  type Subtask,
} from '@/lib/reminders/details';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Reminder = Tables<'family_reminders'>;

const KINDS = [
  { id: 'time', label: 'Time-based', icon: Clock, color: 'text-brand-text' },
  { id: 'location', label: 'Location', icon: MapPin, color: 'text-accent' },
  { id: 'recurring', label: 'Recurring', icon: Repeat, color: 'text-success' },
  { id: 'medication', label: 'Medication', icon: Pill, color: 'text-danger' },
  { id: 'bill', label: 'Bill / Payment', icon: CreditCard, color: 'text-warning' },
  { id: 'school', label: 'School', icon: GraduationCap, color: 'text-purple-400' },
  { id: 'chore', label: 'Chore', icon: CheckSquare, color: 'text-teal-400' },
] as const;

const PRIORITIES = [
  { id: 'low', label: 'Low', color: 'text-muted', badge: 'neutral' },
  { id: 'medium', label: 'Medium', color: 'text-warning', badge: 'warning' },
  { id: 'high', label: 'High', color: 'text-danger', badge: 'danger' },
  { id: 'urgent', label: 'Urgent', color: 'text-danger', badge: 'danger' },
] as const;

const RECURRENCES = [
  { id: 'none', label: 'No repeat' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { id: 'weekly', label: 'Every week' },
  { id: 'biweekly', label: 'Every 2 weeks' },
  { id: 'monthly', label: 'Every month' },
  { id: 'yearly', label: 'Every year' },
] as const;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function kindMeta(id: string) {
  return KINDS.find((k) => k.id === id) ?? KINDS[0];
}

// Columns added by migration 0100. Stripped on a missing-column error so saves
// keep working before the migration is applied (the fields persist once it is).
const NEW_REMINDER_COLS = ['url', 'flagged', 'early_reminder_minutes', 'image_url', 'subtasks', 'list_id'] as const;
function stripNewCols<T extends Record<string, unknown>>(obj: T): T {
  const copy = { ...obj };
  for (const k of NEW_REMINDER_COLS) delete (copy as Record<string, unknown>)[k];
  return copy;
}

function isOverdue(r: Reminder) {
  if (!r.remind_at || r.status !== 'active') return false;
  return new Date(r.remind_at) < new Date();
}

// ── Quick-add reminder templates (common household reminders) ──
const AI_SUGGESTIONS = [
  { title: 'Prescription refill', kind: 'medication', priority: 'high', notes: 'Check the pharmacy portal or call ahead.' },
  { title: 'Pay monthly bills', kind: 'bill', priority: 'medium', notes: 'Review credit card, utilities, and insurance.' },
  { title: 'Weekly family sync', kind: 'recurring', priority: 'medium', notes: 'Review the upcoming week together.' },
  { title: 'School permission slip deadline', kind: 'school', priority: 'high', notes: 'Check your child\'s backpack and school portal.' },
  { title: 'Morning vitamins', kind: 'medication', priority: 'medium', notes: 'Take with breakfast.' },
];

export function RemindersModule() {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });

  const [tab, setTab] = useState<'active' | 'completed' | 'all'>('active');
  const [filterKind, setFilterKind] = useState('all');
  const [query, setQuery] = useState('');
  const [filterList, setFilterList] = useState('all');
  const [filterFlagged, setFilterFlagged] = useState(false);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data: lists, loading: listsLoading, error: listsError, refresh: refreshLists } = useRealtimeQuery<Tables<'reminder_lists'>>({
    table: 'reminder_lists', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('reminder_lists').select('*').eq('family_id', familyId).order('sort_order'),
  });
  const listById = useMemo(() => new Map((lists ?? []).map((l) => [l.id, l])), [lists]);

  const { data: reminders, loading, error, refresh } = useRealtimeQuery<Reminder>({
    table: 'family_reminders', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('family_reminders').select('*').eq('family_id', familyId)
        .order('status', { ascending: true })
        .order('remind_at', { ascending: true, nullsFirst: false }),
  });

  const combinedLoading = listsLoading || loading;
  const combinedError = listsError || error;
  const retry = () => { void refreshLists(); void refresh(); };

  const filtered = useMemo(() => {
    let rows = reminders;
    if (tab === 'active') rows = rows.filter((r) => r.status === 'active' || r.status === 'snoozed');
    if (tab === 'completed') rows = rows.filter((r) => r.status === 'completed' || r.status === 'dismissed');
    if (filterKind !== 'all') rows = rows.filter((r) => r.kind === filterKind);
    if (filterList !== 'all') rows = rows.filter((r) => filterList === 'none' ? !r.list_id : r.list_id === filterList);
    if (filterFlagged) rows = rows.filter((r) => r.flagged);
    if (filterTag) rows = rows.filter((r) => (r.tags ?? []).includes(filterTag));
    const q = query.trim().toLowerCase();
    if (q) rows = rows.filter((r) => `${r.title} ${r.notes ?? ''}`.toLowerCase().includes(q));
    return rows;
  }, [reminders, tab, filterKind, filterList, filterFlagged, filterTag, query]);

  // Every tag in use, for the "filter by tag" chips (iOS taps a tag to filter).
  const allTags = useMemo(() => {
    const seen = new Set<string>();
    for (const r of reminders) for (const t of r.tags ?? []) seen.add(t);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [reminders]);

  const filtersActive = filterKind !== 'all' || filterList !== 'all' || filterFlagged || filterTag != null;
  function clearFilters() {
    setFilterKind('all'); setFilterList('all'); setFilterFlagged(false); setFilterTag(null);
  }

  async function deleteList(id: string) {
    if (!confirm('Delete this list? Reminders in it are kept (just un-listed).')) return;
    const { error: err } = await createClient().from('reminder_lists').delete().eq('id', id);
    if (err) { toastError(describeDbError(err)); return; }
    setFilterList('all');
    success('List deleted');
  }

  const overdue = reminders.filter(isOverdue);
  const activeCount = reminders.filter((r) => r.status === 'active').length;

  function complete(reminder: Reminder) {
    return run(`complete:${reminder.id}`, async () => {
      const supabase = createClient();
      const { error } = await supabase.from('family_reminders')
        .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', reminder.id);
      if (error) throw error;

      // Recurring reminder → spawn the next occurrence so it keeps recurring
      // (the completed one stays as history, like iOS).
      let recurred = false;
      const next = reminder.remind_at && reminder.recurrence !== 'none'
        ? nextRemindAt(reminder.remind_at, reminder.recurrence) : null;
      if (next) {
        const nextRow = {
          family_id: familyId, created_by: userId, title: reminder.title, notes: reminder.notes,
          kind: reminder.kind, priority: reminder.priority, recurrence: reminder.recurrence,
          location_name: reminder.location_name, remind_at: next, member_id: reminder.member_id,
          assigned_to_id: reminder.assigned_to_id, url: reminder.url, flagged: reminder.flagged,
          early_reminder_minutes: reminder.early_reminder_minutes, image_url: reminder.image_url,
          // Fresh occurrence starts with its subtasks unchecked.
          subtasks: normalizeSubtasks(reminder.subtasks).map((s) => ({ ...s, done: false })) as unknown as Reminder['subtasks'],
          list_id: reminder.list_id, tags: reminder.tags, status: 'active',
        };
        let { error: insErr } = await supabase.from('family_reminders').insert(nextRow);
        if (insErr && isMissingRelationError(insErr)) ({ error: insErr } = await supabase.from('family_reminders').insert(stripNewCols(nextRow)));
        recurred = !insErr;
      }
      success(recurred ? 'Completed ✓ — next one scheduled' : 'Reminder completed ✓');
      void refresh();
    });
  }

  // Check a subtask off without opening the editor (iOS-style inline).
  function toggleSubtask(reminder: Reminder, subtaskId: string) {
    return run(`subtask:${reminder.id}:${subtaskId}`, async () => {
      const next = normalizeSubtasks(reminder.subtasks).map((s) => s.id === subtaskId ? { ...s, done: !s.done } : s);
      const supabase = createClient();
      const { error } = await supabase.from('family_reminders')
        .update({ subtasks: next as unknown as Reminder['subtasks'] }).eq('id', reminder.id);
      // Pre-0100 the subtasks column may not exist yet — degrade silently.
      if (error && !isMissingRelationError(error)) throw error;
      void refresh();
    });
  }

  function snooze(id: string, mins: number) {
    return run(`snooze:${id}`, async () => {
      const until = new Date(Date.now() + mins * 60000).toISOString();
      const { error } = await createClient().from('family_reminders')
        .update({ status: 'snoozed', snoozed_until: until }).eq('id', id);
      if (error) throw error;
      success(`Snoozed for ${mins < 60 ? mins + ' min' : mins / 60 + ' hr'}`);
      void refresh();
    });
  }

  function deleteReminder(id: string) {
    return run(`delete:${id}`, async () => {
      const { error } = await createClient().from('family_reminders').delete().eq('id', id);
      if (error) throw error;
      success('Reminder deleted');
      void refresh();
    });
  }

  function quickAdd(suggestion: typeof AI_SUGGESTIONS[0]) {
    return run(`quickadd:${suggestion.title}`, async () => {
      const { error } = await createClient().from('family_reminders').insert({
        family_id: familyId,
        created_by: userId,
        title: suggestion.title,
        kind: suggestion.kind,
        priority: suggestion.priority,
        notes: suggestion.notes,
        ai_suggested: true,
      });
      if (error) throw error;
      success('Reminder added from suggestion');
      void refresh();
    });
  }

  if (combinedLoading) return <SkeletonList />;
  if (combinedError) return <ErrorState message="Could not load reminders. Refresh and try again." onRetry={retry} />;

  return (
    <div className="module-page">
      <PageHeader
        title={tr('reminders.smartReminders')}
        description="Never let anything slip through the cracks."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="reminders" iconOnly />
            <Button variant="outline" onClick={() => setShowSuggestions(!showSuggestions)}>
              <Sparkles className="h-4 w-4 text-brand-text" /> {tr('reminders.quickAdd')}
            </Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> {tr('reminders.newReminder')}</Button>
          </div>
        }
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Active', value: activeCount, icon: Bell, color: 'text-brand-text' },
          { label: 'Overdue', value: overdue.length, icon: AlertTriangle, color: 'text-danger' },
          { label: 'Completed', value: reminders.filter((r) => r.status === 'completed').length, icon: Check, color: 'text-success' },
          { label: 'Total', value: reminders.length, icon: Calendar, color: 'text-muted' },
        ].map((s) => (
          <div key={s.label} className="stat-card">
            <s.icon className={cn('h-8 w-8 flex-shrink-0', s.color)} />
            <div>
              <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
              <div className="text-[11px] text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Overdue alert */}
      {overdue.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/8 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" />
          <div>
            <p className="text-sm font-bold text-danger">{overdue.length} {tr('reminders.overdueReminder')}{overdue.length > 1 ? 's' : ''}</p>
            <p className="text-xs text-muted">{overdue.map((r) => r.title).join(', ')}</p>
          </div>
        </div>
      )}

      {/* AI Suggestions panel */}
      {showSuggestions && (
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand-text" /> {tr('reminders.commonReminders')}
            </p>
            <button onClick={() => setShowSuggestions(false)}><X className="h-4 w-4 text-muted" /></button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {AI_SUGGESTIONS.map((s) => {
              const kind = kindMeta(s.kind);
              return (
                <button key={s.title} onClick={() => quickAdd(s)} disabled={isPending(`quickadd:${s.title}`)}
                  className="flex items-start gap-3 rounded-xl border border-border/60 bg-surface/60 p-3 text-left transition hover:bg-elevated/40 hover:border-brand/30 disabled:opacity-50">
                  <kind.icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', kind.color)} />
                  <div>
                    <p className="text-sm font-semibold">{s.title}</p>
                    <p className="text-xs text-muted">{s.notes}</p>
                  </div>
                  {isPending(`quickadd:${s.title}`)
                    ? <Loader2 className="ml-auto h-4 w-4 flex-shrink-0 animate-spin text-brand-text" />
                    : <Plus className="ml-auto h-4 w-4 flex-shrink-0 text-brand-text" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="tab-bar">
          {(['active', 'completed', 'all'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('tab-item capitalize', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('reminders.searchReminders')}
              className="w-40 rounded-xl border border-border bg-surface/60 py-2 pl-8 pr-7 text-xs outline-none transition focus:border-brand/50 sm:w-52" />
            {query && (
              <button onClick={() => setQuery('')} aria-label={tr('reminders.clearSearch')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* Flagged filter (iOS "Flagged" smart list) */}
          <button onClick={() => setFilterFlagged((f) => !f)} aria-pressed={filterFlagged}
            className={cn('flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition',
              filterFlagged ? 'border-warning/60 bg-warning/10 text-warning' : 'border-border bg-surface/60 text-muted hover:bg-elevated')}>
            <Flag className="h-3.5 w-3.5" /> {tr('reminders.flagged')}
          </button>
          {/* Kind filter */}
          <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)}
            className="rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs text-muted focus:outline-none">
            <option value="all">{tr('reminders.allTypes')}</option>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          {/* List filter */}
          {(lists ?? []).length > 0 && (
            <div className="flex items-center gap-1">
              <select value={filterList} onChange={(e) => setFilterList(e.target.value)}
                className="rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs text-muted focus:outline-none">
                <option value="all">{tr('reminders.allLists')}</option>
                {(lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                <option value="none">{tr('reminders.noList')}</option>
              </select>
              {filterList !== 'all' && filterList !== 'none' && (
                <button onClick={() => deleteList(filterList)} aria-label={tr('reminders.deleteList')} className="rounded-lg p-1.5 text-muted hover:text-danger">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tag filter chips (iOS taps a tag to filter) */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="h-3.5 w-3.5 text-muted" />
          {allTags.map((t) => (
            <button key={t} onClick={() => setFilterTag((cur) => cur === t ? null : t)} aria-pressed={filterTag === t}
              className={cn('rounded-full border px-2.5 py-0.5 text-[11px] transition',
                filterTag === t ? 'border-brand/60 bg-brand/10 text-brand-text' : 'border-border bg-surface/40 text-muted hover:bg-elevated')}>
              {t}
            </button>
          ))}
          {filterTag && (
            <button onClick={() => setFilterTag(null)} className="flex items-center gap-0.5 text-[11px] text-muted hover:text-fg">
              <X className="h-3 w-3" /> {tr('reminders.clear')}
            </button>
          )}
        </div>
      )}

      {/* Reminder list */}
      {filtered.length === 0 ? (
        filtersActive ? (
          <EmptyState icon={Bell} title={tr('reminders.noMatchingReminders')}
            description="Nothing matches the current filters. Clear them to see everything."
            action={<Button variant="outline" onClick={clearFilters}><X className="h-4 w-4" /> {tr('reminders.clearFilters')}</Button>} />
        ) : (
          <EmptyState icon={Bell} title={tr('reminders.noReminders')}
            description="Set time-based, location, medication, or recurring reminders for your family."
            action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> {tr('reminders.addReminder')}</Button>} />
        )
      ) : (
        <div className="space-y-2">
          {filtered.map((reminder) => {
            const kind = kindMeta(reminder.kind);
            const priority = PRIORITIES.find((p) => p.id === reminder.priority) ?? PRIORITIES[1];
            const overdue = isOverdue(reminder);
            const completed = reminder.status === 'completed';
            const snoozed = reminder.status === 'snoozed';
            const member = reminder.member_id ? members.find((m) => m.id === reminder.member_id) : null;

            return (
              <div key={reminder.id}
                className={cn(
                  'group relative flex items-start gap-4 rounded-2xl border p-4 transition',
                  completed && 'opacity-50',
                  overdue && !completed ? 'border-danger/30 bg-danger/5' : 'border-border bg-surface/30 hover:bg-surface/50',
                  snoozed && 'border-warning/30 bg-warning/5',
                )}>
                {/* Complete button */}
                <button onClick={() => !completed && complete(reminder)} disabled={completed || isPending(`complete:${reminder.id}`)}
                  aria-label={completed ? 'Completed' : 'Mark complete'}
                  className={cn(
                    'mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 transition',
                    completed
                      ? 'border-success bg-success text-white'
                      : 'border-border hover:border-success hover:bg-success/10',
                  )}>
                  {isPending(`complete:${reminder.id}`)
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin text-success" />
                    : completed && <Check className="h-3.5 w-3.5" />}
                </button>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className={cn('text-sm font-semibold', completed && 'line-through text-muted')}>
                      {reminder.title}
                    </p>
                    <Badge tone={priority.badge as 'neutral'}>{priority.label}</Badge>
                    {snoozed && <Badge tone="warning">{tr('reminders.snoozed')}</Badge>}
                    {overdue && !completed && <Badge tone="danger">{tr('reminders.overdue')}</Badge>}
                    {reminder.ai_suggested && (
                      <span className="flex items-center gap-0.5 text-[10px] text-brand-text/70">
                        <Sparkles className="h-2.5 w-2.5" /> AI
                      </span>
                    )}
                  </div>

                  {reminder.notes && <p className="mt-0.5 text-xs text-muted">{reminder.notes}</p>}

                  <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
                    <span className={cn('flex items-center gap-1', kind.color)}>
                      <kind.icon className="h-3.5 w-3.5" />
                      {kind.label}
                    </span>
                    {reminder.remind_at && (
                      <span className={cn('flex items-center gap-1', overdue && 'text-danger')}>
                        <Clock className="h-3.5 w-3.5" />
                        {fmtDate(reminder.remind_at, 'MMM d · h:mm a')}
                      </span>
                    )}
                    {reminder.recurrence !== 'none' && (
                      <span className="flex items-center gap-1 text-success">
                        <Repeat className="h-3.5 w-3.5" />
                        {RECURRENCES.find((r) => r.id === reminder.recurrence)?.label}
                      </span>
                    )}
                    {reminder.location_name && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" /> {reminder.location_name}
                      </span>
                    )}
                    {member && (
                      <span className="flex items-center gap-1">
                        <User className="h-3.5 w-3.5" />
                        {member.display_name}
                      </span>
                    )}
                    {reminder.list_id && listById.get(reminder.list_id) && (
                      <span className="flex items-center gap-1"><ListTodo className="h-3.5 w-3.5" />{listById.get(reminder.list_id)!.name}</span>
                    )}
                    {reminder.flagged && <span className="flex items-center gap-1 text-warning"><Flag className="h-3.5 w-3.5" />{tr('reminders.flagged')}</span>}
                    {reminder.early_reminder_minutes != null && (
                      <span className="flex items-center gap-1"><Bell className="h-3.5 w-3.5" />{earlyReminderLabel(reminder.early_reminder_minutes)}</span>
                    )}
                    {(() => { const st = normalizeSubtasks(reminder.subtasks); return st.length > 0 ? (
                      <button type="button" onClick={() => setExpanded((cur) => { const n = new Set(cur); n.has(reminder.id) ? n.delete(reminder.id) : n.add(reminder.id); return n; })}
                        aria-expanded={expanded.has(reminder.id)}
                        className="flex items-center gap-1 transition hover:text-fg">
                        <ListChecks className="h-3.5 w-3.5" />{subtaskProgress(st).done}/{subtaskProgress(st).total}
                        <ChevronDown className={cn('h-3 w-3 transition-transform', expanded.has(reminder.id) && 'rotate-180')} />
                      </button>
                    ) : null; })()}
                    {reminder.url && (
                      <a href={reminder.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-brand-text hover:underline" onClick={(e) => e.stopPropagation()}>
                        <Link2 className="h-3.5 w-3.5" />{tr('reminders.link')}
                      </a>
                    )}
                    {(reminder.tags ?? []).map((t) => (
                      <button key={t} type="button" onClick={() => setFilterTag((cur) => cur === t ? null : t)}
                        className={cn('flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] transition hover:bg-brand/15',
                          filterTag === t ? 'bg-brand/15 text-brand-text' : 'bg-elevated')}>
                        <Tag className="h-2.5 w-2.5" />{t}
                      </button>
                    ))}
                  </div>

                  {/* Inline subtasks — check off without opening the editor */}
                  {expanded.has(reminder.id) && (
                    <div className="mt-2 space-y-1 border-l-2 border-border/60 pl-3">
                      {normalizeSubtasks(reminder.subtasks).map((s) => {
                        const busy = isPending(`subtask:${reminder.id}:${s.id}`);
                        return (
                          <button key={s.id} type="button" onClick={() => toggleSubtask(reminder, s.id)} disabled={busy}
                            className="flex w-full items-center gap-2 text-left text-xs disabled:opacity-50">
                            <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border', s.done ? 'border-success bg-success text-white' : 'border-border')}>
                              {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : s.done && <Check className="h-2.5 w-2.5" />}
                            </span>
                            <span className={cn(s.done && 'text-muted line-through')}>{s.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {reminder.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={reminder.image_url} alt="" className="mt-2 h-20 w-20 rounded-lg object-cover" />
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  {!completed && (
                    <div className="relative">
                      <details className="group/snooze">
                        <summary className="list-none cursor-pointer rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-warning">
                          <AlarmClock className="h-4 w-4" />
                        </summary>
                        <div className="absolute right-0 top-8 z-10 rounded-xl border border-border bg-elevated p-1.5 shadow-xl min-w-[140px]">
                          {[[15,'15 min'],[60,'1 hour'],[180,'3 hours'],[1440,'Tomorrow']].map(([m, l]) => (
                            <button key={m} onClick={() => snooze(reminder.id, Number(m))} disabled={isPending(`snooze:${reminder.id}`)}
                              className="block w-full rounded-lg px-3 py-1.5 text-left text-xs hover:bg-surface disabled:opacity-50">
                              {l}
                            </button>
                          ))}
                        </div>
                      </details>
                    </div>
                  )}
                  <button onClick={() => setEditing(reminder)} aria-label={tr('reminders.editReminder')}
                    className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => deleteReminder(reminder.id)} disabled={isPending(`delete:${reminder.id}`)} aria-label={tr('reminders.deleteReminder')}
                    className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-danger disabled:opacity-50">
                    {isPending(`delete:${reminder.id}`) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(addOpen || editing) && (
        <ReminderModal
          reminder={editing}
          familyId={familyId}
          userId={userId}
          members={members}
          lists={lists ?? []}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function ReminderModal({ reminder, familyId, userId, members, lists, onClose, onSaved }: {
  reminder: Reminder | null;
  familyId: string; userId: string;
  members: Tables<'family_members'>[];
  lists: Tables<'reminder_lists'>[];
  onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState(reminder?.kind ?? 'time');
  const [recurrence, setRecurrence] = useState(reminder?.recurrence ?? 'none');
  // iOS-parity detail fields.
  const [flagged, setFlagged] = useState(reminder?.flagged ?? false);
  const [listId, setListId] = useState(reminder?.list_id ?? '');
  const [earlyMinutes, setEarlyMinutes] = useState<string>(reminder?.early_reminder_minutes != null ? String(reminder.early_reminder_minutes) : '');
  const [tags, setTags] = useState<string[]>(reminder?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [subtasks, setSubtasks] = useState<Subtask[]>(normalizeSubtasks(reminder?.subtasks));
  const [subtaskInput, setSubtaskInput] = useState('');
  const [imageUrl, setImageUrl] = useState(reminder?.image_url ?? '');
  const [uploading, setUploading] = useState(false);

  function commitTags() {
    const merged = parseTags([formatTags(tags), tagInput].filter(Boolean).join(','));
    setTags(merged); setTagInput('');
    return merged;
  }
  function addSubtask() {
    const t = subtaskInput.trim();
    if (!t) return;
    setSubtasks((s) => [...s, newSubtask(t)]); setSubtaskInput('');
  }
  async function uploadImage(file: File) {
    if (file.size > 25 * 1024 * 1024) { toastError('Image is too large (max 25 MB)'); return; }
    setUploading(true);
    try {
      const supabase = createClient();
      const ext = file.name.split('.').pop();
      const path = `${familyId}/reminders/${Date.now()}.${ext}`;
      const { data: stored, error: upErr } = await supabase.storage.from('family-media').upload(path, file, { upsert: false });
      if (upErr || !stored) { toastError(describeDbError(upErr)); return; }
      const { data: { publicUrl } } = supabase.storage.from('family-media').getPublicUrl(stored.path);
      setImageUrl(publicUrl);
    } finally {
      setUploading(false);
    }
  }
  async function createList(): Promise<string | null> {
    const name = window.prompt('New list name')?.trim();
    if (!name) return null;
    const { data, error } = await createClient().from('reminder_lists')
      .insert({ family_id: familyId, created_by: userId, name }).select('id').single();
    if (error || !data) { toastError(describeDbError(error)); return null; }
    setListId(data.id);
    return data.id;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const g = (k: string) => String(form.get(k) ?? '').trim() || null;
    const remindAtRaw = g('remind_at');
    const finalTags = commitTags();
    const payload = {
      title: g('title') ?? '',
      notes: g('notes'),
      kind,
      priority: g('priority') ?? 'medium',
      recurrence,
      location_name: kind === 'location' ? g('location_name') : null,
      remind_at: remindAtRaw ? new Date(remindAtRaw).toISOString() : null,
      member_id: g('member_id'),
      assigned_to_id: g('assigned_to_id'),
      url: g('url'),
      flagged,
      early_reminder_minutes: earlyMinutes === '' ? null : Number(earlyMinutes),
      image_url: imageUrl || null,
      subtasks: subtasks as unknown as Tables<'family_reminders'>['subtasks'],
      list_id: listId || null,
      tags: finalTags,
    };
    // ── Validation ──
    if (!payload.title) return toastError('Title is required');
    if (payload.title.length > 200) return toastError('Title is too long (max 200 characters)');
    // A brand-new time-based reminder in the past would never fire — block it.
    const timeBased = kind === 'time' || kind === 'medication' || kind === 'bill' || kind === 'school' || kind === 'chore';
    if (!reminder && timeBased && remindAtRaw) {
      if (new Date(remindAtRaw).getTime() < Date.now() - 60_000) {
        return toastError('Pick a time in the future for this reminder.');
      }
    }
    if (kind === 'location' && !payload.location_name) {
      return toastError('Add a location for a location-based reminder.');
    }

    setLoading(true);
    try {
      const supabase = createClient();
      const fullUpdate = { ...payload, updated_at: new Date().toISOString() };
      const fullInsert = { ...payload, family_id: familyId, created_by: userId };
      const run = (uStrip: typeof fullUpdate, iStrip: typeof fullInsert) => reminder
        ? supabase.from('family_reminders').update(uStrip).eq('id', reminder.id)
        : supabase.from('family_reminders').insert(iStrip);

      let { error } = await run(fullUpdate, fullInsert);
      // Forward-compatible: before migration 0100 the new columns don't exist —
      // retry with only the legacy fields so the core reminder still saves (the
      // extra fields light up once 0100 lands).
      if (error && isMissingRelationError(error)) {
        ({ error } = await run(stripNewCols(fullUpdate), stripNewCols(fullInsert)));
      }
      if (error) { toastError(describeDbError(error)); return; }
      success(reminder ? 'Reminder updated' : 'Reminder created');
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={reminder ? 'Edit Reminder' : 'New Reminder'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('reminders.title')} required>
          {(id) => <Input id={id} name="title" defaultValue={reminder?.title ?? ''} placeholder={tr('reminders.pickUpPrescriptionPayCreditCard')} autoFocus />}
        </Field>

        <Field label={tr('reminders.type')}>
          {() => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {KINDS.map((k) => (
                <button key={k.id} type="button" onClick={() => setKind(k.id)}
                  className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition',
                    kind === k.id ? 'border-brand/60 bg-brand/10' : 'border-border hover:bg-elevated')}>
                  <k.icon className={cn('h-3.5 w-3.5', kind === k.id ? 'text-brand-text' : k.color)} />
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('reminders.priority')}>
            {(id) => (
              <select id={id} name="priority" defaultValue={reminder?.priority ?? 'medium'}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          </Field>
          <Field label={tr('reminders.repeat')}>
            {(id) => (
              <select id={id} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {RECURRENCES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        {(kind === 'time' || kind === 'medication' || kind === 'bill' || kind === 'school' || kind === 'chore') && (
          <Field label={tr('reminders.dateTime')}>
            {(id) => <Input id={id} name="remind_at" type="datetime-local"
              defaultValue={reminder?.remind_at ? reminder.remind_at.slice(0, 16) : ''} />}
          </Field>
        )}

        {kind === 'location' && (
          <Field label={tr('reminders.location')}>
            {(id) => <Input id={id} name="location_name" defaultValue={reminder?.location_name ?? ''} placeholder={tr('reminders.pharmacySchoolGroceryStore')} />}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('reminders.assignToMember')}>
            {(id) => (
              <select id={id} name="member_id" defaultValue={reminder?.member_id ?? ''}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">{tr('reminders.wholeFamily')}</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            )}
          </Field>
          <Field label={tr('reminders.assignedToUser')}>
            {(id) => (
              <select id={id} name="assigned_to_id" defaultValue={reminder?.assigned_to_id ?? ''}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">{tr('reminders.anyone')}</option>
                {members.filter((m) => m.user_id).map((m) => <option key={m.user_id!} value={m.user_id!}>{m.display_name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label={tr('reminders.notes')}>
          {(id) => <Textarea id={id} name="notes" defaultValue={reminder?.notes ?? ''} placeholder={tr('reminders.additionalContextOrInstructions')} className="min-h-[80px]" />}
        </Field>

        <Field label="URL">
          {(id) => <Input id={id} name="url" type="url" defaultValue={reminder?.url ?? ''} placeholder="https://…" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr('reminders.list')}>
            {(id) => (
              <select id={id} value={listId}
                onChange={(e) => { if (e.target.value === '__new__') void createList(); else setListId(e.target.value); }}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">{tr('reminders.noList')}</option>
                {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                <option value="__new__">{tr('reminders.newList')}</option>
              </select>
            )}
          </Field>
          <Field label={tr('reminders.earlyReminder')}>
            {(id) => (
              <select id={id} value={earlyMinutes} onChange={(e) => setEarlyMinutes(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {EARLY_REMINDER_OPTIONS.map((o) => <option key={String(o.minutes)} value={o.minutes ?? ''}>{o.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        <button type="button" onClick={() => setFlagged((f) => !f)}
          className="flex w-full items-center justify-between rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-sm">
          <span className="flex items-center gap-2"><Flag className={cn('h-4 w-4', flagged ? 'text-warning' : 'text-muted')} /> {tr('reminders.flag')}</span>
          <span className={cn('relative h-6 w-10 rounded-full transition', flagged ? 'bg-warning' : 'bg-border')}>
            <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition', flagged ? 'left-[18px]' : 'left-0.5')} />
          </span>
        </button>

        {/* Tags */}
        <Field label={tr('reminders.tags')}>
          {(id) => (
            <div>
              {tags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs text-brand-text">
                      <Tag className="h-3 w-3" />{t}
                      <button type="button" onClick={() => setTags((cur) => cur.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
              )}
              <Input id={id} value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTags(); } }}
                onBlur={() => commitTags()}
                placeholder={tr('reminders.addTagsCommaSeparated')} />
            </div>
          )}
        </Field>

        {/* Subtasks */}
        <Field label={`Subtasks${subtasks.length ? ` · ${subtaskProgress(subtasks).done}/${subtaskProgress(subtasks).total}` : ''}`}>
          {(id) => (
            <div className="space-y-1.5">
              {subtasks.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
                  <button type="button" onClick={() => setSubtasks((cur) => cur.map((x) => x.id === s.id ? { ...x, done: !x.done } : x))}
                    className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border', s.done ? 'border-success bg-success text-white' : 'border-border')} aria-label={tr('reminders.toggleSubtask')}>
                    {s.done && <Check className="h-3 w-3" />}
                  </button>
                  <span className={cn('flex-1 text-sm', s.done && 'text-muted line-through')}>{s.title}</span>
                  <button type="button" onClick={() => setSubtasks((cur) => cur.filter((x) => x.id !== s.id))} aria-label={tr('reminders.removeSubtask')} className="text-muted hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <div className="flex gap-2">
                <Input id={id} value={subtaskInput} onChange={(e) => setSubtaskInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                  placeholder={tr('reminders.addASubtask')} />
                <Button type="button" variant="outline" onClick={addSubtask}><Plus className="h-4 w-4" /></Button>
              </div>
            </div>
          )}
        </Field>

        {/* Image */}
        <Field label={tr('reminders.image')}>
          {() => (
            <div className="flex items-center gap-3">
              {imageUrl
                ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <div className="relative"><img src={imageUrl} alt={tr('reminders.reminder')} className="h-16 w-16 rounded-lg object-cover" />
                    <button type="button" onClick={() => setImageUrl('')} aria-label={tr('reminders.removeImage')} className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-danger text-white"><X className="h-3 w-3" /></button>
                  </div>
                )
                : <div className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-border text-muted"><ImageIcon className="h-5 w-5" /></div>}
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                {uploading ? 'Uploading…' : imageUrl ? 'Replace' : 'Add Image'}
                <input type="file" accept="image/*" className="hidden" disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }} />
              </label>
            </div>
          )}
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('reminders.cancel')}</Button>
          <Button type="submit" loading={loading}>{reminder ? 'Save' : 'Create Reminder'}</Button>
        </div>
      </form>
    </Modal>
  );
}
