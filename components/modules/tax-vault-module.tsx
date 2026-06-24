'use client';

import { useMemo, useState } from 'react';
import { FolderLock, Plus, Trash2, Download, FileText } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import { usd } from '@/lib/finance/splits';
import { TAX_CATEGORIES, taxCategoryLabel, isDeductible, groupByYear, deductibleTotalCents, type TaxDocLike } from '@/lib/finance/tax';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument } from '@/lib/storage/documents';
import type { Tables } from '@/lib/database.types';

type TaxDoc = Tables<'tax_documents'>;

const thisYear = new Date().getFullYear();
const blank = () => ({ name: '', tax_year: String(thisYear), category: 'receipt', amount: '', member_id: '', note: '', file: null as File | null });

export function TaxVaultModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: docs, loading } = useRealtimeQuery<TaxDoc>({
    table: 'tax_documents', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('tax_documents').select('*').eq('family_id', familyId).order('tax_year', { ascending: false }).order('created_at', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [saving, setSaving] = useState(false);
  const all = useMemo(() => docs ?? [], [docs]);
  const grouped = useMemo(() => groupByYear(all), [all]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.name.trim()) return;
    setSaving(true);
    const supabase = createClient();
    let storage_path: string | null = null;
    try {
      if (form.file) {
        const { path, error } = await uploadFamilyDocument(supabase, { familyId, folder: `tax/${form.tax_year}`, file: form.file });
        if (error) { setSaving(false); return toastError(error); }
        storage_path = path;
      }
      const { error } = await supabase.from('tax_documents').insert({
        family_id: familyId,
        tax_year: parseInt(form.tax_year, 10) || thisYear,
        category: form.category,
        name: form.name.trim(),
        storage_path,
        amount_cents: form.amount ? Math.round(parseFloat(form.amount) * 100) : null,
        member_id: form.member_id || null,
        note: form.note.trim() || null,
        created_by: userId,
      });
      if (error) return toastError(error.message);
      success('Document saved');
      setForm(null);
    } finally {
      setSaving(false);
    }
  }

  async function download(path: string) {
    const { url, error } = await getDocumentSignedUrl(createClient(), path);
    if (error || !url) return toastError(error ?? 'Could not open');
    window.open(url, '_blank', 'noopener');
  }

  async function remove(d: TaxDoc) {
    if (!confirm('Delete this document?')) return;
    const supabase = createClient();
    if (d.storage_path) await removeFamilyDocument(supabase, d.storage_path);
    const { error } = await supabase.from('tax_documents').delete().eq('id', d.id);
    if (error) toastError(error.message); else success('Deleted');
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><FolderLock className="h-4 w-4 text-brand" /> Tax Document Vault</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="tax" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add document</Button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={FolderLock} title="No tax documents yet" description="Securely store W-2s, 1099s, receipts and deduction records by year." />
      ) : grouped.map(({ year, docs: yearDocs }) => {
        const deductible = deductibleTotalCents(yearDocs as TaxDocLike[]);
        return (
          <div key={year}>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">{year} <span className="text-xs font-normal text-muted">· {yearDocs.length} docs</span></h4>
              {deductible > 0 && <span className="text-xs text-muted">Deductible logged: <span className="font-semibold text-success">{usd(deductible)}</span></span>}
            </div>
            <div className="space-y-2">
              {yearDocs.map((d) => {
                const m = d.member_id ? memberById.get(d.member_id) : null;
                return (
                  <div key={d.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                    <div className={`rounded-lg p-1.5 ${isDeductible(d.category) ? 'bg-success/15 text-success' : 'bg-border/40 text-muted'}`}><FileText className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.name}</p>
                      <p className="text-xs text-muted">
                        {taxCategoryLabel(d.category)}{d.amount_cents != null ? ` · ${usd(d.amount_cents)}` : ''}{m ? ` · ${m.display_name}` : ''} · {fmtDate(d.created_at)}
                      </p>
                    </div>
                    {d.storage_path && <button onClick={() => download(d.storage_path!)} className="text-muted hover:text-brand" aria-label="Download"><Download className="h-4 w-4" /></button>}
                    <button onClick={() => remove(d)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {form && (
        <Modal open onClose={() => setForm(null)} title="Add tax document">
          <form onSubmit={save} className="space-y-3">
            <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="2025 W-2 — Acme Corp" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tax year">{(id) => <Input id={id} type="number" value={form.tax_year} onChange={(e) => setForm({ ...form, tax_year: e.target.value })} />}</Field>
              <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{TAX_CATEGORIES.map((c) => <option key={c} value={c}>{taxCategoryLabel(c)}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount ($, optional)">{(id) => <Input id={id} type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
              <Field label="Member (optional)">{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}><option value="">— None —</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            </div>
            <Field label="File (optional, stored privately)">
              {(id) => <input id={id} type="file" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} className="block w-full text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-1.5 file:text-sm" />}
            </Field>
            <Field label="Note">{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
