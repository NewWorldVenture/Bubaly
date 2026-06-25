'use client';

// Enhanced notes: color coding, checklists, categories, grid/list view, search
import { useMemo, useState } from 'react';
import {
  StickyNote, Plus, Trash2, Pin, PinOff, Search, X, Copy, List, LayoutGrid,
  CheckSquare, Square, Palette, Clock, FileText, Sparkles, User,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import { formatInsightsForNote, type NotesInsights } from '@/lib/notes/ai';
import type { Tables } from '@/lib/database.types';

type Note = Tables<'notes'>;

const NOTE_COLORS = [
  { id: 'default', bg: 'bg-surface/40', ring: 'border-border' },
  { id: 'violet', bg: 'bg-violet-500/10', ring: 'border-violet-500/40' },
  { id: 'blue', bg: 'bg-blue-500/10', ring: 'border-blue-500/40' },
  { id: 'teal', bg: 'bg-teal-500/10', ring: 'border-teal-500/40' },
  { id: 'green', bg: 'bg-green-500/10', ring: 'border-green-500/40' },
  { id: 'yellow', bg: 'bg-yellow-400/10', ring: 'border-yellow-400/40' },
  { id: 'orange', bg: 'bg-orange-500/10', ring: 'border-orange-500/40' },
  { id: 'red', bg: 'bg-red-500/10', ring: 'border-red-500/40' },
  { id: 'pink', bg: 'bg-pink-500/10', ring: 'border-pink-500/40' },
] as const;

const COLOR_SWATCHES = [
  { id: 'default', swatch: 'bg-elevated border border-border' },
  { id: 'violet', swatch: 'bg-violet-500' },
  { id: 'blue', swatch: 'bg-blue-500' },
  { id: 'teal', swatch: 'bg-teal-500' },
  { id: 'green', swatch: 'bg-green-500' },
  { id: 'yellow', swatch: 'bg-yellow-400' },
  { id: 'orange', swatch: 'bg-orange-500' },
  { id: 'red', swatch: 'bg-red-500' },
  { id: 'pink', swatch: 'bg-pink-500' },
] as const;

const QUICK_CATEGORIES = [
  { id: 'all', label: 'All Notes', icon: FileText },
  { id: 'pinned', label: 'Pinned', icon: Pin },
];

function noteColor(id: string | null | undefined) {
  return NOTE_COLORS.find((c) => c.id === id) ?? NOTE_COLORS[0];
}

function isChecklist(body: string) {
  return body.split('\n').some((l) => /^\[[ x]\]/i.test(l.trim()));
}

function renderChecklist(body: string) {
  return body.split('\n').map((line, i) => {
    const checked = /^\[x\]/i.test(line.trim());
    const unchecked = /^\[ \]/.test(line.trim());
    if (checked || unchecked) {
      const text = line.trim().replace(/^\[[ x]\]\s*/i, '');
      return (
        <div key={i} className={cn('flex items-start gap-2 py-0.5 text-sm', checked && 'opacity-50')}>
          {checked
            ? <CheckSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-success" />
            : <Square className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted" />}
          <span className={cn(checked && 'line-through text-muted')}>{text}</span>
        </div>
      );
    }
    return <p key={i} className="text-sm leading-relaxed">{line || ' '}</p>;
  });
}

export function NotesModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [activeCategory, setActiveCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [editing, setEditing] = useState<Note | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [viewing, setViewing] = useState<Note | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Note>({
    table: 'notes',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('notes').select('*').eq('family_id', familyId)
        .order('is_pinned', { ascending: false })
        .order('updated_at', { ascending: false }),
  });

  const filtered = useMemo(() => {
    let rows = data;
    if (activeCategory === 'pinned') rows = rows.filter((n) => n.is_pinned);
    if (search) rows = rows.filter((n) =>
      n.title?.toLowerCase().includes(search.toLowerCase()) ||
      n.body?.toLowerCase().includes(search.toLowerCase())
    );
    return rows;
  }, [data, activeCategory, search]);

  const pinned = filtered.filter((n) => n.is_pinned);
  const rest = filtered.filter((n) => !n.is_pinned);

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('notes').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    success('Note deleted');
    void refresh();
    if (viewing?.id === id) setViewing(null);
  }

  async function togglePin(note: Note) {
    const supabase = createClient();
    await supabase.from('notes').update({ is_pinned: !note.is_pinned }).eq('id', note.id);
    void refresh();
    if (viewing?.id === note.id) setViewing({ ...note, is_pinned: !note.is_pinned });
  }

  async function duplicate(note: Note) {
    const supabase = createClient();
    await supabase.from('notes').insert({
      family_id: familyId, created_by: userId,
      title: note.title ? `Copy of ${note.title}` : null,
      body: note.body,
    });
    success('Note duplicated');
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Notes"
        description="Shared family notes, checklists, ideas, and reminders."
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-3 py-2">
              <Search className="h-3.5 w-3.5 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search notes…"
                className="w-28 bg-transparent text-sm placeholder:text-muted outline-none sm:w-40" />
              {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-muted" /></button>}
            </div>
            <button onClick={() => setView(v => v === 'grid' ? 'list' : 'grid')}
              className="rounded-xl border border-border p-2 text-muted hover:bg-elevated hover:text-fg transition">
              {view === 'grid' ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
            </button>
            <AiInsight kind="notes" iconOnly />
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> New Note</Button>
          </div>
        }
      />

      {/* Category tabs */}
      <div className="tab-bar">
        {QUICK_CATEGORIES.map((cat) => (
          <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
            className={cn('tab-item', activeCategory === cat.id ? 'tab-item-active' : 'tab-item-inactive')}>
            <cat.icon className="h-3.5 w-3.5" />
            {cat.label}
            <span className="ml-1 text-xs opacity-70">
              {cat.id === 'all' ? data.length : data.filter((n) => n.is_pinned).length}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet"
          description="Create notes, checklists, meeting minutes, or family announcements."
          action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> New Note</Button>} />
      ) : (
        <div className="space-y-5">
          {pinned.length > 0 && (
            <div>
              <h2 className="mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-muted">
                <Pin className="h-3 w-3" /> Pinned
              </h2>
              <NoteGroup notes={pinned} view={view} onOpen={setViewing} onTogglePin={togglePin} onDelete={remove} onDuplicate={duplicate} />
            </div>
          )}
          {rest.length > 0 && (
            <div>
              {pinned.length > 0 && <h2 className="mb-2.5 text-xs font-bold uppercase tracking-widest text-muted">Notes</h2>}
              <NoteGroup notes={rest} view={view} onOpen={setViewing} onTogglePin={togglePin} onDelete={remove} onDuplicate={duplicate} />
            </div>
          )}
        </div>
      )}

      {/* Note viewer */}
      {viewing && (
        <Modal open onClose={() => setViewing(null)} title="">
          <div className="max-h-[70vh] overflow-y-auto -m-1">
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-1">
                <button onClick={() => togglePin(viewing)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-brand transition">
                  {viewing.is_pinned ? <PinOff className="h-4 w-4 text-brand" /> : <Pin className="h-4 w-4" />}
                </button>
                <button onClick={() => duplicate(viewing)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg transition">
                  <Copy className="h-4 w-4" />
                </button>
                <button onClick={() => { setEditing(viewing); setViewing(null); }}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:bg-elevated hover:text-fg transition">
                  Edit
                </button>
              </div>
              <button onClick={() => { if (confirm('Delete this note?')) remove(viewing.id); }}
                className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger transition">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            {viewing.title && <h2 className="mb-3 text-xl font-bold">{viewing.title}</h2>}
            {viewing.body && isChecklist(viewing.body)
              ? <div className="space-y-0.5">{renderChecklist(viewing.body)}</div>
              : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{viewing.body}</p>}
            <p className="mt-6 text-xs text-muted">Updated {fmtRelative(viewing.updated_at)}</p>
          </div>
        </Modal>
      )}

      {(addOpen || editing) && (
        <NoteModal
          note={editing}
          familyId={familyId}
          userId={userId}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function NoteGroup({ notes, view, onOpen, onTogglePin, onDelete, onDuplicate }: {
  notes: Note[]; view: 'grid' | 'list';
  onOpen: (n: Note) => void;
  onTogglePin: (n: Note) => void;
  onDelete: (id: string) => void;
  onDuplicate: (n: Note) => void;
}) {
  if (view === 'list') {
    return (
      <div className="overflow-hidden rounded-2xl border border-border divide-y divide-border/50">
        {notes.map((note) => {
          const checklist = note.body && isChecklist(note.body);
          const checkCount = checklist ? note.body!.split('\n').filter((l) => /^\[x\]/i.test(l.trim())).length : 0;
          const totalCheck = checklist ? note.body!.split('\n').filter((l) => /^\[[ x]\]/i.test(l.trim())).length : 0;
          return (
            <div key={note.id} onClick={() => onOpen(note)}
              className="group flex cursor-pointer items-center gap-4 px-4 py-3 hover:bg-elevated/30 transition">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {checklist && <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-success" />}
                  <p className="truncate text-sm font-semibold">{note.title ?? 'Untitled'}</p>
                  {note.is_pinned && <Pin className="h-3 w-3 flex-shrink-0 text-brand" />}
                </div>
                <p className="truncate text-xs text-muted">{note.body?.replace(/^\[[ x]\]\s*/gim, '').slice(0, 80)}</p>
              </div>
              {checklist && <span className="text-xs text-success">{checkCount}/{totalCheck}</span>}
              <span className="hidden text-xs text-muted sm:block">{fmtRelative(note.updated_at)}</span>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onTogglePin(note)} className="rounded p-1.5 text-muted hover:text-brand">
                  {note.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => onDuplicate(note)} className="rounded p-1.5 text-muted hover:text-fg"><Copy className="h-3.5 w-3.5" /></button>
                <button onClick={() => { if (confirm('Delete?')) onDelete(note.id); }} className="rounded p-1.5 text-muted hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {notes.map((note) => {
        const color = noteColor((note as Record<string, unknown>).color as string);
        const checklist = note.body && isChecklist(note.body);
        const checkCount = checklist ? note.body!.split('\n').filter((l) => /^\[x\]/i.test(l.trim())).length : 0;
        const totalCheck = checklist ? note.body!.split('\n').filter((l) => /^\[[ x]\]/i.test(l.trim())).length : 0;
        return (
          <div key={note.id} onClick={() => onOpen(note)}
            className={cn(
              'group relative flex min-h-[140px] cursor-pointer flex-col rounded-2xl border-2 p-4 transition hover:-translate-y-0.5',
              color.bg, color.ring,
            )}>
            {note.is_pinned && <Pin className="absolute right-3 top-3 h-3.5 w-3.5 text-brand" />}
            {note.title && <p className="mb-2 pr-5 text-sm font-bold leading-tight">{note.title}</p>}
            {checklist ? (
              <div className="flex-1 space-y-0.5 overflow-hidden">
                {note.body!.split('\n').slice(0, 5).map((line, i) => {
                  const checked = /^\[x\]/i.test(line.trim());
                  const unchecked = /^\[ \]/.test(line.trim());
                  if (!checked && !unchecked) return null;
                  return (
                    <div key={i} className={cn('flex items-center gap-1.5 text-xs', checked && 'opacity-50')}>
                      {checked
                        ? <CheckSquare className="h-3 w-3 text-success flex-shrink-0" />
                        : <Square className="h-3 w-3 text-muted flex-shrink-0" />}
                      <span className={cn('truncate', checked && 'line-through text-muted')}>
                        {line.trim().replace(/^\[[ x]\]\s*/i, '')}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="flex-1 line-clamp-5 text-xs leading-relaxed text-muted">{note.body}</p>
            )}
            <div className="mt-3 flex items-center justify-between border-t border-border/30 pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted">
                {checklist && <span className="text-success">{checkCount}/{totalCheck}</span>}
                <Clock className="h-2.5 w-2.5" />
                {fmtRelative(note.updated_at)}
              </div>
              <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onTogglePin(note)} className="rounded p-1 text-muted hover:text-brand">
                  {note.is_pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </button>
                <button onClick={() => { if (confirm('Delete?')) onDelete(note.id); }} className="rounded p-1 text-muted hover:text-danger">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NoteModal({ note, familyId, userId, onClose, onSaved }: {
  note: Note | null; familyId: string; userId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [selectedColor, setSelectedColor] = useState((note as Record<string, unknown> | null)?.color as string ?? 'default');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [bodyValue, setBodyValue] = useState(note?.body ?? '');
  const [aiLoading, setAiLoading] = useState(false);
  const [insights, setInsights] = useState<NotesInsights | null>(null);

  function insertChecklistItem() {
    setBodyValue((v) => v + (v && !v.endsWith('\n') ? '\n' : '') + '[ ] ');
  }

  async function runAiAssist() {
    const content = bodyValue.trim();
    if (!content) return toastError('Write something first, then let AI help.');
    setAiLoading(true);
    setInsights(null);
    try {
      const res = await fetch('/api/ai/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const json = (await res.json()) as { insights?: NotesInsights; error?: string };
      if (!res.ok || !json.insights) throw new Error(json.error || 'Could not analyze note');
      setInsights(json.insights);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'AI assist failed');
    } finally {
      setAiLoading(false);
    }
  }

  function applyInsights() {
    if (!insights) return;
    setBodyValue((v) => (v.trimEnd() + formatInsightsForNote(insights)).trimStart());
    setInsights(null);
    success('AI summary added to note');
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim() || null;
    const body = bodyValue.trim() || null;
    if (!body && !title) return toastError('Note must have content');
    setLoading(true);
    const supabase = createClient();
    const { error } = note
      ? await supabase.from('notes').update({ title, body: body ?? '' }).eq('id', note.id)
      : await supabase.from('notes').insert({ family_id: familyId, created_by: userId, title, body: body ?? '' });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    success(note ? 'Note saved' : 'Note created');
    onSaved();
  }

  const currentColor = NOTE_COLORS.find((c) => c.id === selectedColor) ?? NOTE_COLORS[0];

  return (
    <Modal open onClose={onClose} title={note ? 'Edit Note' : 'New Note'}>
      <form onSubmit={onSubmit} className="space-y-4">
        {/* Color picker */}
        <div className="flex items-center gap-2">
          <div className={cn('flex flex-1 flex-wrap gap-1.5 rounded-xl p-2', currentColor.bg)}>
            {COLOR_SWATCHES.map((c) => (
              <button key={c.id} type="button" onClick={() => setSelectedColor(c.id)}
                className={cn(
                  'h-5 w-5 rounded-full transition hover:scale-110',
                  c.swatch,
                  selectedColor === c.id && 'ring-2 ring-white ring-offset-1 scale-110',
                )} />
            ))}
          </div>
        </div>

        <Field label="Title (optional)">
          {(id) => (
            <Input id={id} name="title" defaultValue={note?.title ?? ''}
              placeholder="Note title…" autoFocus={!note} />
          )}
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium">Content</label>
            <div className="flex items-center gap-1">
              <button type="button" onClick={insertChecklistItem}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-fg transition">
                <CheckSquare className="h-3 w-3" /> Add checklist item
              </button>
              <button type="button" onClick={runAiAssist} disabled={aiLoading}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 transition disabled:opacity-50">
                <Sparkles className={cn('h-3 w-3', aiLoading && 'animate-pulse')} />
                {aiLoading ? 'Thinking…' : 'AI Assist'}
              </button>
            </div>
          </div>
          <Textarea
            value={bodyValue}
            onChange={(e) => setBodyValue(e.target.value)}
            placeholder={`Write anything…\n\nTip: [ ] unchecked item\n     [x] checked item`}
            className="min-h-[200px] font-mono text-sm"
            autoFocus={!!note} />

          {insights && (
            <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand">
                  <Sparkles className="h-3.5 w-3.5" /> AI summary
                </span>
                <button type="button" onClick={() => setInsights(null)} className="text-muted hover:text-fg">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {insights.summary && <p className="text-sm leading-relaxed">{insights.summary}</p>}
              {insights.actionItems.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {insights.actionItems.map((item, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-muted">
                      <Square className="mt-0.5 h-3 w-3 flex-shrink-0" /> {item}
                    </li>
                  ))}
                </ul>
              )}
              {insights.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {insights.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">#{tag}</span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex justify-end">
                <button type="button" onClick={applyInsights}
                  className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand/90 transition">
                  Add to note
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{note ? 'Save' : 'Create Note'}</Button>
        </div>
      </form>
    </Modal>
  );
}
