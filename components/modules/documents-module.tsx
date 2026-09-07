'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { firstName } from '@/lib/utils/format';
import {
  ChevronLeft, ChevronRight, Download, File, FileArchive, FileText, Folder, FolderPlus,
  Image as ImageIcon, LayoutGrid, List, Lock, MoreHorizontal, Plus, ScanLine,
  Search, Sparkles, Star, Table as TableIcon, Trash2, Upload, Video,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { uploadFamilyDocument, getDocumentSignedUrl, removeFamilyDocument, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_MB } from '@/lib/storage/documents';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { preOpenWindow } from '@/lib/utils/open-url';
import { useTranslations } from '@/components/i18n/locale-provider';

type Document = Tables<'documents'>;

// ── Formatting helpers ──────────────────────────────────────────────────────
const GB = 1024 ** 3;
const STORAGE_LIMIT_GB = 10;
const STORAGE_LIMIT = STORAGE_LIMIT_GB * GB;

function fmtSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}
function fmtGb(bytes: number): string { return `${(bytes / GB).toFixed(1)} GB`; }
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return fmtDate(iso);
}

// ── File-type detection → icon + color, and coarse storage group ────────────
type FileMeta = { Icon: typeof FileText; color: string; tint: string };
function ext(title: string, mime: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(title);
  if (m) return m[1].toLowerCase();
  if (mime?.includes('pdf')) return 'pdf';
  if (mime?.startsWith('image/')) return mime.split('/')[1] ?? 'png';
  if (mime?.startsWith('video/')) return mime.split('/')[1] ?? 'mp4';
  return '';
}
function fileMeta(title: string, mime: string | null): FileMeta {
  const e = ext(title, mime);
  if (e === 'pdf') return { Icon: FileText, color: 'text-rose-400', tint: 'bg-rose-500/15' };
  if (['doc', 'docx', 'rtf', 'txt', 'pages'].includes(e)) return { Icon: FileText, color: 'text-blue-400', tint: 'bg-blue-500/15' };
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(e)) return { Icon: TableIcon, color: 'text-emerald-400', tint: 'bg-emerald-500/15' };
  if (['ppt', 'pptx', 'key'].includes(e)) return { Icon: FileText, color: 'text-orange-400', tint: 'bg-orange-500/15' };
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'].includes(e) || mime?.startsWith('image/')) return { Icon: ImageIcon, color: 'text-sky-400', tint: 'bg-sky-500/15' };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e) || mime?.startsWith('video/')) return { Icon: Video, color: 'text-violet-400', tint: 'bg-violet-500/15' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return { Icon: FileArchive, color: 'text-amber-400', tint: 'bg-amber-500/15' };
  return { Icon: File, color: 'text-muted', tint: 'bg-surface/60' };
}
type StorageGroup = 'documents' | 'photos' | 'videos' | 'other';
function storageGroup(title: string, mime: string | null): StorageGroup {
  const e = ext(title, mime);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'svg'].includes(e) || mime?.startsWith('image/')) return 'photos';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e) || mime?.startsWith('video/')) return 'videos';
  if (['pdf', 'doc', 'docx', 'rtf', 'txt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'pages', 'numbers', 'key'].includes(e)) return 'documents';
  return 'other';
}
const STORAGE_META: Record<StorageGroup, { label: string; color: string }> = {
  documents: { label: 'Documents', color: '#60a5fa' },
  photos: { label: 'Photos', color: '#34d399' },
  videos: { label: 'Videos', color: '#a78bfa' },
  other: { label: 'Other', color: '#f472b6' },
};

// Deterministic folder color from its name (so the same folder is always the
// same hue), matching the multi-colored folders in the design.
const FOLDER_PALETTE = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#f472b6', '#38bdf8', '#f87171'];
function folderColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return FOLDER_PALETTE[h % FOLDER_PALETTE.length];
}
function folderLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const TYPE_FILTERS: { value: 'all' | StorageGroup; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'documents', label: 'Documents' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'other', label: 'Other' },
];
const SORTS = [
  { value: 'modified', label: 'Last Modified' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'size', label: 'Largest first' },
  { value: 'oldest', label: 'Oldest first' },
] as const;
type SortKey = (typeof SORTS)[number]['value'];

const PAGE_SIZE = 10;

