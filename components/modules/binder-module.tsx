'use client';

import { useMemo, useState } from 'react';
import { FolderLock, Plus, Trash2, Eye, EyeOff, Pencil } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { BINDER_CATEGORIES, binderCategoryLabel, maskValue, groupByCategory, type InfoLike } from '@/lib/home/binder';
import type { Tables } from '@/lib/database.types';

type Info = Tables<'household_info'>;
const blank = () => ({ id: '', category: 'wifi', label: '', value: '', note: '', is_sensitive: false });

export function BinderModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: items, loading } = useRealtimeQuery<Info>({
    table: 'household_info', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('household_info').select('*').eq('family_id', familyId).order('category').order('sort'),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupByCategory((items ?? []) as (Info & InfoLike)[]), [items]);

  function toggleReveal(id: string) {
    setRevealed((r) => { const n = new Set(r); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.label.trim()) return;
    const row = { category: form.category, label: form.label.trim(), value: form.value.trim() || null, note: form.note.trim() || null, is_sensitive: form.is_sensitive };
    const supabase = createClient();
    const { error } = form.id
      ? await supabase.from('household_info').update(row).eq('id', form.id)
      : await supabase.from('household_info').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(describeDbError(error));
    success(form.id ? 'Updated' : 'Saved'); setForm(null);
  }
  async function remove(id: string) {
    if (!confirm('Delete this entry?')) return;
    const { error } = await createClient().from('household_info').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }
  function edit(i: Info) {
    setForm({ id: i.id, category: i.category, label: i.label, value: i.value ?? '', note: i.note ?? '', is_sensitive: i.is_sensitive });
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><FolderLock className="h-4 w-4 text-brand" /> Household Binder</h3>
          <p className="text-xs text-muted">Your digital command center — Wi-Fi, codes, shutoffs, policies and key info in one place.</p>
        </div>
        <div className="flex items-center gap-2">
          <AiInsight kind="binder" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add entry</Button>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={FolderLock} title="Your binder is empty" description="Add the things everyone forgets: Wi-Fi password, alarm code, water shutoff, insurance policy numbers." />
      ) : groups.map((g) => (
        <div key={g.category}>
          <h4 className="mb-2 text-sm font-semibold">{binderCategoryLabel(g.category)}</h4>
          <div className="space-y-2">
            {g.items.map((i) => {
              const show = !i.is_sensitive || revealed.has(i.id);
              return (
                <div key={i.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface/40 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{i.label}</p>
                    {i.value && <p className="font-mono text-sm text-fg/90">{show ? i.value : maskValue(i.value)}</p>}
                    {i.note && <p className="mt-0.5 text-xs text-muted">{i.note}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {i.is_sensitive && i.value && <button onClick={() => toggleReveal(i.id)} className="text-muted hover:text-fg" aria-label="Reveal">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>}
                    <button onClick={() => edit(i)} className="text-muted hover:text-fg" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => remove(i.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit entry' : 'Add entry'}>
          <form onSubmit={save} className="space-y-3">
            <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{BINDER_CATEGORIES.map((c) => <option key={c} value={c}>{binderCategoryLabel(c)}</option>)}</Select>}</Field>
            <Field label="Label">{(id) => <Input id={id} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Wi-Fi password, Alarm code…" />}</Field>
            <Field label="Value">{(id) => <Input id={id} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />}</Field>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Where, who, how…" />}</Field>
            <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={form.is_sensitive} onChange={(e) => setForm({ ...form, is_sensitive: e.target.checked })} className="h-4 w-4 accent-[var(--brand)]" /> Sensitive — mask by default</label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
