'use client';

import { useMemo, useRef, useState } from 'react';
import { useDismissOnEscape } from '@/lib/hooks/use-dismiss-on-escape';
import { parseISO } from 'date-fns';
import {
  Upload, Search, Download, Trash2, Star, Lock, LockOpen, Cloud, Share2,
  FileText, FileImage, FileSpreadsheet, FileVideo, FileAudio, FileArchive, File as FileIcon,
  ChevronDown, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { isManager } from '@/lib/constants/roles';
import { performUpload } from '@/lib/documents/upload';
import { needsSecureFlag } from '@/lib/documents/sensitivity';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { wroteNoRows } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { buildFamilyPath, isReservedDocumentPath, uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument, DOCUMENT_MAX_MB, DOCUMENT_MAX_BYTES } from '@/lib/storage/documents';
import {
  VIEW_META, filterByView, filterByCategory, searchDocs, sortDocs, groupByCategory, storageSummary, formatBytes, fileKind,
  type FileView, type SortKey, type DocLike,
} from '@/lib/files/overview';
import type { Tables } from '@/lib/database.types';
import { preOpenWindow } from '@/lib/utils/open-url';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { useFormat } from '@/components/i18n/use-format';
import type { Format } from '@/lib/utils/format';

type Document = Tables<'documents'>;
type UploadAttempt = {
  id: string; path: string; familyId: string; userId: string; view: FileView;
  title: string; category: string; file: File; pending: boolean;
};

// In the family's zone (TIME-003), through the shared formatter.
function displayDate(value: string, fmtDate: Format['fmtDate']) {
  const parsed = parseISO(value);
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date(value);
  return Number.isFinite(date.getTime()) ? fmtDate(date, 'EEE, MMM d') : '';
}

const KIND_ICON: Record<string, typeof FileIcon> = {
  image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet,
  video: FileVideo, audio: FileAudio, archive: FileArchive, file: FileIcon,
};
const KIND_TONE: Record<string, string> = {
  image: 'bg-emerald-500/15 text-emerald-400', pdf: 'bg-rose-500/15 text-rose-400',
  doc: 'bg-blue-500/15 text-blue-400', sheet: 'bg-green-500/15 text-green-400',
  video: 'bg-violet-500/15 text-violet-400', audio: 'bg-amber-500/15 text-amber-400',
  archive: 'bg-orange-500/15 text-orange-400', file: 'bg-slate-500/15 text-slate-300',
};
const VIEW_ICON: Record<FileView, typeof Cloud> = { cloud: Cloud, vault: Lock, shared: Share2 };

const toDocLike = (d: Document): DocLike => ({
  id: d.id, title: d.title, category: d.category, mime_type: d.mime_type,
  size_bytes: d.size_bytes, is_secure: d.is_secure, is_favorite: d.is_favorite, created_at: d.created_at,
});

export function FilesHubModule({ view }: { view: FileView }) {
  const t = useTranslations();
  const locale = useLocale().code;
  const { fmtDate } = useFormat();
  const number = new Intl.NumberFormat(locale);
  const { familyId, userId, role } = useApp();
  // 0266 made the Secure Vault a database boundary rather than a folder label:
  // a non-manager no longer reads, moves or deletes a sensitive file. The check
  // here is not the boundary — it is so the controls that would now fail are
  // not offered, and the Vault tab explains itself instead of coming back empty.
  const manager = isManager(role);
  const { success, error: toastError } = useToast();
  const meta = VIEW_META[view];
  const viewTitle = t(meta.titleKey);
  const ViewIcon = VIEW_ICON[view];

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [sortOpen, setSortOpen] = useState(false);
  useDismissOnEscape(sortOpen, () => setSortOpen(false));
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<{ familyId: string; view: FileView; category: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadAttempt = useRef<UploadAttempt | null>(null);
  const uploadDraft = useRef({ familyId, userId, view, file, title: title.trim(), category: category.trim() });
  uploadDraft.current = { familyId, userId, view, file, title: title.trim(), category: category.trim() };

  const { data, loading, error, refresh } = useRealtimeQuery<Document>({
    table: 'documents', familyId, deps: [familyId],
    // Paged to the end: one select stops at db-max-rows (1,000) and says
    // nothing, so past it the oldest files — Vault ones included, since the
    // view filter runs after the read — fell out of every tile and search.
    // Past the ceiling readAll answers an error, and the screen says so.
    fetcher: (sb) => readAllAsQuery<Document>((from, to) => sb.from('documents').select('*').eq('family_id', familyId)
      .order('created_at', { ascending: false }).order('id').range(from, to), { max: 20_000 }),
  });

  const byId = useMemo(() => new Map(data.map((d) => [d.id, d])), [data]);
  const scoped = useMemo(() => filterByView(data.map(toDocLike), view), [data, view]);
  const folderFilter = selectedFolder?.familyId === familyId && selectedFolder.view === view ? selectedFolder : null;
  const visible = useMemo(() => sortDocs(searchDocs(folderFilter ? filterByCategory(scoped, folderFilter.category) : scoped, query), sort), [scoped, query, sort, folderFilter]);
  const filtered = Boolean(query) || folderFilter !== null;
  const summary = useMemo(() => storageSummary(scoped), [scoped]);
  const folders = useMemo(() => groupByCategory(scoped), [scoped]);

  async function download(id: string) {
    const d = byId.get(id); if (!d) return;
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    setBusy(id);
    const { url, error: err } = await getDocumentSignedUrl(createClient(), d.storage_path);
    setBusy(null);
    if (err || !url) { tab.cancel(); return toastError(t('filesHubModule.openFailed')); }
    tab.navigate(url);
  }

  async function remove(id: string) {
    const d = byId.get(id); if (!d) return;
    if (d.is_secure && !manager) return toastError(t('filesHubModule.onlyAParentOrAnother'));
    if (typeof window !== 'undefined' && !window.confirm(t('filesHubModule.deleteConfirm', { name: d.title }))) return;
    setBusy(id);
    const sb = createClient();
    // Two halves of the same defect, both kept.
    //
    // The OBJECT goes first and its result is READ (C1-S6-01 / C4-S4-09):
    // deleting the row first makes a surviving file INVISIBLE — nothing
    // references it, so nobody can see it, open it or try again — while the
    // screen says it is gone. A warranty or a manual is plausibly being deleted
    // BECAUSE it carries a serial or a policy number.
    //
    // And the row delete is VERIFIED with `.select('id')` (main's F-K series):
    // an UPDATE or DELETE that matches nothing succeeds with zero rows and no
    // error, so a delete RLS refused would otherwise report success too.
    if (d.storage_path) {
      const { error: storageError } = await removeFamilyDocument(sb, d.storage_path);
      if (storageError) { setBusy(null); return toastError(storageError); }
    }
    const { data: rows, error: err } = await sb.from('documents').delete().eq('id', id).eq('family_id', familyId).select('id');
    setBusy(null);
    if (err) return toastError(t('filesHubModule.deleteFailed'));
    if (wroteNoRows(rows)) return toastError(t('errors.thatChangeWasNotSaved'));
    success(t('filesHubModule.fileDeleted')); refresh();
  }

  async function toggleSecure(id: string) {
    const d = byId.get(id); if (!d) return;
    if (!manager) return toastError(t('filesHubModule.onlyAParentOrAnother2'));
    // A folder private only in translation ("Financiën", "Versicherung") is an
    // ordinary folder to the database's category rule (0312), so `is_secure` is
    // all that keeps the row and its file from a child (0266, 0303). Out of the
    // Vault it goes nowhere; into it is always allowed.
    if (d.is_secure && needsSecureFlag(d.category)) {
      return toastError(t('filesHubModule.sensitiveStaysInVault', { category: d.category?.trim() ?? '' }));
    }
    setBusy(id);
    // `is_secure` moves a file between the shared area and the vault — a toggle
    // that silently did nothing leaves it where it was, reported as moved.
    const { data: rows, error: err } = await createClient().from('documents').update({ is_secure: !d.is_secure }).eq('id', id).eq('family_id', familyId).select('id');
    setBusy(null);
    if (err) return toastError(t('filesHubModule.moveFailed'));
    if (wroteNoRows(rows)) return toastError(t('errors.thatChangeWasNotSaved'));
    success(t(d.is_secure ? 'filesHubModule.movedShared' : 'filesHubModule.movedVault')); refresh();
  }

  async function toggleFavorite(id: string) {
    const d = byId.get(id); if (!d) return;
    const { data: rows, error: err } = await createClient().from('documents').update({ is_favorite: !d.is_favorite }).eq('id', id).eq('family_id', familyId).select('id');
    if (err) return toastError(t('filesHubModule.updateFailed'));
    if (wroteNoRows(rows)) return toastError(t('errors.thatChangeWasNotSaved'));
    refresh();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return toastError(t('filesHubModule.chooseAFileToUpload'));
    if (!title.trim()) return toastError(t('filesHubModule.addANameForThis'));
    if (file.size > DOCUMENT_MAX_BYTES) return toastError(t('filesHubModule.tooLarge', { limit: DOCUMENT_MAX_MB }));

    let attempt = uploadAttempt.current;
    if (!attempt || attempt.familyId !== familyId || attempt.userId !== userId || attempt.view !== view ||
      attempt.file !== file || attempt.title !== title.trim() || attempt.category !== category.trim()) {
      attempt = { id: crypto.randomUUID(), path: '', familyId, userId, view, file,
        title: title.trim(), category: category.trim(), pending: false };
      uploadAttempt.current = attempt;
    }
    if (attempt.pending) return;
    const currentAttempt = attempt;
    const sameDraft = () => Object.entries(uploadDraft.current).every(([key, value]) =>
      currentAttempt[key as keyof typeof uploadDraft.current] === value);
    currentAttempt.pending = true;

    // REFUSE, DO NOT DOWNGRADE, AND DO IT BEFORE THE BYTES MOVE.
    //
    // The decision and the ordering live in `lib/documents/upload.ts` so they
    // can be executed by a test holding real spies, rather than asserted by
    // reading this file. `performUpload` refuses first and only then calls
    // any effect, so a refused Vault submission makes neither a storage upload
    // nor a document insert. A confirmed metadata reservation must then precede
    // bytes, because the row is what makes Storage restrict a private object.
    setSaving(true);
    try {
      const sb = createClient();
      const outcome = await performUpload(
      { view, category, manager, folderFallback: meta.folder },
      {
        prepare: folder => {
          currentAttempt.path ||= buildFamilyPath(familyId, `${folder}/${currentAttempt.id}`, file.name);
          if (!isReservedDocumentPath(familyId, folder, currentAttempt.path)) throw new Error('Invalid upload destination');
          return currentAttempt.path;
        },
        record: async ({ storagePath, isSecure }) => {
          if (!sameDraft()) return { error: t('quickCapture.saveUncertain') };
          const fields = {
            id: currentAttempt.id, family_id: familyId, title: currentAttempt.title, category: currentAttempt.category || null,
            storage_path: storagePath, mime_type: file.type || null, size_bytes: file.size,
            is_secure: isSecure, created_by: userId,
          };
          const columns = 'id,family_id,title,category,storage_path,mime_type,size_bytes,is_secure,created_by';
          const matches = (row: unknown) => !!row && typeof row === 'object' &&
            Object.entries(fields).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
          const read = () => sb.from('documents').select(columns).eq('id', currentAttempt.id).eq('family_id', familyId).maybeSingle();
          const existing = await read();
          if (!sameDraft()) return { error: t('quickCapture.saveUncertain') };
          if (existing.error) return { error: t('quickCapture.saveUncertain') };
          if (existing.data) return { error: matches(existing.data) ? null : t('quickCapture.saveUncertain') };
          const inserted = await sb.from('documents').insert(fields).select(columns).single();
          if (!sameDraft()) return { error: t('quickCapture.saveUncertain') };
          if (inserted.error?.code === '23505') {
            const raced = await read();
            return { error: !raced.error && matches(raced.data) ? null : t('quickCapture.saveUncertain') };
          }
          if (inserted.error) return { error: /^(?:(?:22|23|28|42)[0-9A-Z]{3}|P0001)$/.test(inserted.error.code ?? '')
            ? t('avatarPicker.uploadFailed') : t('quickCapture.saveUncertain') };
          return { error: matches(inserted.data) ? null : t('quickCapture.saveUncertain') };
        },
        store: async reservedPath => {
          if (!sameDraft()) return { error: t('quickCapture.saveUncertain') };
          const { error } = await uploadFamilyDocument(sb, { familyId, folder: currentAttempt.category || meta.folder, file, reservedPath });
          return { error: error ? t('quickCapture.saveUncertain') : null };
        },
      },
      t,
    );
      if (uploadAttempt.current !== currentAttempt || !sameDraft()) return;
      if (!outcome.ok) return toastError(outcome.reason);
      success(t('filesHubModule.fileUploaded'));
      uploadAttempt.current = null;
      setOpen(false); setTitle(''); setCategory(''); setFile(null); refresh();
    } catch {
      if (uploadAttempt.current === currentAttempt && sameDraft()) toastError(t('quickCapture.saveUncertain'));
    } finally {
      currentAttempt.pending = false;
      if (uploadAttempt.current === currentAttempt || uploadAttempt.current === null) setSaving(false);
    }
  }

  if (loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message={t('filesHubModule.loadFailed')} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={viewTitle}
        description={t(meta.descriptionKey)}
        action={<Button onClick={() => { setTitle(''); setCategory(''); setFile(null); setOpen(true); }}><Upload className="h-4 w-4" /> {t('filesHub.upload')}</Button>}
      />

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t('documents.files'), value: number.format(summary.files), icon: ViewIcon },
          { label: t('adminContent.storageUsed'), value: formatBytes(summary.bytes, locale), icon: Cloud },
          { label: t('filesHub.secure'), value: number.format(summary.secure), icon: Lock },
          { label: t('documents.shared'), value: number.format(summary.shared), icon: Share2 },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand-text"><s.icon className="h-5 w-5" /></span>
            <div><div className="text-lg font-bold">{s.value}</div><div className="text-xs text-muted">{s.label}</div></div>
          </div>
        ))}
      </div>

      {/* Folders */}
      {(folders.length > 0 || folderFilter) && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => { setSelectedFolder(null); setQuery(''); }} aria-pressed={folderFilter === null}
            className={cn('rounded-xl border px-3 py-1.5 text-sm transition hover:bg-elevated/40', folderFilter === null ? 'border-brand/50 bg-brand/10 text-brand-text' : 'border-border bg-surface/40')}>
            {t('documents.allFiles')}
          </button>
          {folders.map((f) => (
            <button key={f.name === null ? 'uncategorized' : `category:${f.name}`}
              onClick={() => { setSelectedFolder({ familyId, view, category: f.name }); setQuery(''); }}
              aria-pressed={folderFilter !== null && folderFilter.category === f.name}
              className={cn('flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm transition hover:bg-elevated/40', folderFilter !== null && folderFilter.category === f.name ? 'border-brand/50 bg-brand/10 text-brand-text' : 'border-border bg-surface/40')}>
              <span className="font-medium">{f.name === null ? t('filesHubModule.uncategorized') : f.name}</span>
              <span className="text-xs text-muted">{number.format(f.count)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={query} inputMode="search" enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} placeholder={t('filesHubModule.searchPlaceholder', { view: viewTitle })} className="pl-9" aria-label={t('filesHub.searchFiles')} />
        </div>
        <div className="relative">
          <Button variant="outline" onClick={() => setSortOpen((o) => !o)}>{t('filesHub.sort')} <ChevronDown className="h-3.5 w-3.5" /></Button>
          {sortOpen && (
            <>
              {/* Presentational; the keyboard path is Escape, bound above. */}
                  {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                  <div aria-hidden="true" className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg">
                {([['recent', 'filesHubModule.sortRecent'], ['name', 'filesHubModule.sortName'], ['size', 'filesHubModule.sortLargest']] as const).map(([k, labelKey]) => (
                  <button key={k} onClick={() => { setSort(k); setSortOpen(false); }}
                    className={cn('block w-full px-3 py-2 text-left text-xs hover:bg-surface', sort === k && 'text-brand-text font-semibold')}>{t(labelKey)}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* File grid */}
      {visible.length === 0 ? (
        <EmptyState icon={ViewIcon} title={filtered ? t('filesHubModule.noMatches') : t('filesHubModule.emptyView', { view: viewTitle })}
          description={filtered ? t('filesHubModule.searchHint') : t('filesHubModule.uploadHint')}
          action={!filtered ? <Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" /> {t('filesHub.upload')}</Button> : undefined} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((d) => {
            const kind = fileKind(d.mime_type, d.title);
            const Icon = KIND_ICON[kind] ?? FileIcon;
            const full = byId.get(d.id)!;
            return (
              <div key={d.id} className="group flex flex-col rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start justify-between">
                  <span className={cn('grid h-11 w-11 place-items-center rounded-xl', KIND_TONE[kind])}><Icon className="h-5 w-5" /></span>
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => toggleFavorite(d.id)} aria-label={t(d.is_favorite ? 'filesHubModule.removeFavorite' : 'filesHubModule.addFavorite')}
                      className={cn('rounded-lg p-1.5 transition hover:bg-elevated', d.is_favorite ? 'text-amber-400' : 'text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100')}>
                      <Star className={cn('h-4 w-4', d.is_favorite && 'fill-amber-400')} />
                    </button>
                    {manager && (
                      <button onClick={() => toggleSecure(d.id)} aria-label={t(d.is_secure ? 'filesHubModule.moveShared' : 'filesHubModule.moveVault')}
                        className="rounded-lg p-1.5 text-muted opacity-100 sm:opacity-0 transition hover:bg-elevated hover:text-fg sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100">
                        {d.is_secure ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 min-w-0">
                  <p className="truncate text-sm font-semibold" title={d.title}>{d.title}</p>
                  <p className="text-xs text-muted">{d.category?.trim() || t('filesHubModule.uncategorized')} · {formatBytes(d.size_bytes, locale)}</p>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                  {d.is_secure && <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-brand-text"><Lock className="h-2.5 w-2.5" /> {t('filesHub.secure')}</span>}
                  <span>{displayDate(full.created_at, fmtDate)}</span>
                </div>
                <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => download(d.id)} loading={busy === d.id}>
                    <Download className="h-3.5 w-3.5" /> {t('filesHub.open')}
                  </Button>
                  <button onClick={() => remove(d.id)} disabled={busy === d.id} aria-label={t('filesHubModule.deleteFile', { name: d.title })}
                    className="rounded-lg p-2 text-muted transition hover:bg-elevated hover:text-rose-400 disabled:opacity-50">
                    {busy === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upload modal */}
      <Modal open={open} title={t('filesHubModule.uploadTitle', { view: viewTitle })} onClose={() => { setOpen(false); setFile(null); }}>
        <form onSubmit={upload} className="space-y-4">
          <Field label={t('filesHub.file')} required>
            {(id) => (
              <div>
                <input ref={fileRef} id={id} type="file" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name); }} />
                <button type="button" onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm text-muted hover:border-brand/50 hover:text-fg">
                  <Upload className="h-4 w-4" />
                  {file ? `${file.name} · ${formatBytes(file.size, locale)}` : t('filesHubModule.chooseFile', { limit: DOCUMENT_MAX_MB })}
                </button>
              </div>
            )}
          </Field>
          <Field label={t('filesHub.name')} required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('documents.eGPassportEmmaPdf')} />}</Field>
          <Field label={t('filesHub.folder')}>{(id) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('filesHub.eGTravelSchoolFinances')} />}</Field>
          {view === 'vault' && <p className="flex items-center gap-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" /> {t('filesHub.uploadedHereThisFileIsAdded')}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => { setOpen(false); setFile(null); }}>{t('filesHub.cancel')}</Button>
            <Button type="submit" loading={saving}>{saving ? t('filesHubModule.uploading') : t('filesHub.upload')}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
