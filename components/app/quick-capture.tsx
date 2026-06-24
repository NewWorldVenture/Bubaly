'use client';

import { useState } from 'react';
import { Plus, CheckSquare, StickyNote, CalendarPlus, ShoppingCart, X } from 'lucide-react';
import { useApp } from './app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

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
        const { error } = await supabase.from('calendar_events').insert({
          family_id: familyId, title: value, starts_at: new Date().toISOString(), category: 'general', created_by: userId,
        });
        if (error) throw error;
      } else if (type === 'task') {
        const listId = await defaultTodoListId(supabase, familyId, userId);
        if (!listId) throw new Error('Could not find a to-do list');
        const { error } = await supabase.from('todo_items').insert({
          family_id: familyId, list_id: listId, title: value, created_by: userId,
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

          <Field label={active.label}>
            {(id) => type === 'note'
              ? <Textarea id={id} value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={active.placeholder} autoFocus />
              : <Input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder={active.placeholder} autoFocus />}
          </Field>

          {type === 'event' && <p className="text-xs text-muted">Starts now — adjust the time later in Calendar.</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /> Cancel</Button>
            <Button type="submit" loading={saving}><Plus className="h-4 w-4" /> Save</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
