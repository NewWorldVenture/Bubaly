'use client';

// Family Knowledge Base — the persistent store behind "Family Memory". Durable
// facts the family looks up again and again (sizes, allergies, key contacts,
// preferences, account numbers). 100% Supabase via useRealtimeQuery, backed by
// the family_facts table (migration 0123).
import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Brain, Plus, Search, Pin, PinOff, Pencil, Trash2, Copy, Check, Database,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  filterFacts, groupByCategory, FACT_CATEGORY_LABELS, FACT_CATEGORY_ORDER,
  type FactCategory,
} from '@/lib/memory/facts';
import type { Tables } from '@/lib/database.types';

type Fact = Tables<'family_facts'>;

const blank = {
  id: '', member_id: '' as string, category: 'important' as FactCategory,
  label: '', value: '', notes: '',
};

export function KnowledgeBaseModule({ canSeed = false }: { canSeed?: boolean }) {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const [memberFilter, setMemberFilter] = useState<string>('all');
  const [catFilter, setCatFilter] = useState<FactCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: facts, loading, error } = useRealtimeQuery<Fact>({
    table: 'family_facts', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_facts').select('*').eq('family_id', familyId),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? 'The family';

  const visible = useMemo(
    () => filterFacts(facts, { member: memberFilter, category: catFilter, q }),
    [facts, memberFilter, catFilter, q],
  );
  const grouped = useMemo(() => groupByCategory(visible), [visible]);

  function openNew() { setForm(blank); setModalOpen(true); }
  function openEdit(f: Fact) {
    setForm({ id: f.id, member_id: f.member_id ?? '', category: f.category as FactCategory, label: f.label, value: f.value, notes: f.notes ?? '' });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.label.trim() || !form.value.trim()) { toastError('Add both a label and a value'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: form.member_id || null, category: form.category,
      label: form.label.trim(), value: form.value.trim(), notes: form.notes.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('family_facts').update(fields).eq('id', form.id)
      : await sb.from('family_facts').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Updated' : 'Saved to family memory');
    setModalOpen(false);
  }

  async function remove(f: Fact) {
    if (!confirm(`Forget "${f.label}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('family_facts').delete().eq('id', f.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Removed');
  }

  async function togglePin(f: Fact) {
    const sb = createClient();
    const { error: err } = await sb.from('family_facts').update({ is_pinned: !f.is_pinned }).eq('id', f.id);
    if (err) toastError(describeDbError(err));
  }

  async function copyValue(f: Fact) {
    try {
      await navigator.clipboard.writeText(f.value);
      setCopiedId(f.id); setTimeout(() => setCopiedId((c) => (c === f.id ? null : c)), 1500);
    } catch { /* clipboard unavailable — no-op */ }
  }

  if (loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load family memory'} />;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Family Knowledge Base"
        description="Everything the family should never have to re-remember — sizes, allergies, key contacts, preferences — in one searchable place."
        action={
          <div className="flex items-center gap-2">
            {canSeed && (
              <Link href="/dashboard/knowledge/seed"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg">
                <Database className="h-4 w-4" /> Seed test data
              </Link>
            )}
            <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add a fact</Button>
          </div>
        }
      />

      {/* Filters */}
      <div className="mb-5 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={q} inputMode="search" enterKeyHint="search" onChange={(e) => setQ(e.target.value)} placeholder="Search facts…" className="pl-9" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={memberFilter === 'all'} onClick={() => setMemberFilter('all')}>Everyone</Chip>
          <Chip active={memberFilter === 'family'} onClick={() => setMemberFilter('family')}>Whole family</Chip>
          {members.map((m) => (
            <Chip key={m.id} active={memberFilter === m.id} onClick={() => setMemberFilter(m.id)}>{m.display_name}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={catFilter === 'all'} onClick={() => setCatFilter('all')} subtle>All</Chip>
          {FACT_CATEGORY_ORDER.map((c) => (
            <Chip key={c} active={catFilter === c} onClick={() => setCatFilter(c)} subtle>{FACT_CATEGORY_LABELS[c]}</Chip>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Brain} title="Nothing saved yet"
          description="Capture the facts you always have to look up — shoe sizes, the pediatrician's number, who's allergic to what."
          action={<Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add a fact</Button>} />
      ) : (
        <div className="space-y-6">
          {grouped.map(([cat, items]) => (
            <section key={cat}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{FACT_CATEGORY_LABELS[cat]} <span className="opacity-60">· {items.length}</span></h2>
              <ul className="space-y-2">
                {items.map((f) => (
                  <li key={f.id} className={cn('flex items-start gap-3 rounded-xl border bg-surface/50 p-3', f.is_pinned ? 'border-brand/30' : 'border-border')}>
                    <Avatar name={memberName(f.member_id)} size={28} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-fg">{f.label}</span>
                        {f.is_pinned && <Pin className="h-3 w-3 text-brand-text" />}
                      </div>
                      <p className="break-words text-sm text-fg">{f.value}</p>
                      {f.notes && <p className="mt-0.5 text-xs text-muted">{f.notes}</p>}
                      <p className="mt-0.5 text-[11px] text-muted">{memberName(f.member_id)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button onClick={() => copyValue(f)} aria-label="Copy value" title="Copy" className="rounded p-1.5 text-muted hover:bg-elevated hover:text-fg">
                        {copiedId === f.id ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={() => togglePin(f)} aria-label={f.is_pinned ? 'Unpin' : 'Pin'} title={f.is_pinned ? 'Unpin' : 'Pin'} className="rounded p-1.5 text-muted hover:bg-elevated hover:text-brand-text">
                        {f.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                      </button>
                      <button onClick={() => openEdit(f)} aria-label="Edit" className="rounded p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                      <button onClick={() => remove(f)} aria-label="Remove" className="rounded p-1.5 text-muted hover:bg-elevated hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Add / edit */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit fact' : 'Add a fact'}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="About">
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
                  <option value="">Whole family</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as FactCategory }))}>
                  {FACT_CATEGORY_ORDER.map((c) => <option key={c} value={c}>{FACT_CATEGORY_LABELS[c]}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Label" required>
            {(id) => <Input id={id} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Shoe size, Allergy, Pediatrician" autoFocus />}
          </Field>
          <Field label="Value" required>
            {(id) => <Input id={id} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="e.g. US 2, Peanuts, Dr. Lee 555-0100" />}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Any extra detail…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add fact'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Chip({ active, onClick, subtle, children }: { active: boolean; onClick: () => void; subtle?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition',
        active ? 'border-brand bg-brand text-white'
          : subtle ? 'border-border bg-surface/50 text-muted hover:text-fg'
            : 'border-border bg-surface/50 text-fg hover:bg-elevated')}>
      {children}
    </button>
  );
}
