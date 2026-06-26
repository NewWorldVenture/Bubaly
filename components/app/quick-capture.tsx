'use client';

import { useMemo, useState } from 'react';
import { Plus, CheckSquare, StickyNote, CalendarPlus, ShoppingCart, X, CalendarClock, Sparkles } from 'lucide-react';
import { useApp } from './app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { parseEvent, parseDueDate, suggestKind } from '@/lib/capture/parse';

/** Human "when" label for the live event preview, e.g. "Tomorrow at 3:00 PM". */
function formatWhen(startsAt: Date, allDay: boolean): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(startsAt); day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((day.getTime() - today.getTime()) / 86400000);
  const dayLabel = diffDays === 0 ? 'Today'
    : diffDays === 1 ? 'Tomorrow'
    : startsAt.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (allDay) return dayLabel;
  const time = startsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel} at ${time}`;
}

type CaptureType = 'task' | 'note' | 'event' | 'shopping';

const TYPES: { key: CaptureType; label: string; icon: typeof Plus; placeholder: string }[] = [
  { key: 'task', label: 'Task', icon: CheckSquare, placeholder: 'e.g. Pack lunches' },
  { key: 'note', label: 'Note', icon: StickyNote, placeholder: 'Jot something down…' },
  { key: 'event', label: 'Event', icon: CalendarPlus, placeholder: 'e.g. Dentist at 3pm' },
  { key: 'shopping', label: 'Shopping', icon: ShoppingCart, placeholder: 'e.g. Milk' },
];

/** Get-or-create the family's default list for a list-backed table. */
async function defaultTodoListId(supabase: ReturnType<typeof createClient>, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('todo_lists').select('id').eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('todo_lists').insert({ family_id: familyId, name: 'To-Do', created_by: userId }).select('id').maybeSingle();
  return created?.id ?? null;
}

async function defaultGroceryListId(supabase: ReturnType<typeof createClient>, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('grocery_lists').select('id').eq('family_id', familyId).eq('is_archived', false).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: 'Shopping List', created_by: userId }).select('id').maybeSingle();
  return created?.id ?? null;
}

export function QuickCapture() {
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CaptureType>('task');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() { setText(''); setType('task'); }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    setSaving(true);
    const supabase = createClient();
    try {
      if (type === 'note') {
        const { error } = await supabase.from('notes').insert({ family_id: familyId, body: value, created_by: userId });
        if (error) throw error;
      } else if (type === 'event') {
        const parsed = parseEvent(value);
        const { error } = await supabase.from('calendar_events').insert({
          family_id: familyId, title: parsed.title, starts_at: parsed.startsAt.toISOString(),
          all_day: parsed.allDay, category: 'general', created_by: userId,
        });
        if (error) throw error;
      } else if (type === 'task') {
        const listId = await defaultTodoListId(supabase, familyId, userId);
        if (!listId) throw new Error('Could not find a to-do list');
        const { title, dueDate } = parseDueDate(value);
        const { error } = await supabase.from('todo_items').insert({
          family_id: familyId, list_id: listId, title, due_date: dueDate, created_by: userId,
          assigned_to_id: selfMember?.id ?? null,
        });
        if (error) throw error;
      } else {
        const listId = await defaultGroceryListId(supabase, familyId, userId);
        if (!listId) throw new Error('Could not find a grocery list');
        const { error } = await supabase.from('grocery_items').insert({ family_id: familyId, list_id: listId, name: value, created_by: userId });
        if (error) throw error;
      }
      success(`${TYPES.find((t) => t.key === type)!.label} saved`);
      reset();
      setOpen(false);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const active = TYPES.find((t) => t.key === type)!;
  // Live "when" preview for events — parses "tomorrow at 3pm" as you type.
  const eventPreview = useMemo(() => {
    if (type !== 'event' || !text.trim()) return null;
    return parseEvent(text);
  }, [type, text]);

  // Live due-date preview for tasks — "Pay rent friday" → Due Fri, Jul 3.
  const taskPreview = useMemo(() => {
    if (type !== 'task' || !text.trim()) return null;
    const { title, dueDate } = parseDueDate(text);
    if (!dueDate) return null;
    const [y, m, d] = dueDate.split('-').map(Number);
    return { title, when: formatWhen(new Date(y, m - 1, d), true) };
  }, [type, text]);

  // Non-disruptive type suggestion: offer a one-tap switch when the text looks
  // like a different kind than the one selected. The user taps to apply, so it
  // never hijacks focus or the cursor mid-typing.
  const suggested = useMemo(() => {
    const v = text.trim();
    if (v.length < 3) return null;
    const guess = suggestKind(v);
    return guess === type ? null : guess;
  }, [text, type]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Quick capture"
        className="fixed bottom-20 right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-brand text-white shadow-glow transition hover:brightness-110 active:scale-95 lg:bottom-6 lg:right-6"
      >
        <Plus className="h-7 w-7" />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Quick capture">
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setType(t.key)}
                className={cn('flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-xs font-medium transition',
                  type === t.key ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted hover:bg-elevated')}
              >
                <t.icon className="h-5 w-5" />
                {t.label}
              </button>
            ))}
          </div>

          {suggested && (
            <button
              type="button"
              onClick={() => setType(suggested)}
              className="flex w-full items-center gap-1.5 rounded-lg bg-brand/5 px-3 py-2 text-left text-xs text-brand transition hover:bg-brand/10"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>Looks like a <span className="font-semibold">{TYPES.find((t) => t.key === suggested)!.label.toLowerCase()}</span> — tap to switch.</span>
            </button>
          )}

          <Field label={active.label}>
            {(id) => type === 'note'
              ? <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={active.placeholder} autoFocus />
              : <Input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder={active.placeholder} autoFocus />}
          </Field>

          {type === 'task' && taskPreview && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-brand">
              <CalendarClock className="h-3.5 w-3.5" />
              Due {taskPreview.when}
              {taskPreview.title && taskPreview.title !== text.trim() && (
                <span className="text-muted">· “{taskPreview.title}”</span>
              )}
            </p>
          )}

          {type === 'event' && (
            eventPreview?.matched ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-brand">
                <CalendarClock className="h-3.5 w-3.5" />
                {formatWhen(eventPreview.startsAt, eventPreview.allDay)}
                {eventPreview.title && eventPreview.title !== text.trim() && (
                  <span className="text-muted">· “{eventPreview.title}”</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted">Tip: add a time like “tomorrow at 3pm” and we’ll schedule it.</p>
            )
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /> Cancel</Button>
            <Button type="submit" loading={saving}><Plus className="h-4 w-4" /> Save</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
