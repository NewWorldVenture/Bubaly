'use client';

import { useState } from 'react';
import { StickyNote, Plus, Trash2, Pin, PinOff } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Note = Tables<'notes'>;

export function NotesModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Note>({
    table: 'notes',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('notes').select('*').eq('family_id', familyId)
        .order('is_pinned', { ascending: false }).order('updated_at', { ascending: false }),
  });

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('notes').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Note deleted');
    void refresh();
  }

  async function togglePin(note: Note) {
    const supabase = createClient();
    const { error } = await supabase.from('notes').update({ is_pinned: !note.is_pinned }).eq('id', note.id);
    if (error) return toastError(error.message);
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const pinned = data.filter((n) => n.is_pinned);
  const rest = data.filter((n) => !n.is_pinned);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notes"
        description="Shared family notes, lists, and reminders."
        action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New note</Button>}
      />

      {data.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet" description="Create shared notes, grocery reminders, or family announcements."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New note</Button>} />
      ) : (
        <>
          {pinned.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-muted">Pinned</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pinned.map((n) => <NoteCard key={n.id} note={n} onEdit={() => setEditing(n)} onDelete={remove} onTogglePin={togglePin} />)}
              </div>
            </div>
          )}
          {rest.length > 0 && (
            <div>
              {pinned.length > 0 && <h2 className="mb-2 text-sm font-semibold text-muted">Notes</h2>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rest.map((n) => <NoteCard key={n.id} note={n} onEdit={() => setEditing(n)} onDelete={remove} onTogglePin={togglePin} />)}
              </div>
            </div>
          )}
        </>
      )}

      {(open || editing) && (
        <NoteModal
          note={editing}
          familyId={familyId}
          userId={userId}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSaved={() => { setOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function NoteCard({ note, onEdit, onDelete, onTogglePin }: {
  note: Note;
  onEdit: () => void;
  onDelete: (id: string) => void;
  onTogglePin: (n: Note) => void;
}) {
  return (
    <div
      className={cn(
        'glass-card flex flex-col gap-2 p-4 cursor-pointer hover:-translate-y-0.5 transition',
        note.is_pinned && 'border-brand/40',
      )}
      onClick={onEdit}
    >
      {note.title && <p className="truncate text-sm font-semibold">{note.title}</p>}
      <p className="line-clamp-4 text-sm text-muted">{note.body}</p>
      <div className="mt-auto flex items-center justify-between pt-2">
        <span className="text-xs text-muted">{fmtRelative(note.updated_at)}</span>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onTogglePin(note)} className="rounded-lg p-1.5 text-muted hover:text-brand" aria-label="Pin">
            {note.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => onDelete(note.id)} className="rounded-lg p-1.5 text-muted hover:text-danger" aria-label="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function NoteModal({ note, familyId, userId, onClose, onSaved }: {
  note: Note | null; familyId: string; userId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = String(form.get('body') ?? '').trim();
    if (!body) return toastError('Note body is required');
    setLoading(true);
    const supabase = createClient();
    const payload = {
      title: String(form.get('title') ?? '').trim() || null,
      body,
    };
    const { error } = note
      ? await supabase.from('notes').update(payload).eq('id', note.id)
      : await supabase.from('notes').insert({ family_id: familyId, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(error.message);
    success(note ? 'Note saved' : 'Note created');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={note ? 'Edit note' : 'New note'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title (optional)">
          {(id) => <Input id={id} name="title" defaultValue={note?.title ?? ''} placeholder="Shopping list, family update…" autoFocus />}
        </Field>
        <Field label="Body" required>
          {(id) => <Textarea id={id} name="body" defaultValue={note?.body ?? ''} placeholder="Write anything…" className="min-h-[10rem]" />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{note ? 'Save' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
