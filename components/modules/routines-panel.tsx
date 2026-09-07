'use client';

// Recurring-routine templates (Friction #10) — the "Moments" home for detected
// routines, surfaced in the calendar right rail. Detects repeating events from
// history and lets a family save them as reusable routines, then apply a
// routine to a week (materializing concrete calendar_events). 100% Supabase.

import { useMemo, useRef, useState } from 'react';
import { Plus, Sparkles, Repeat, Trash2, Pencil, Loader2, X, Wand2, CalendarPlus } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { applyRoutineToCalendarAction, undoCalendarEventsAction } from '@/app/(app)/dashboard/calendar/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import {
  detectRoutines, materializeRoutine, weekdayMaskLabel, weekdaysInMask,
  hasWeekday, toggleWeekday, minutesToLabel, weekdayLong,
  WEEKDAYS_WEEKDAYS, type RoutineEventInput, type EventCategory,
} from '@/lib/routines/detect';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Template = Tables<'routine_templates'>;
type Item = Tables<'routine_template_items'>;

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const CATEGORIES: EventCategory[] = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];
const CATEGORY_EMOJI: Record<string, string> = {
  general: '📌', school: '🏫', sports: '🏀', appointment: '🩺', medication: '💊',
  maintenance: '🔧', birthday: '🎂', holiday: '🎉', other: '📎',
};
const ROUTINE_ICONS = ['🔁', '☀️', '🌙', '🏫', '🏀', '🍽️', '🛏️', '📚', '🧹', '🚗'];

