'use client';

import { useMemo, useState } from 'react';
import {
  Bell, Plus, Check, Clock, MapPin, Repeat, Pill, CreditCard,
  GraduationCap, CheckSquare, Trash2, Edit2, Sparkles, X,
  AlertTriangle, Calendar, User, AlarmClock, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { fmtDate, fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Reminder = Tables<'family_reminders'>;

const KINDS = [
  { id: 'time', label: 'Time-based', icon: Clock, color: 'text-brand' },
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
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });

  const [tab, setTab] = useState<'active' | 'completed' | 'all'>('active');
  const [filterKind, setFilterKind] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data: reminders, loading, error, refresh } = useRealtimeQuery<Reminder>({
    table: 'family_reminders', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('family_reminders').select('*').eq('family_id', familyId)
        .order('status', { ascending: true })
        .order('remind_at', { ascending: true, nullsFirst: false }),
  });

  const filtered = useMemo(() => {
    let rows = reminders;
    if (tab === 'active') rows = rows.filter((r) => r.status === 'active' || r.status === 'snoozed');
    if (tab === 'completed') rows = rows.filter((r) => r.status === 'completed' || r.status === 'dismissed');
    if (filterKind !== 'all') rows = rows.filter((r) => r.kind === filterKind);
    return rows;
  }, [reminders, tab, filterKind]);

  const overdue = reminders.filter(isOverdue);
  const activeCount = reminders.filter((r) => r.status === 'active').length;

  function complete(id: string) {
    return run(`complete:${id}`, async () => {
      const { error } = await createClient().from('family_reminders')
        .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      success('Reminder completed ✓');
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

  if (loading) return <SkeletonList />;
  if (error) return <div className="p-4 text-danger text-sm">{error}</div>;

  return (
    <div className="module-page">
      <PageHeader
        title="Smart Reminders"
        description="Never let anything slip through the cracks."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="reminders" iconOnly />
            <Button variant="outline" onClick={() => setShowSuggestions(!showSuggestions)}>
              <Sparkles className="h-4 w-4 text-brand" /> Quick Add
            </Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> New Reminder</Button>
          </div>
        }
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Active', value: activeCount, icon: Bell, color: 'text-brand' },
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
            <p className="text-sm font-bold text-danger">{overdue.length} overdue reminder{overdue.length > 1 ? 's' : ''}</p>
            <p className="text-xs text-muted">{overdue.map((r) => r.title).join(', ')}</p>
          </div>
        </div>
      )}

      {/* AI Suggestions panel */}
      {showSuggestions && (
        <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand" /> Common Reminders
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
                    ? <Loader2 className="ml-auto h-4 w-4 flex-shrink-0 animate-spin text-brand" />
                    : <Plus className="ml-auto h-4 w-4 flex-shrink-0 text-brand" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center justify-between">
        <div className="tab-bar">
          {(['active', 'completed', 'all'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('tab-item capitalize', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>
              {t}
            </button>
          ))}
        </div>
        {/* Kind filter */}
        <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)}
          className="rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs text-muted focus:outline-none">
          <option value="all">All types</option>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </div>

      {/* Reminder list */}
      {filtered.length === 0 ? (
        <EmptyState icon={Bell} title="No reminders"
          description="Set time-based, location, medication, or recurring reminders for your family."
          action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Reminder</Button>} />
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
                <button onClick={() => !completed && complete(reminder.id)} disabled={completed || isPending(`complete:${reminder.id}`)}
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
                    {snoozed && <Badge tone="warning">Snoozed</Badge>}
                    {overdue && !completed && <Badge tone="danger">Overdue</Badge>}
                    {reminder.ai_suggested && (
                      <span className="flex items-center gap-0.5 text-[10px] text-brand/70">
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
                  </div>
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
                  <button onClick={() => setEditing(reminder)} aria-label="Edit reminder"
                    className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => deleteReminder(reminder.id)} disabled={isPending(`delete:${reminder.id}`)} aria-label="Delete reminder"
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
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function ReminderModal({ reminder, familyId, userId, members, onClose, onSaved }: {
  reminder: Reminder | null;
  familyId: string; userId: string;
  members: Tables<'family_members'>[];
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState(reminder?.kind ?? 'time');
  const [recurrence, setRecurrence] = useState(reminder?.recurrence ?? 'none');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const g = (k: string) => String(form.get(k) ?? '').trim() || null;
    const remindAtRaw = g('remind_at');
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
      const { error } = reminder
        ? await supabase.from('family_reminders').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', reminder.id)
        : await supabase.from('family_reminders').insert({ ...payload, family_id: familyId, created_by: userId });
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
        <Field label="Title" required>
          {(id) => <Input id={id} name="title" defaultValue={reminder?.title ?? ''} placeholder="Pick up prescription, Pay credit card…" autoFocus />}
        </Field>

        <Field label="Type">
          {() => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {KINDS.map((k) => (
                <button key={k.id} type="button" onClick={() => setKind(k.id)}
                  className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition',
                    kind === k.id ? 'border-brand/60 bg-brand/10' : 'border-border hover:bg-elevated')}>
                  <k.icon className={cn('h-3.5 w-3.5', kind === k.id ? 'text-brand' : k.color)} />
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority">
            {(id) => (
              <select id={id} name="priority" defaultValue={reminder?.priority ?? 'medium'}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Repeat">
            {(id) => (
              <select id={id} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {RECURRENCES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        {(kind === 'time' || kind === 'medication' || kind === 'bill' || kind === 'school' || kind === 'chore') && (
          <Field label="Date & Time">
            {(id) => <Input id={id} name="remind_at" type="datetime-local"
              defaultValue={reminder?.remind_at ? reminder.remind_at.slice(0, 16) : ''} />}
          </Field>
        )}

        {kind === 'location' && (
          <Field label="Location">
            {(id) => <Input id={id} name="location_name" defaultValue={reminder?.location_name ?? ''} placeholder="Pharmacy, School, Grocery store…" />}
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assign to member">
            {(id) => (
              <select id={id} name="member_id" defaultValue={reminder?.member_id ?? ''}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">Whole family</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Assigned to (user)">
            {(id) => (
              <select id={id} name="assigned_to_id" defaultValue={reminder?.assigned_to_id ?? ''}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                <option value="">Anyone</option>
                {members.filter((m) => m.user_id).map((m) => <option key={m.user_id!} value={m.user_id!}>{m.display_name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(id) => <Textarea id={id} name="notes" defaultValue={reminder?.notes ?? ''} placeholder="Additional context or instructions…" className="min-h-[80px]" />}
        </Field>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{reminder ? 'Save' : 'Create Reminder'}</Button>
        </div>
      </form>
    </Modal>
  );
}