export function DocumentsModule() {
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'general', member_id: '', expires_at: '' });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | StorageGroup>('all');
  const [sort, setSort] = useState<SortKey>('modified');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showAllFolders, setShowAllFolders] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmDoc, setConfirmDoc] = useState<Document | null>(null);
  const [favPending, setFavPending] = useState<Record<string, boolean>>({});

  const { data, loading, error, refresh } = useRealtimeQuery<Document>({
    table: 'documents', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('documents').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberByUser = useMemo(() => new Map(members.filter((m) => m.user_id).map((m) => [m.user_id as string, m])), [members]);
  const activeMembers = useMemo(() => members.filter((m) => m.is_active), [members]);

  const isFav = (d: Document) => favPending[d.id] ?? d.is_favorite;

  // Folders derived from the categories present, with counts + contributors.
  const folders = useMemo(() => {
    const map = new Map<string, { count: number; contributors: Set<string> }>();
    for (const d of data) {
      const cat = d.category?.trim() || 'general';
      const entry = map.get(cat) ?? { count: 0, contributors: new Set<string>() };
      entry.count += 1;
      if (d.created_by) entry.contributors.add(d.created_by);
      map.set(cat, entry);
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, count: v.count, contributors: [...v.contributors] }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // Storage breakdown by coarse type group.
  const storage = useMemo(() => {
    const by: Record<StorageGroup, number> = { documents: 0, photos: 0, videos: 0, other: 0 };
    for (const d of data) by[storageGroup(d.title, d.mime_type)] += d.size_bytes ?? 0;
    const used = by.documents + by.photos + by.videos + by.other;
    return { by, used };
  }, [data]);
  const usedPct = Math.min((storage.used / STORAGE_LIMIT) * 100, 100);

  // Donut arcs for the storage overview.
  const circ = 251.2;
  const storageArcs = useMemo(() => {
    let offset = 0;
    const order: StorageGroup[] = ['documents', 'photos', 'videos', 'other'];
    return order.map((g) => {
      const pct = storage.used > 0 ? storage.by[g] / storage.used : 0;
      const dash = pct * circ;
      const arc = { key: g, dash, offset: circ - offset, color: STORAGE_META[g].color };
      offset += dash;
      return arc;
    });
  }, [storage]);

  // Filter → search → sort.
  const filtered = useMemo(() => {
    let rows = data;
    if (folderFilter) rows = rows.filter((d) => (d.category?.trim() || 'general') === folderFilter);
    if (typeFilter !== 'all') rows = rows.filter((d) => storageGroup(d.title, d.mime_type) === typeFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((d) => d.title.toLowerCase().includes(q) || (d.category ?? '').toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      switch (sort) {
        case 'name': return a.title.localeCompare(b.title);
        case 'size': return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
        case 'oldest': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        default: return new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime();
      }
    });
  }, [data, folderFilter, typeFilter, query, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Reset to page 1 whenever the result set changes shape.
  useEffect(() => { setPage(1); }, [folderFilter, typeFilter, query, sort]);

  const recentActivity = useMemo(() =>
    [...data].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 5),
    [data]);

  // ── Actions ───────────────────────────────────────────────────────────────
  async function toggleFavorite(doc: Document) {
    const next = !isFav(doc);
    setFavPending((p) => ({ ...p, [doc.id]: next }));
    const sb = createClient();
    const { error: err } = await sb.from('documents').update({ is_favorite: next }).eq('id', doc.id);
    if (err) {
      setFavPending((p) => { const { [doc.id]: _drop, ...rest } = p; return rest; });
      toastError(describeDbError(err));
      return;
    }
    refresh();
  }

  async function download(doc: Document) {
    setMenuId(null);
    if (!doc.storage_path) { toastError(tr('documentsModule.noFileAttachedToThis')); return; }
    const tab = preOpenWindow(); // sync, inside the tap gesture (iOS popup blocker)
    const sb = createClient();
    const { url, error: err } = await getDocumentSignedUrl(sb, doc.storage_path);
    if (err || !url) { tab.cancel(); toastError(err ?? 'Could not open this file'); return; }
    tab.navigate(url);
  }

  async function remove(doc: Document) {
    setConfirmDoc(null);
    const sb = createClient();
    if (doc.storage_path) await removeFamilyDocument(sb, doc.storage_path);
    const { error: err } = await sb.from('documents').delete().eq('id', doc.id);
    if (err) { toastError(describeDbError(err)); return; }
    success(tr('documentsModule.fileDeleted')); refresh();
  }

  function pickFile(f: File | null) {
    // Fail fast at pick time (before the form) with the real bucket limit.
    if (f && f.size > DOCUMENT_MAX_BYTES) {
      toastError(`“${f.name}” is too large (max ${DOCUMENT_MAX_MB} MB).`);
      return;
    }
    setFile(f);
    if (f && !form.title) setForm((prev) => ({ ...prev, title: f.name }));
    if (f) setOpen(true);
  }

  async function save() {
    if (!form.title || !file) { toastError(tr('documentsModule.chooseAFileAndName')); return; }
    setSaving(true);
    const sb = createClient();
    const folder = form.category.trim() || 'general';
    const { path, error: upErr } = await uploadFamilyDocument(sb, { familyId, folder, file });
    if (upErr || !path) { setSaving(false); toastError(upErr ?? 'Upload failed'); return; }
    const { error: err } = await sb.from('documents').insert({
      family_id: familyId, title: form.title, category: folder,
      member_id: form.member_id || null, created_by: userId,
      storage_path: path, size_bytes: file.size, mime_type: file.type || null,
      expires_at: form.expires_at || null,
    });
    setSaving(false);
    if (err) { await removeFamilyDocument(sb, path); toastError(tr('documentsModule.failedToSaveFile')); return; }
    success(tr('documentsModule.fileUploaded'));
    setOpen(false); setForm({ title: '', category: 'general', member_id: '', expires_at: '' }); setFile(null); refresh();
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const folderCards = showAllFolders ? folders : folders.slice(0, 6);
  const hasFilters = Boolean(query || typeFilter !== 'all' || folderFilter);

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title={tr('documents.files')}
          description={tr('documentsModule.storeOrganizeAndShareImportant')}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => { setForm((f) => ({ ...f, title: '', category: 'general' })); setFile(null); setOpen(true); }}><Upload className="h-4 w-4" /> {tr('documents.upload')}</Button>
              <Button variant="secondary" onClick={() => { setForm((f) => ({ ...f, title: '', category: '' })); setFile(null); setOpen(true); }}><FolderPlus className="h-4 w-4" /> {tr('documents.newFolder')}</Button>
              <AiInsight kind="documents" iconOnly />
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr('documents.searchFiles')}
                  aria-label={tr('documents.searchFiles')}
                  className="h-9 w-40 rounded-xl border border-border bg-surface/60 pl-9 pr-3 text-sm outline-none placeholder:text-muted focus:border-brand/50 sm:w-56"
                />
              </div>
            </div>
          }
        />

        {/* Folders */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('documents.folders')}</h2>
            {folders.length > 6 && (
              <button onClick={() => setShowAllFolders((v) => !v)} className="flex items-center gap-0.5 text-xs font-semibold text-brand-text hover:underline">
                {showAllFolders ? 'Show less' : 'View all folders'} <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {folders.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{tr('documents.noFoldersYetUploadAFile')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {folderCards.map((f) => {
                const active = folderFilter === f.name;
                const color = folderColor(f.name);
                return (
                  <button
                    key={f.name}
                    onClick={() => setFolderFilter(active ? null : f.name)}
                    className={cn('flex flex-col items-center gap-2 rounded-2xl border p-4 text-center transition hover:bg-elevated',
                      active ? 'border-brand bg-brand/5' : 'border-border bg-surface/20')}
                  >
                    <Folder className="h-12 w-12" style={{ color }} fill={color} strokeWidth={1} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{folderLabel(f.name)}</p>
                      <p className="text-xs text-muted">{f.count} item{f.count === 1 ? '' : 's'}</p>
                    </div>
                    <div className="flex -space-x-1.5">
                      {f.contributors.slice(0, 3).map((uid) => {
                        const m = memberByUser.get(uid);
                        return <Avatar key={uid} name={m?.display_name ?? '—'} color={m?.color} size={20} className="ring-2 ring-surface" />;
                      })}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* All Files */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="font-semibold">
              {tr('documents.allFiles')}
              {folderFilter && (
                <button onClick={() => setFolderFilter(null)} className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand-text">
                  {folderLabel(folderFilter)} ✕
                </button>
              )}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label={tr('documents.filterByType')} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | StorageGroup)} className="h-9 w-auto text-sm">
                {TYPE_FILTERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
              <Select aria-label={tr('documents.sort')} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 w-auto text-sm">
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
              <div className="inline-flex items-center rounded-lg border border-border p-0.5">
                <button onClick={() => setView('list')} aria-label={tr('documents.listView')} className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'list' ? 'bg-elevated text-fg' : 'text-muted')}><List className="h-4 w-4" /></button>
                <button onClick={() => setView('grid')} aria-label={tr('documents.gridView')} className={cn('grid h-7 w-7 place-items-center rounded-md', view === 'grid' ? 'bg-elevated text-fg' : 'text-muted')}><LayoutGrid className="h-4 w-4" /></button>
              </div>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="py-14 text-center">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-surface/40"><File className="h-8 w-8 text-muted/60" /></div>
              <p className="font-semibold text-muted">{hasFilters ? 'No files match your filters' : 'No files yet'}</p>
              <p className="mt-1 text-sm text-muted/60">{hasFilters ? 'Try clearing the search or filters.' : 'Upload your first file to get started.'}</p>
              {!hasFilters && <Button onClick={() => setOpen(true)} className="mt-5"><Plus className="h-4 w-4" /> {tr('documents.uploadFile')}</Button>}
            </div>
          ) : view === 'list' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted">
                    <th className="py-2.5 pr-4 text-left font-medium">{tr('documents.name')}</th>
                    <th className="hidden py-2.5 pr-4 text-left font-medium sm:table-cell">{tr('documents.shared')}</th>
                    <th className="hidden py-2.5 pr-4 text-left font-medium md:table-cell">{tr('documents.modified')}</th>
                    <th className="py-2.5 pr-4 text-left font-medium">{tr('documents.size')}</th>
                    <th className="w-16 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {pageRows.map((doc) => {
                    const meta = fileMeta(doc.title, doc.mime_type);
                    const uploader = doc.created_by ? memberByUser.get(doc.created_by) : undefined;
                    const owner = doc.member_id ? memberById.get(doc.member_id) : undefined;
                    return (
                      <tr key={doc.id} className="group hover:bg-elevated/40">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-3">
                            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', meta.tint)}><meta.Icon className={cn('h-4 w-4', meta.color)} /></span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{doc.title}</p>
                              <p className="truncate text-xs text-muted">{folderLabel(doc.category?.trim() || 'General')}</p>
                            </div>
                          </div>
                        </td>
                        <td className="hidden py-3 pr-4 sm:table-cell">
                          {owner ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Lock className="h-3.5 w-3.5" /> {firstName(owner.display_name)}</span>
                          ) : (
                            <div className="flex -space-x-1.5">
                              {activeMembers.slice(0, 4).map((m) => <Avatar key={m.id} name={m.display_name} color={m.color} size={22} className="ring-2 ring-surface" />)}
                            </div>
                          )}
                        </td>
                        <td className="hidden py-3 pr-4 md:table-cell">
                          <p className="text-xs">{fmtDate(doc.updated_at ?? doc.created_at)}</p>
                          {uploader && <p className="text-[11px] text-muted">by {firstName(uploader.display_name)}</p>}
                        </td>
                        <td className="py-3 pr-4 text-xs text-muted tabular-nums">{fmtSize(doc.size_bytes)}</td>
                        <td className="py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => toggleFavorite(doc)} aria-label={isFav(doc) ? 'Unstar' : 'Star'} className="grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-elevated">
                              <Star className={cn('h-4 w-4', isFav(doc) && 'fill-amber-400 text-amber-400')} />
                            </button>
                            <div className="relative">
                              <button onClick={() => setMenuId(menuId === doc.id ? null : doc.id)} aria-label={tr('documents.moreActions')} className="grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-elevated">
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                              {menuId === doc.id && (
                                <>
                                  <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setMenuId(null)} tabIndex={-1} />
                                  <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                                    <button onClick={() => download(doc)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"><Download className="h-4 w-4" /> {tr('documents.download')}</button>
                                    <button onClick={() => { setMenuId(null); toggleFavorite(doc); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated"><Star className="h-4 w-4" /> {isFav(doc) ? 'Unstar' : 'Star'}</button>
                                    <button onClick={() => { setMenuId(null); setConfirmDoc(doc); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /> {tr('documents.delete')}</button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {pageRows.map((doc) => {
                const meta = fileMeta(doc.title, doc.mime_type);
                return (
                  <div key={doc.id} className="group relative rounded-2xl border border-border bg-surface/20 p-4">
                    <button onClick={() => toggleFavorite(doc)} aria-label={isFav(doc) ? 'Unstar' : 'Star'} className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-elevated">
                      <Star className={cn('h-4 w-4', isFav(doc) && 'fill-amber-400 text-amber-400')} />
                    </button>
                    <span className={cn('grid h-12 w-12 place-items-center rounded-xl', meta.tint)}><meta.Icon className={cn('h-6 w-6', meta.color)} /></span>
                    <p className="mt-3 truncate text-sm font-semibold">{doc.title}</p>
                    <p className="truncate text-xs text-muted">{folderLabel(doc.category?.trim() || 'General')}</p>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted">
                      <span>{fmtSize(doc.size_bytes)}</span>
                      <span>{fmtDate(doc.updated_at ?? doc.created_at)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {filtered.length > PAGE_SIZE && (
            <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-border pt-4 sm:flex-row">
              <p className="text-xs text-muted">
                {tr('documents.showing')} {(safePage - 1) * PAGE_SIZE + 1} to {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} files
              </p>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1} aria-label={tr('documents.previousPage')} className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted disabled:opacity-40 hover:bg-elevated"><ChevronLeft className="h-4 w-4" /></button>
                {pageNumbers(safePage, totalPages).map((p, i) => (
                  p === '…'
                    ? <span key={`e${i}`} className="px-1.5 text-sm text-muted">…</span>
                    : <button key={p} onClick={() => setPage(p as number)} className={cn('h-8 min-w-8 rounded-lg px-2 text-sm font-medium', p === safePage ? 'bg-brand text-brand-fg' : 'border border-border text-muted hover:bg-elevated')}>{p}</button>
                ))}
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} aria-label={tr('documents.nextPage')} className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted disabled:opacity-40 hover:bg-elevated"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right rail */}
      <aside className="module-sidebar flex flex-col gap-5">
        {/* Storage Overview */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('documents.storageOverview')}</h2>
            <span className="text-xs text-muted">{fmtGb(STORAGE_LIMIT)} plan</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="relative h-28 w-28 shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                {storage.used > 0 && storageArcs.map((a) => a.dash > 0 && (
                  <circle key={a.key} cx="50" cy="50" r="40" fill="none" stroke={a.color} strokeWidth="12" strokeDasharray={`${a.dash} ${circ}`} strokeDashoffset={a.offset} />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="text-xl font-black tabular-nums">{fmtGb(storage.used)}</span>
                <span className="text-[10px] text-muted">of {fmtGb(STORAGE_LIMIT)} used</span>
              </div>
            </div>
            <div className="flex-1 space-y-1.5">
              {(['documents', 'photos', 'videos', 'other'] as StorageGroup[]).map((g) => (
                <div key={g} className="flex items-center gap-2 text-xs">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STORAGE_META[g].color }} />
                  <span className="flex-1 text-muted">{STORAGE_META[g].label}</span>
                  <span className="font-semibold tabular-nums">{fmtGb(storage.by[g])}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 h-2 rounded-full bg-border">
            <div className="h-full rounded-full bg-brand" style={{ width: `${usedPct}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-muted">
            <span>{usedPct.toFixed(0)}{tr('documents.used')}</span>
            <span>{fmtGb(Math.max(STORAGE_LIMIT - storage.used, 0))} free</span>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">{tr('documents.quickActions')}</h2>
          <div className="space-y-1.5">
            {[
              { icon: Upload, label: 'Upload Files', onClick: () => { setForm((f) => ({ ...f, title: '', category: 'general' })); setFile(null); setOpen(true); } },
              { icon: FolderPlus, label: 'Create New Folder', onClick: () => { setForm((f) => ({ ...f, title: '', category: '' })); setFile(null); setOpen(true); } },
              { icon: ScanLine, label: 'Scan Document', onClick: () => scanInputRef.current?.click() },
            ].map(({ icon: Icon, label, onClick }) => (
              <button key={label} onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-elevated">
                <Icon className="h-4 w-4 text-muted" /> {label}
              </button>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">{tr('documents.recentActivity')}</h2>
            <AiInsight kind="documents" label={tr('documents.viewAll')} variant="ghost" className="!px-0 text-xs text-brand-text" />
          </div>
          {recentActivity.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">{tr('documents.noRecentActivity')}</p>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((doc) => {
                const uploader = doc.created_by ? memberByUser.get(doc.created_by) : undefined;
                const meta = fileMeta(doc.title, doc.mime_type);
                const grp = storageGroup(doc.title, doc.mime_type);
                const action = grp === 'photos' || grp === 'videos' ? 'uploaded' : doc.member_id ? 'added' : 'shared';
                return (
                  <div key={doc.id} className="flex items-start gap-2.5">
                    <Avatar name={uploader?.display_name ?? 'Family'} color={uploader?.color} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-tight">
                        <span className="font-semibold">{uploader ? firstName(uploader.display_name) : 'Someone'}</span>
                        <span className="text-muted"> {action} </span>
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded', meta.tint)}><meta.Icon className={cn('h-2.5 w-2.5', meta.color)} /></span>
                        <p className="truncate text-xs font-medium">{doc.title}</p>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted">{timeAgo(doc.created_at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* AI Document Assistant */}
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15"><Sparkles className="h-6 w-6 text-brand-text" /></div>
          <h3 className="font-bold">{tr('documents.aiDocumentAssistant')}</h3>
          <p className="mt-2 text-xs leading-5 text-muted">{tr('documents.summarizeExtractKeyInfoAndGet')}</p>
          <AiInsight kind="documents" label={tr('documents.askAi')} variant="primary" className="mt-4 w-full justify-center" />
        </div>
      </aside>

      {/* Hidden input for Scan (mobile camera) */}
      <input ref={scanInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />

      {/* Upload modal */}
      <Modal open={open} title={form.category === '' ? 'New Folder' : 'Upload File'} onClose={() => { setOpen(false); setFile(null); }}>
        <div className="space-y-4">
          <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !form.title) setForm((prev) => ({ ...prev, title: f.name })); }} />
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0] ?? null; setFile(f); if (f && !form.title) setForm((prev) => ({ ...prev, title: f.name })); }}
            className="cursor-pointer rounded-xl border-2 border-dashed border-border p-8 text-center transition hover:border-brand/50"
          >
            <Upload className="mx-auto mb-3 h-8 w-8 text-muted/60" />
            {file ? (
              <><p className="text-sm font-semibold">{file.name}</p><p className="mt-1 text-xs text-muted/60">{fmtSize(file.size)} {tr('documents.clickToChange')}</p></>
            ) : (
              <><p className="text-sm font-semibold text-muted">{tr('documents.dragAmpDropAFileHere')}</p><p className="mt-1 text-xs text-muted/60">{tr('documents.pdfImagesDocsVideoUpTo')} {DOCUMENT_MAX_MB} MB</p><span className="mt-4 inline-block rounded-lg border border-border px-4 py-2 text-xs font-semibold">{tr('documents.browseFiles')}</span></>
            )}
          </div>
          <Field label={tr('documents.fileName')}>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder={tr('documents.eGPassportEmmaPdf')} />}</Field>
          <Field label={tr('documents.folder')} hint={tr('documentsModule.typeANewNameTo')}>{(id) => (
            <>
              <Input id={id} list="folder-options" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} placeholder={tr('documents.eGSchoolFinancesVacation2025')} />
              <datalist id="folder-options">{folders.map((f) => <option key={f.name} value={f.name} />)}</datalist>
            </>
          )}</Field>
          <Field label={tr('documents.visibility')}>{(id) => (
            <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
              <option value="">{tr('documents.sharedWithFamily')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{tr('documents.private')} {m.display_name}</option>)}
            </Select>
          )}</Field>
          <Field label={tr('documents.expiresOptional')} hint={tr('documentsModule.forPassportsInsuranceRegistrationsBubaly')}>{(id) => <Input id={id} type="date" value={form.expires_at} onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))} />}</Field>
          <Button onClick={save} disabled={saving || !form.title || !file} loading={saving} className="w-full">{saving ? 'Uploading…' : 'Upload File'}</Button>
        </div>
      </Modal>

      {/* Delete confirmation */}
      <Modal open={!!confirmDoc} title={tr('documents.deleteFile')} onClose={() => setConfirmDoc(null)}>
        <div className="space-y-4">
          <p className="text-sm text-muted">{tr('documents.delete')} <span className="font-semibold text-fg">{confirmDoc?.title}</span>{tr('documents.thisPermanentlyRemovesTheFileAnd')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDoc(null)}>{tr('documents.cancel')}</Button>
            <Button variant="danger" onClick={() => confirmDoc && remove(confirmDoc)}>{tr('documents.delete')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// Compact page-number list with ellipses: 1 … p-1 p p+1 … N.
function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push('…');
  for (let p = start; p <= end; p++) out.push(p);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}