function minutesToTimeValue(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function timeValueToMinutes(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

type DraftItem = { title: string; category: EventCategory; start: string; duration: number; assignee_id: string };

export function RoutinesPanel({ events, weekStartMonday, onApplied }: {
  events: RoutineEventInput[];
  weekStartMonday: Date;
  onApplied: () => void;
}) {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });
  const [editing, setEditing] = useState<{ template: Template; items: Item[] } | null>(null);
  const [creating, setCreating] = useState(false);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: templates, loading: templatesLoading, error: templatesError, refresh: refreshTemplates } = useRealtimeQuery<Template>({
    table: 'routine_templates', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('routine_templates').select('*').eq('family_id', familyId).order('created_at'),
  });
  const { data: items, loading: itemsLoading, error: itemsError, refresh: refreshItems } = useRealtimeQuery<Item>({
    table: 'routine_template_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('routine_template_items').select('*').eq('family_id', familyId).order('sort_order').order('start_minutes'),
  });

  const itemsByTemplate = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) { if (!m.has(it.template_id)) m.set(it.template_id, []); m.get(it.template_id)!.push(it); }
    return m;
  }, [items]);

  const loading = templatesLoading || itemsLoading;
  const error = templatesError || itemsError;

  // Detected routines the family hasn't already saved (dedupe by title+weekday).
  const savedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const t of templates) for (const it of itemsByTemplate.get(t.id) ?? [])
      for (const w of weekdaysInMask(t.weekday_mask)) set.add(`${it.title.toLowerCase().trim()}|${w}`);
    return set;
  }, [templates, itemsByTemplate]);

  const suggestions = useMemo(() => {
    const found = detectRoutines(events, { minOccurrences: 3, limit: 8 });
    return found.filter((s) => !savedKeys.has(`${s.title.toLowerCase().trim()}|${s.weekday}`)).slice(0, 3);
  }, [events, savedKeys]);

  function refreshAll() { void refreshTemplates(); void refreshItems(); }

  function saveSuggestion(sig: string) {
    const s = suggestions.find((x) => x.signature === sig);
    if (!s) return;
    return run(`save:${sig}`, async () => {
      const sb = createClient();
      const { data: tpl, error } = await sb.from('routine_templates').insert({
        family_id: familyId, name: s.title, icon: CATEGORY_EMOJI[s.category] ?? '🔁',
        weekday_mask: 1 << s.weekday, source: 'detected', created_by: userId,
      }).select('id').single();
      if (error || !tpl) throw error ?? new Error('Could not save');
      const { error: e2 } = await sb.from('routine_template_items').insert({
        template_id: tpl.id, family_id: familyId, title: s.title, category: s.category,
        start_minutes: s.startMinutes, duration_minutes: s.durationMinutes, assignee_id: s.assigneeId, sort_order: 0,
      });
      if (e2) throw e2;
      success('Routine saved');
      refreshAll();
    });
  }

  // One submission id per (routine, week) — the composition a family means when
  // they say "put this routine on this week". Dropped on undo, so changing their
  // mind and applying again is a new composition rather than being answered with
  // events that no longer exist.
  const applyIds = useRef<Record<string, string>>({});

  if (loading) return <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted">{tr('routines.loadingRoutines')}</div>;
  if (error) return <ErrorState message={tr('routinesPanel.couldNotLoadRoutinesRefresh')} onRetry={refreshAll} />;

  function applyTemplate(t: Template) {
    const its = itemsByTemplate.get(t.id) ?? [];
    if (its.length === 0) { toastError('Add a step to this routine first.'); return; }
    return run(`apply:${t.id}`, async () => {
      const rows = materializeRoutine(
        { weekday_mask: t.weekday_mask, items: its.map((i) => ({ title: i.title, category: i.category, start_minutes: i.start_minutes, duration_minutes: i.duration_minutes, assignee_id: i.assignee_id })) },
        weekStartMonday, 1,
      );
      if (rows.length === 0) { toastError('This routine has no active days.'); return; }
      // One write, and one composition. Applying this routine to this week twice
      // used to add the week twice; the batch carries a key derived from the id
      // below, so the second Apply is answered with the events the first created.
      const key = `${t.id}:${weekStartMonday.toISOString().slice(0, 10)}`;
      const result = await applyRoutineToCalendarAction({
        events: rows.map((r) => ({
          title: r.title,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          category: r.category,
          assigneeId: r.assignee_id,
        })),
        submissionId: (applyIds.current[key] ||= newSubmissionId()),
      });
      if (!result.ok) { toastError(result.error); return; }

      const ids = result.eventIds;
      success(`Added ${ids.length} events for this week`, {
        label: 'Undo',
        onClick: () => {
          void undoCalendarEventsAction(ids).then((undone) => {
            if (!undone.ok) { toastError(undone.error); return; }
            // Undo means the family changed their mind, so the next Apply of this
            // routine and week is a NEW composition — otherwise the batch key
            // would answer it with events that no longer exist.
            delete applyIds.current[key];
            success('Undone');
            onApplied();
          });
        },
      });
      onApplied();
    });
  }

  function deleteTemplate(t: Template) {
    if (!confirm(`Delete the "${t.name}" routine? (Events already added to your calendar stay.)`)) return;
    return run(`del:${t.id}`, async () => {
      const { error } = await createClient().from('routine_templates').delete().eq('id', t.id);
      if (error) throw error;
      success('Routine deleted');
      refreshAll();
    });
  }

  return (
    <div className="sidebar-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-bold"><Repeat className="h-4 w-4 text-brand-text" /> {tr('routines.routines')}</h3>
        <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-[11px] font-medium text-brand-text hover:underline">
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      </div>

      {/* Detected suggestions */}
      {suggestions.length > 0 && (
        <div className="mb-3 space-y-2">
          {suggestions.map((s) => (
            <div key={s.signature} className="rounded-xl border border-brand/30 bg-brand/5 p-2.5">
              <div className="flex items-start gap-2">
                <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-text" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">{s.title}</p>
                  <p className="text-[10px] text-muted">
                    {weekdayLong(s.weekday)}{tr('routines.sAt')} {minutesToLabel(s.startMinutes)} {tr('routines.seen')} {s.occurrences}×
                  </p>
                </div>
              </div>
              <button
                onClick={() => saveSuggestion(s.signature)}
                disabled={isPending(`save:${s.signature}`)}
                className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg bg-brand py-1.5 text-[11px] font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-60"
              >
                {isPending(`save:${s.signature}`) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} {tr('routines.saveAsRoutine')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Saved routines */}
      {templates.length === 0 ? (
        suggestions.length === 0 && (
          <p className="text-xs text-muted">{tr('routines.noRoutinesYetCreateOneOr')}</p>
        )
      ) : (
        <div className="space-y-1.5">
          {templates.map((t) => {
            const its = itemsByTemplate.get(t.id) ?? [];
            return (
              <div key={t.id} className="group rounded-xl border border-border bg-surface/40 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated text-base">{t.icon ?? '🔁'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold">{t.name}</p>
                    <p className="text-[10px] text-muted">{weekdayMaskLabel(t.weekday_mask)} · {its.length} step{its.length === 1 ? '' : 's'}</p>
                  </div>
                  <button onClick={() => setEditing({ template: t, items: its })} aria-label={tr('routines.editRoutine')}
                    className="rounded p-1 text-muted opacity-0 transition hover:text-fg group-hover:opacity-100"><Pencil className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteTemplate(t)} disabled={isPending(`del:${t.id}`)} aria-label={tr('routines.deleteRoutine')}
                    className="rounded p-1 text-muted opacity-0 transition hover:text-danger group-hover:opacity-100">
                    {isPending(`del:${t.id}`) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <button
                  onClick={() => applyTemplate(t)}
                  disabled={isPending(`apply:${t.id}`) || its.length === 0}
                  className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-border py-1.5 text-[11px] font-semibold transition hover:bg-elevated disabled:opacity-50"
                >
                  {isPending(`apply:${t.id}`) ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarPlus className="h-3 w-3" />} {tr('routines.applyToThisWeek')}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <RoutineEditor
          familyId={familyId} userId={userId} members={members} memberById={memberById}
          template={editing?.template} initialItems={editing?.items}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refreshAll(); }}
        />
      )}
    </div>
  );
}

function RoutineEditor({ familyId, userId, members, template, initialItems, onClose, onSaved }: {
  familyId: string; userId: string;
  members: ReturnType<typeof useApp>['members'];
  memberById: Map<string, ReturnType<typeof useApp>['members'][number]>;
  template?: Template; initialItems?: Item[];
  onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(template?.name ?? '');
  const [icon, setIcon] = useState(template?.icon ?? '🔁');
  const [mask, setMask] = useState(template?.weekday_mask ?? WEEKDAYS_WEEKDAYS);
  const [rows, setRows] = useState<DraftItem[]>(
    initialItems && initialItems.length
      ? initialItems.map((i) => ({ title: i.title, category: i.category, start: minutesToTimeValue(i.start_minutes), duration: i.duration_minutes, assignee_id: i.assignee_id ?? '' }))
      : [{ title: '', category: 'general', start: '07:00', duration: 30, assignee_id: '' }],
  );

  function addRow() { setRows((r) => [...r, { title: '', category: 'general', start: '08:00', duration: 30, assignee_id: '' }]); }
  function removeRow(i: number) { setRows((r) => r.filter((_, idx) => idx !== i)); }
  function patchRow(i: number, patch: Partial<DraftItem>) { setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row))); }

  async function save() {
    const cleanName = name.trim();
    if (!cleanName) { toastError('Name your routine'); return; }
    const steps = rows.filter((r) => r.title.trim());
    if (steps.length === 0) { toastError('Add at least one step'); return; }
    if (mask === 0) { toastError('Pick at least one day'); return; }
    setSaving(true);
    try {
      const sb = createClient();
      let templateId = template?.id;
      if (templateId) {
        const { error } = await sb.from('routine_templates').update({ name: cleanName, icon, weekday_mask: mask }).eq('id', templateId);
        if (error) throw error;
        // Replace items wholesale (simple + correct for a small list). If the
        // delete fails we must NOT insert or the template keeps the old steps
        // alongside the new ones (duplicates).
        const { error: delErr } = await sb.from('routine_template_items').delete().eq('template_id', templateId);
        if (delErr) throw delErr;
      } else {
        const { data, error } = await sb.from('routine_templates').insert({
          family_id: familyId, name: cleanName, icon, weekday_mask: mask, source: 'manual', created_by: userId,
        }).select('id').single();
        if (error || !data) throw error ?? new Error('Could not create');
        templateId = data.id;
      }
      const { error: e2 } = await sb.from('routine_template_items').insert(
        steps.map((r, idx) => ({
          template_id: templateId!, family_id: familyId, title: r.title.trim(), category: r.category,
          start_minutes: timeValueToMinutes(r.start), duration_minutes: Number(r.duration) || 30,
          assignee_id: r.assignee_id || null, sort_order: idx,
        })),
      );
      if (e2) throw e2;
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title={template ? 'Edit routine' : 'New routine'} onClose={onClose}>
      <div className="space-y-4">
        <Field label={tr('routines.name')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('routines.schoolMorning')} autoFocus />}
        </Field>

        <div>
          <p className="mb-1 text-sm font-medium">{tr('routines.icon')}</p>
          <div className="flex flex-wrap gap-1.5">
            {ROUTINE_ICONS.map((e) => (
              <button key={e} type="button" onClick={() => setIcon(e)}
                className={cn('rounded-lg p-1.5 text-lg transition hover:bg-elevated', icon === e && 'bg-brand/15 ring-2 ring-brand/40')}>{e}</button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-sm font-medium">{tr('routines.repeatsOn')}</p>
          <div className="flex gap-1">
            {WEEKDAY_INITIALS.map((d, w) => (
              <button key={w} type="button" onClick={() => setMask((m) => toggleWeekday(m, w))}
                className={cn('h-8 w-8 rounded-full text-xs font-semibold transition',
                  hasWeekday(mask, w) ? 'bg-brand text-brand-fg' : 'bg-elevated text-muted hover:text-fg')}>{d}</button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">{weekdayMaskLabel(mask)}</p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-medium">{tr('routines.steps')}</p>
            <button type="button" onClick={addRow} className="flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"><Plus className="h-3.5 w-3.5" /> {tr('routines.addStep')}</button>
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="rounded-xl border border-border bg-surface/40 p-2">
                <div className="flex items-center gap-2">
                  <Input value={r.title} onChange={(e) => patchRow(i, { title: e.target.value })} placeholder={tr('routines.eGBreakfast')} className="flex-1" />
                  {rows.length > 1 && (
                    <button type="button" onClick={() => removeRow(i)} aria-label={tr('routines.removeStep')} className="rounded p-1 text-muted hover:text-danger"><X className="h-4 w-4" /></button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <Input type="time" value={r.start} onChange={(e) => patchRow(i, { start: e.target.value })} aria-label={tr('routines.startTime')} />
                  <Input type="number" min={5} step={5} value={r.duration} onChange={(e) => patchRow(i, { duration: Number(e.target.value) })} aria-label={tr('routines.minutes')} />
                  <Select value={r.category} onChange={(e) => patchRow(i, { category: e.target.value as EventCategory })} aria-label={tr('routines.category')}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_EMOJI[c]} {c[0].toUpperCase() + c.slice(1)}</option>)}
                  </Select>
                </div>
                <Select value={r.assignee_id} onChange={(e) => patchRow(i, { assignee_id: e.target.value })} aria-label={tr('routines.assignTo')} className="mt-2">
                  <option value="">{tr('routines.wholeFamily')}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('routines.cancel')}</Button>
          <Button type="button" loading={saving} onClick={save}>{template ? 'Save routine' : 'Create routine'}</Button>
        </div>
      </div>
    </Modal>
  );
}
