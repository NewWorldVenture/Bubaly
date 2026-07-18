'use client';

import { useMemo, useRef, useState } from 'react';
import {
  Upload, Search, Download, Trash2, Star, Lock, LockOpen, Cloud, Share2,
  FileText, FileImage, FileSpreadsheet, FileVideo, FileAudio, FileArchive, File as FileIcon,
  ChevronDown, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { fmtDate } from '@/lib/utils/format';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument } from '@/lib/storage/documents';
import {
  VIEW_META, filterByView, searchDocs, sortDocs, groupByCategory, storageSummary, formatBytes, fileKind,
  type FileView, type SortKey, type DocLike,
} from '@/lib/files/overview';
import type { Tables } from '@/lib/database.types';

type Document = Tables<'documents'>;

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
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const meta = VIEW_META[view];
  const ViewIcon = VIEW_ICON[view];

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Document>({
    table: 'documents', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('documents').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const byId = useMemo(() => new Map(data.map((d) => [d.id, d])), [data]);
  const scoped = useMemo(() => filterByView(data.map(toDocLike), view), [data, view]);
  const visible = useMemo(() => sortDocs(searchDocs(scoped, query), sort), [scoped, query, sort]);
  const summary = useMemo(() => storageSummary(scoped), [scoped]);
  const folders = useMemo(() => groupByCategory(scoped), [scoped]);

  async function download(id: string) {
    const d = byId.get(id); if (!d) return;
    setBusy(id);
    const { url, error: err } = await getDocumentSignedUrl(createClient(), d.storage_path);
    setBusy(null);
    if (err || !url) return toastError(err ?? 'Could not open the file');
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function remove(id: string) {
    const d = byId.get(id); if (!d) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete "${d.title}"? This can't be undone.`)) return;
    setBusy(id);
    const sb = createClient();
    if (d.storage_path) await removeFamilyDocument(sb, d.storage_path);
    const { error: err } = await sb.from('documents').delete().eq('id', id);
    setBusy(null);
    if (err) return toastError(describeDbError(err));
    success('File deleted'); refresh();
  }

  async function toggleSecure(id: string) {
    const d = byId.get(id); if (!d) return;
    setBusy(id);
    const { error: err } = await createClient().from('documents').update({ is_secure: !d.is_secure }).eq('id', id);
    setBusy(null);
    if (err) return toastError(describeDbError(err));
    success(d.is_secure ? 'Moved to Shared Files' : 'Moved to Secure Vault'); refresh();
  }

  async function toggleFavorite(id: string) {
    const d = byId.get(id); if (!d) return;
    const { error: err } = await createClient().from('documents').update({ is_favorite: !d.is_favorite }).eq('id', id);
    if (err) return toastError(describeDbError(err));
    refresh();
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return toastError('Choose a file to upload');
    if (!title.trim()) return toastError('Add a name for this file');
    setSaving(true);
    const sb = createClient();
    const folder = category.trim() || meta.folder;
    const { path, error: upErr } = await uploadFamilyDocument(sb, { familyId, folder, file });
    if (upErr || !path) { setSaving(false); return toastError(upErr ?? 'Upload failed'); }
    const { error: err } = await sb.from('documents').insert({
      family_id: familyId, title: title.trim(), category: category.trim() || null,
      storage_path: path, mime_type: file.type || null, size_bytes: file.size,
      is_secure: view === 'vault', created_by: userId,
    });
    setSaving(false);
    if (err) { await removeFamilyDocument(sb, path); return toastError(describeDbError(err)); }
    success('File uploaded');
    setOpen(false); setTitle(''); setCategory(''); setFile(null); refresh();
  }

  if (loading) return <SkeletonList count={6} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load files'} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={meta.title}
        description={meta.description}
        action={<Button onClick={() => { setTitle(''); setCategory(''); setFile(null); setOpen(true); }}><Upload className="h-4 w-4" /> Upload</Button>}
      />

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Files', value: String(summary.files), icon: ViewIcon },
          { label: 'Storage used', value: formatBytes(summary.bytes), icon: Cloud },
          { label: 'Secure', value: String(summary.secure), icon: Lock },
          { label: 'Shared', value: String(summary.shared), icon: Share2 },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand-text"><s.icon className="h-5 w-5" /></span>
            <div><div className="text-lg font-bold">{s.value}</div><div className="text-xs text-muted">{s.label}</div></div>
          </div>
        ))}
      </div>

      {/* Folders */}
      {folders.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {folders.map((f) => (
            <button key={f.name} onClick={() => setQuery(f.name)}
              className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-1.5 text-sm transition hover:bg-elevated/40">
              <span className="font-medium">{f.name}</span>
              <span className="text-xs text-muted">{f.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${meta.title.toLowerCase()}`} className="pl-9" aria-label="Search files" />
        </div>
        <div className="relative">
          <Button variant="outline" onClick={() => setSortOpen((o) => !o)}>Sort <ChevronDown className="h-3.5 w-3.5" /></Button>
          {sortOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
              <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg">
                {([['recent', 'Most recent'], ['name', 'Name (A–Z)'], ['size', 'Largest']] as const).map(([k, l]) => (
                  <button key={k} onClick={() => { setSort(k); setSortOpen(false); }}
                    className={cn('block w-full px-3 py-2 text-left text-xs hover:bg-surface', sort === k && 'text-brand-text font-semibold')}>{l}</button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* File grid */}
      {visible.length === 0 ? (
        <EmptyState icon={ViewIcon} title={query ? 'No matching files' : `No files in ${meta.title} yet`}
          description={query ? 'Try a different search.' : 'Upload a file to get started.'}
          action={!query ? <Button onClick={() => setOpen(true)}><Upload className="h-4 w-4" /> Upload</Button> : undefined} />
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
                    <button onClick={() => toggleFavorite(d.id)} aria-label={d.is_favorite ? 'Unfavorite' : 'Favorite'}
                      className={cn('rounded-lg p-1.5 transition hover:bg-elevated', d.is_favorite ? 'text-amber-400' : 'text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100')}>
                      <Star className={cn('h-4 w-4', d.is_favorite && 'fill-amber-400')} />
                    </button>
                    <button onClick={() => toggleSecure(d.id)} aria-label={d.is_secure ? 'Move to shared' : 'Move to vault'}
                      className="rounded-lg p-1.5 text-muted opacity-0 transition hover:bg-elevated hover:text-fg group-hover:opacity-100">
                      {d.is_secure ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="mt-3 min-w-0">
                  <p className="truncate text-sm font-semibold" title={d.title}>{d.title}</p>
                  <p className="text-xs text-muted">{d.category?.trim() || 'General'} · {formatBytes(d.size_bytes)}</p>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                  {d.is_secure && <span className="inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-brand-text"><Lock className="h-2.5 w-2.5" /> Secure</span>}
                  <span>{fmtDate(full.created_at)}</span>
                </div>
                <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-3">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => download(d.id)} loading={busy === d.id}>
                    <Download className="h-3.5 w-3.5" /> Open
                  </Button>
                  <button onClick={() => remove(d.id)} disabled={busy === d.id} aria-label={`Delete ${d.title}`}
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
      <Modal open={open} title={`Upload to ${meta.title}`} onClose={() => { setOpen(false); setFile(null); }}>
        <form onSubmit={upload} className="space-y-4">
          <Field label="File" required>
            {(id) => (
              <div>
                <input ref={fileRef} id={id} type="file" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name); }} />
                <button type="button" onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left text-sm text-muted hover:border-brand/50 hover:text-fg">
                  <Upload className="h-4 w-4" />
                  {file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose a file (max 25 MB)'}
                </button>
              </div>
            )}
          </Field>
          <Field label="Name" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Passport.pdf" />}</Field>
          <Field label="Folder">{(id) => <Input id={id} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Travel, School, Finances" />}</Field>
          {view === 'vault' && <p className="flex items-center gap-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" /> Uploaded here, this file is added to the Secure Vault.</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => { setOpen(false); setFile(null); }}>Cancel</Button>
            <Button type="submit" loading={saving}>{saving ? 'Uploading…' : 'Upload'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
