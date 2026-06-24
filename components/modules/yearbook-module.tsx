'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, ChevronRight, BookOpen, Image as ImageIcon,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  ENTRY_CATEGORIES, entriesByCategory,
  yearbookSummary, fmtDate,
} from '@/lib/yearbook/yearbook';

type Yearbook = Tables<'family_yearbooks'>;
type Entry = Tables<'yearbook_entries'>;

export function YearbookModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const yearbooks = useRealtimeQuery<Yearbook>({
    table: 'family_yearbooks', familyId,
    fetcher: (s) => s.from('family_yearbooks').select('*').eq('family_id', familyId).eq('is_active', true).order('year', { ascending: false }),
    deps: [familyId],
  });

  const [selectedYb, setSelectedYb] = useState<Yearbook | null>(null);
  const [addYbOpen, setAddYbOpen] = useState(false);

  const summary = useMemo(() => {
    if (!yearbooks.data) return null;
    return yearbookSummary(yearbooks.data, []);
  }, [yearbooks.data]);

  if (yearbooks.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader title="Family Yearbook" />

      {summary && summary.totalYearbooks > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4">
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddYbOpen(true)}><Plus className="w-4 h-4 mr-1" /> New Yearbook</Button>
      </div>

      {(!yearbooks.data || yearbooks.data.length === 0) ? (
        <EmptyState title="No yearbooks" description="Create annual family yearbooks to collect your favorite memories." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {yearbooks.data.map((y) => (
            <button key={y.id} onClick={() => setSelectedYb(y)}
              className="text-left rounded-xl border border-border bg-surface/60 p-5 hover:border-primary/40 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <span className="text-3xl font-bold">{y.year}</span>
                <ChevronRight className="w-4 h-4 text-muted" />
              </div>
              <p className="text-sm font-semibold">{y.title}</p>
              {y.description && <p className="text-xs text-muted mt-1 line-clamp-2">{y.description}</p>}
              <div className="mt-2 flex items-center gap-2">
                {y.is_published && (
                  <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                    Published
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {addYbOpen && (
        <AddYearbookModal familyId={familyId} userId={userId}
          onClose={() => setAddYbOpen(false)}
          onSuccess={() => { setAddYbOpen(false); success('Yearbook created'); }} />
      )}
      {selectedYb && (
        <YearbookDetailView yearbook={selectedYb} familyId={familyId} userId={userId} members={members}
          onClose={() => setSelectedYb(null)}
          onDelete={() => { setSelectedYb(null); success('Yearbook removed'); }} />
      )}
    </div>
  );
}

function AddYearbookModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('family_yearbooks').insert({
      family_id: familyId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      year: Number(f.get('year') ?? new Date().getFullYear()),
      description: String(f.get('description') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Create Yearbook">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="Our Family 2026" />}</Field>
        <Field label="Year">{(id) => <Input id={id} name="year" type="number" defaultValue={new Date().getFullYear()} />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={2} placeholder="A year of adventures and milestones..." />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

function YearbookDetailView({ yearbook, familyId, userId, members, onClose, onDelete }: {
  yearbook: Yearbook; familyId: string; userId: string;
  members: { id: string; display_name: string }[];
  onClose: () => void; onDelete: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [addEntryOpen, setAddEntryOpen] = useState(false);

  const entries = useRealtimeQuery<Entry>({
    table: 'yearbook_entries', familyId,
    fetcher: (s) => s.from('yearbook_entries').select('*').eq('yearbook_id', yearbook.id).order('sort_order'),
    deps: [yearbook.id],
  });

  const catStats = useMemo(() => {
    if (!entries.data) return [];
    return entriesByCategory(entries.data);
  }, [entries.data]);

  async function handleDelete() {
    const { error } = await createClient().from('family_yearbooks').update({ is_active: false }).eq('id', yearbook.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  async function removeEntry(entryId: string) {
    const { error } = await createClient().from('yearbook_entries').delete().eq('id', entryId);
    if (error) toastError(error.message);
    else success('Entry removed');
  }

  return (
    <Modal open onClose={onClose} title={`${yearbook.title} (${yearbook.year})`}>
      <div className="space-y-4">
        {yearbook.description && <p className="text-sm text-muted">{yearbook.description}</p>}

        {catStats.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {catStats.map(({ category, count }) => (
              <span key={category} className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
                {category}: {count}
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAddEntryOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Memory</Button>
        </div>

        {(!entries.data || entries.data.length === 0) ? (
          <p className="text-sm text-muted text-center py-4">No memories added yet. Start building your yearbook!</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {entries.data.map((e) => (
              <div key={e.id} className="flex items-start justify-between p-3 rounded-lg border border-border bg-surface/40">
                <div>
                  <p className="text-sm font-semibold">{e.title}</p>
                  <p className="text-xs text-muted">{e.category}{e.entry_date ? ` · ${fmtDate(e.entry_date)}` : ''}</p>
                  {e.description && <p className="text-xs text-muted mt-1 line-clamp-2">{e.description}</p>}
                </div>
                <button onClick={() => removeEntry(e.id)} className="text-muted hover:text-rose-400 p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {addEntryOpen && (
          <AddEntryForm yearbookId={yearbook.id} familyId={familyId} userId={userId} members={members}
            onClose={() => setAddEntryOpen(false)}
            onSuccess={() => { setAddEntryOpen(false); success('Memory added'); }} />
        )}

        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Delete Yearbook
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function AddEntryForm({ yearbookId, familyId, userId, members, onClose, onSuccess }: {
  yearbookId: string; familyId: string; userId: string;
  members: { id: string; display_name: string }[];
  onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('yearbook_entries').insert({
      family_id: familyId,
      yearbook_id: yearbookId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      description: String(f.get('description') ?? ''),
      entry_date: String(f.get('entry_date') ?? '') || null,
      category: String(f.get('category') ?? 'Other'),
      member_id: String(f.get('member_id') ?? '') || null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-surface/60 p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="What happened?" />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={2} />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Date">{(id) => <Input id={id} name="entry_date" type="date" />}</Field>
          <Field label="Category">{(id) =>
            <Select id={id} name="category" defaultValue="Family">
              {ENTRY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          }</Field>
          <Field label="Who">{(id) =>
            <Select id={id} name="member_id" defaultValue="">
              <option value="">Everyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          }</Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" loading={loading}>Add</Button>
        </div>
      </form>
    </div>
  );
}
