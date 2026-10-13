'use client';

import { useMemo, useState } from 'react';
import { FolderLock, Plus, Trash2, Download, FileText } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { useFormat } from '@/components/i18n/use-format';
import { usd as usdIn } from '@/lib/finance/splits';
import { TAX_CATEGORIES, taxCategoryLabel, isDeductible, groupByYear, deductibleTotalCents, type TaxDocLike } from '@/lib/finance/tax';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument } from '@/lib/storage/documents';
import type { Tables } from '@/lib/database.types';
import { preOpenWindow } from '@/lib/utils/open-url';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { useFamilyClock } from '@/components/i18n/use-format';

type TaxDoc = Tables<'tax_documents'>;

/** `tax_documents.amount_cents` is an int4 (0077): $21,474,836.47 is the largest it holds. */
const MAX_AMOUNT_CENTS = 2_147_483_647;
/** The earliest tax year the vault accepts; the latest is next year. */
const MIN_TAX_YEAR = 1900;

// The tax year defaults to the FAMILY's current year (TIME-003).
const blank = (thisYear: number) => ({ name: '', tax_year: String(thisYear), category: 'receipt', amount: '', member_id: '', note: '', file: null as File | null });

export function TaxVaultModule() {
  const clock = useFamilyClock();
  const thisYear = Number(clock.todayKey().slice(0, 4));
  const { fmtDate } = useFormat();
  const t = useTranslations();
  // Money follows the reader; the currency stays the money's own.
  const locale = useLocale();
  const usd = (cents: number) => usdIn(cents, locale.code);
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: docs, loading, error, refresh } = useRealtimeQuery<TaxDoc>({
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
    // Checked BEFORE anything is uploaded. `amount_cents` and `tax_year` are
    // int4 (0077): a value past either answers 22003, and the W-2 uploaded
    // ahead of the row was left in the bucket with nothing pointing at it.
    const taxYear = parseInt(form.tax_year, 10) || thisYear;
    if (taxYear < MIN_TAX_YEAR || taxYear > thisYear + 1) {
      return toastError(t('taxVaultModule.taxYearOutOfRange', { min: MIN_TAX_YEAR, max: thisYear + 1 }));
    }
    const amountCents = form.amount ? Math.round(parseFloat(form.amount) * 100) : null;
    if (amountCents !== null && (!Number.isFinite(amountCents) || Math.abs(amountCents) > MAX_AMOUNT_CENTS)) {
      return toastError(t('taxVaultModule.amountTooLarge', { max: usd(MAX_AMOUNT_CENTS) }));
    }
    setSaving(true);
    const supabase = createClient();
    let storage_path: string | null = null;
    // The file goes up first and the row second. Whatever stops the row — a
    // refusal, a filtered insert, a dropped connection — leaves an object no
    // row points at, invisible in the vault and impossible to delete from it,
    // so it is removed here, as documents-module and lib/documents/upload do.
    const discardUpload = async () => {
      if (!storage_path) return;
      const removal = await removeFamilyDocument(supabase, storage_path);
      if (removal.error) console.error('[tax-vault] an upload no row points at could not be removed', removal.error);
    };
    try {
      if (form.file) {
        const { path, error } = await uploadFamilyDocument(supabase, { familyId, folder: `tax/${form.tax_year}`, file: form.file });
        if (error) { setSaving(false); return toastError(error); }
        storage_path = path;
      }
      let saved: { id: string }[] | null = null;
      try {
        const { data, error } = await supabase.from('tax_documents').insert({
          family_id: familyId,
          tax_year: taxYear,
          category: form.category,
          name: form.name.trim(),
          storage_path,
          amount_cents: amountCents,
          member_id: form.member_id || null,
          note: form.note.trim() || null,
          created_by: userId,
        }).select('id');
        if (error) { await discardUpload(); return toastError(describeDbError(error)); }
        saved = data;
      } catch (cause) {
        await discardUpload();
        throw cause;
      }
      if (wroteNoRows(saved)) { await discardUpload(); return toastError(t('errors.thatChangeWasNotSaved')); }
      success(t('taxVaultModule.documentSaved'));
      setForm(null);
    } finally {
      setSaving(false);
    }
  }

  async function download(path: string) {
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    const { url, error } = await getDocumentSignedUrl(createClient(), path);
    if (error || !url) { tab.cancel(); return toastError(error ?? 'Could not open'); }
    tab.navigate(url);
  }

  async function remove(d: TaxDoc) {
    if (!confirm(t('taxVaultModule.deleteThisDocument'))) return;
    const supabase = createClient();
    // The object goes first and its result is READ: deleting the row first
    // makes a surviving file INVISIBLE — nothing references it, so nobody can
    // see it, open it or try again — while the screen says it is gone. Audit
    // C1-S6-01; the same shape adminDeleteDocumentAction already uses.
    if (d.storage_path) {
      const { error: storageError } = await removeFamilyDocument(supabase, d.storage_path);
      if (storageError) return toastError(storageError);
    }
    // Under RLS a refused row comes back with no error and zero rows, which this used to report as done. Audit C1-S9-86.
    const { data: removed, error } = await supabase.from('tax_documents').delete().eq('id', d.id).eq('family_id', familyId).select('id');
    if (error) toastError(describeDbError(error)); else if (wroteNoRows(removed)) toastError(t('errors.thatChangeWasNotSaved')); else success(t('taxVaultModule.deleted'));
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={t('taxVaultModule.couldNotLoadTaxDocuments')} onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-base font-semibold"><FolderLock className="h-4 w-4 text-brand-text" /> {t('taxVault.taxDocumentVault')}</h1>
        <div className="flex items-center gap-2">
          <AiInsight kind="tax" iconOnly />
          <Button onClick={() => setForm(blank(thisYear))}><Plus className="h-4 w-4" /> {t('taxVault.addDocument')}</Button>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState icon={FolderLock} title={t('taxVault.noTaxDocumentsYet')} description={t('taxVaultModule.securelyStoreW2s1099s')} />
      ) : grouped.map(({ year, docs: yearDocs }) => {
        const deductible = deductibleTotalCents(yearDocs as TaxDocLike[]);
        return (
          <div key={year}>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold">{year} <span className="text-xs font-normal text-muted">· {yearDocs.length} docs</span></h4>
              {deductible > 0 && <span className="text-xs text-muted">{t('taxVault.deductibleLogged')} <span className="font-semibold text-success">{usd(deductible)}</span></span>}
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
                    {d.storage_path && <button onClick={() => download(d.storage_path!)} className="text-muted hover:text-brand-text" aria-label={t('taxVault.download')}><Download className="h-4 w-4" /></button>}
                    <button onClick={() => remove(d)} className="text-muted hover:text-danger" aria-label={t('taxVault.delete')}><Trash2 className="h-4 w-4" /></button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {form && (
        <Modal open onClose={() => setForm(null)} title={t('taxVault.addTaxDocument')}>
          <form onSubmit={save} className="space-y-3">
            <Field label={t('taxVault.name')}>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('taxVault.2025W2AcmeCorp')} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('taxVault.taxYear')}>{(id) => <Input id={id} type="number" value={form.tax_year} onChange={(e) => setForm({ ...form, tax_year: e.target.value })} />}</Field>
              <Field label={t('taxVault.category')}>{(id) => <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{TAX_CATEGORIES.map((c) => <option key={c} value={c}>{taxCategoryLabel(c)}</option>)}</Select>}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('taxVault.amountOptional')}>{(id) => <Input id={id} type="number" inputMode="decimal" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Field>
              <Field label={t('taxVault.memberOptional')}>{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}><option value="">{t('taxVault.none')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
            </div>
            <Field label={t('taxVault.fileOptionalStoredPrivately')}>
              {(id) => <input id={id} type="file" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} className="block w-full text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-elevated file:px-3 file:py-1.5 file:text-sm" />}
            </Field>
            <Field label={t('taxVault.note')}>{(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>{t('taxVault.cancel')}</Button>
              <Button type="submit" loading={saving}>{t('taxVault.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
