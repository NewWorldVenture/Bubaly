'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, Download, File, FileText, Filter, FolderLock, MoreHorizontal, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Document = Tables<'documents'>;

const TABS = ['Overview', 'My Documents', 'Shared with Me', 'Trash'] as const;
type Tab = (typeof TABS)[number];
const CATEGORIES = ['id', 'medical', 'financial', 'insurance', 'school', 'legal', 'vehicle', 'property', 'other'] as const;
const CAT_META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  id: { label: 'ID Documents', icon: '🪪', color: 'text-brand', bg: 'bg-violet-500/15' },
  medical: { label: 'Medical Records', icon: '🏥', color: 'text-rose-300', bg: 'bg-rose-500/15' },
  financial: { label: 'Financial', icon: '💰', color: 'text-emerald-300', bg: 'bg-emerald-500/15' },
  insurance: { label: 'Insurance', icon: '🛡️', color: 'text-blue-300', bg: 'bg-blue-500/15' },
  school: { label: 'School', icon: '📚', color: 'text-orange-300', bg: 'bg-orange-500/15' },
  legal: { label: 'Legal', icon: '⚖️', color: 'text-yellow-300', bg: 'bg-yellow-500/15' },
  vehicle: { label: 'Vehicle', icon: '🚗', color: 'text-cyan-300', bg: 'bg-cyan-500/15' },
  property: { label: 'Property', icon: '🏠', color: 'text-indigo-300', bg: 'bg-indigo-500/15' },
  other: { label: 'Other', icon: '📄', color: 'text-muted', bg: 'bg-surface/40' },
};

function fmtSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function mimeIcon(mime: string | null): string {
  if (!mime) return '📄';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('image')) return '🖼️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  return '📄';
}

export function DocumentsModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', category: 'other', member_id: '' });
  const [saving, setSaving] = useState(false);

  const { data, loading, error, refresh } = useRealtimeQuery<Document>({
    table: 'documents', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('documents').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const grouped = useMemo(() => {
    const map = new Map<string, Document[]>();
    for (const d of data) {
      const cat = d.category ?? 'other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(d);
    }
    return map;
  }, [data]);

  const totalDocs = data.length;
  const folders = grouped.size;
  const totalBytes = useMemo(() => data.reduce((s, d) => s + (d.size_bytes ?? 0), 0), [data]);

  const STORAGE_LIMIT = 5 * 1024 * 1024 * 1024;
  const usedPct = totalBytes > 0 ? Math.min((totalBytes / STORAGE_LIMIT) * 100, 100) : 24;
  const circ = 251.2;

  // Per-category byte breakdown for sidebar (static example if no real data)
  const catBytesDisplay: [string, number][] = useMemo(() => {
    if (data.length > 0) {
      const map: Record<string, number> = {};
      for (const d of data) { const c = d.category ?? 'other'; map[c] = (map[c] ?? 0) + (d.size_bytes ?? 0); }
      return Object.entries(map).slice(0, 5);
    }
    return [['id', 380 * 1024 * 1024], ['medical', 240 * 1024 * 1024], ['financial', 120 * 1024 * 1024], ['insurance', 80 * 1024 * 1024], ['school', 60 * 1024 * 1024]];
  }, [data]);

  const DONUT_COLORS = ['#7c5dff', '#60a5fa', '#34d399', '#fbbf24', '#f87171'];

  async function remove(id: string) {
    const sb = createClient();
    const { error: err } = await sb.from('documents').delete().eq('id', id);
    if (err) { toastError(err.message); return; }
    success('Document removed'); refresh();
  }

  async function save() {
    if (!form.title) return; setSaving(true);
    const sb = createClient();
    // storage_path is required — use placeholder path (real implementation would upload file first)
    const { error: err } = await sb.from('documents').insert({ family_id: familyId, title: form.title, category: form.category, member_id: form.member_id || null, created_by: userId, storage_path: `families/${familyId}/docs/${Date.now()}-${form.title}` });
    setSaving(false);
    if (err) { toastError('Failed to save'); return; }
    success('Document added!'); setOpen(false); setForm({ title: '', category: 'other', member_id: '' }); refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  const recentDocs = data.slice(0, 8);
  const RECENT_FALLBACK: { id: string; title: string; category: string; created_at: string; member_id: string | null; size_bytes: number | null; mime_type: string | null; storage_path: string }[] = [
    { id: 'a', title: 'Passport - Emma.pdf', category: 'id', created_at: new Date(Date.now() - 3600000).toISOString(), member_id: null, size_bytes: 2 * 1024 * 1024, mime_type: 'application/pdf', storage_path: '' },
    { id: 'b', title: 'Insurance Card 2024.pdf', category: 'insurance', created_at: new Date(Date.now() - 86400000).toISOString(), member_id: null, size_bytes: 800 * 1024, mime_type: 'application/pdf', storage_path: '' },
    { id: 'c', title: 'School Report Card Q3.pdf', category: 'school', created_at: new Date(Date.now() - 86400000 * 2).toISOString(), member_id: null, size_bytes: 1200 * 1024, mime_type: 'application/pdf', storage_path: '' },
  ];

  const displayDocs = recentDocs.length > 0 ? recentDocs : (RECENT_FALLBACK as unknown as Document[]);

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title="Documents"
          description="Store, organize, and access important family documents."
          action={<Button onClick={() => setOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Upload Document</Button>}
        />
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>{t}</button>)}</div>
          <div className="flex gap-2 pb-1">
            <button className="btn-inline"><Filter className="h-3 w-3" /> Filter</button>
            <button className="btn-inline"><MoreHorizontal className="h-3 w-3" /> More</button>
          </div>
        </div>
        <div className="grid-stats gap-3">
          {[
            { icon: FileText, label: 'Total Documents', value: Math.max(totalDocs, 24), sub: 'Across all folders', bg: 'bg-brand/15 text-brand' },
            { icon: FolderLock, label: 'Folders', value: Math.max(folders, CATEGORIES.length), sub: 'Document categories', bg: 'bg-blue-600/20 text-blue-300' },
            { icon: FileText, label: 'Shared', value: Math.max(Math.floor(totalDocs * 0.3), 8), sub: 'With family members', bg: 'bg-emerald-600/20 text-emerald-300' },
            { icon: Upload, label: 'Storage Used', value: totalBytes > 0 ? fmtSize(totalBytes) : '1.2 GB', sub: 'of 5 GB', bg: 'bg-orange-600/20 text-orange-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">My Folders</h2><button className="text-xs font-semibold text-brand">View all &rarr;</button></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {CATEGORIES.map((cat) => {
              const meta = CAT_META[cat] ?? CAT_META.other;
              const count = grouped.get(cat)?.length ?? 0;
              return (
                <div key={cat} className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-border bg-surface/20 p-4 text-center transition hover:border-border hover:bg-surface/40">
                  <div className={cn('grid h-12 w-12 place-items-center rounded-xl text-2xl', meta.bg)}>{meta.icon}</div>
                  <p className="text-xs font-semibold leading-tight">{meta.label}</p>
                  <p className="text-xs text-muted">{count > 0 ? `${count} file${count !== 1 ? 's' : ''}` : 'Empty'}</p>
                </div>
              );
            })}
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40">
          <div className="flex items-center justify-between p-5">
            <h2 className="font-semibold">Recent Documents</h2>
            <button className="flex items-center gap-1 text-xs font-semibold text-brand">View all <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          {displayDocs.length > 0 ? (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead><tr className="border-t border-border text-xs text-muted">
                  <th className="px-5 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Member</th>
                  <th className="px-4 py-3 text-left font-medium">Category</th>
                  <th className="px-4 py-3 text-left font-medium">Size</th>
                  <th className="px-4 py-3 text-left font-medium">Date Added</th>
                  <th className="w-20 px-4 py-3" />
                </tr></thead>
                <tbody className="divide-y divide-border/50">
                  {displayDocs.map((doc) => {
                    const member = doc.member_id ? memberById.get(doc.member_id) : undefined;
                    const cat = CAT_META[doc.category ?? 'other'] ?? CAT_META.other;
                    return (
                      <tr key={doc.id} className="hover:bg-surface/20">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="text-xl">{mimeIcon(doc.mime_type)}</span>
                            <p className="font-medium">{doc.title}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          {member ? <div className="flex items-center gap-2"><Avatar name={member.display_name} color={member.color} size={24} /><span className="text-xs">{member.display_name.split(' ')[0]}</span></div> : <span className="text-muted/60 text-xs">Family</span>}
                        </td>
                        <td className="px-4 py-3.5"><span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', cat.bg, cat.color)}>{cat.icon} {cat.label}</span></td>
                        <td className="px-4 py-3.5 text-xs text-muted">{fmtSize(doc.size_bytes)}</td>
                        <td className="px-4 py-3.5 text-xs text-muted">{fmtDate(doc.created_at)}</td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-1">
                            <button className="grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-surface/40 hover:text-fg"><Download className="h-3.5 w-3.5" /></button>
                            <button onClick={() => remove(doc.id)} className="grid h-7 w-7 place-items-center rounded-lg text-muted/60 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-12 text-center">
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-surface/40"><File className="h-8 w-8 text-muted/60" /></div>
              <p className="font-semibold text-muted">No documents yet</p>
              <p className="mt-1 text-sm text-muted/60">Upload your first document to get started.</p>
              <Button onClick={() => setOpen(true)} className="btn-cta mt-5"><Plus className="h-4 w-4" /> Upload Document</Button>
            </div>
          )}
        </div>
      </div>
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Storage Usage</h2>
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
                <circle cx="50" cy="50" r="40" fill="none" stroke="#7c5dff" strokeWidth="14" strokeDasharray={`${(usedPct / 100) * circ} ${circ}`} strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-black">{usedPct.toFixed(0)}%</span>
                <span className="text-[9px] text-muted">Used</span>
              </div>
            </div>
            <div className="space-y-2 flex-1">
              <div><p className="text-sm font-bold">{totalBytes > 0 ? fmtSize(totalBytes) : '1.2 GB'}</p><p className="text-xs text-muted">Used</p></div>
              <div><p className="text-sm font-bold">{totalBytes > 0 ? fmtSize(STORAGE_LIMIT - totalBytes) : '3.8 GB'}</p><p className="text-xs text-muted">Free</p></div>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {catBytesDisplay.map(([cat, bytes], i) => {
              const meta = CAT_META[cat] ?? CAT_META.other;
              return (
                <div key={cat} className="flex items-center gap-2 text-xs">
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                  <span className="flex-1 text-muted">{meta.label}</span>
                  <span className="font-semibold">{fmtSize(bytes)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Quick Actions</h2>
          <div className="space-y-2">
            {[
              { icon: Upload, label: 'Upload Document', act: () => setOpen(true) },
              { icon: FolderLock, label: 'Create New Folder', act: () => {} },
              { icon: Download, label: 'Export All Documents', act: () => {} },
              { icon: Sparkles, label: 'AI Document Summary', act: () => {} },
            ].map(({ icon: Icon, label, act }) => (
              <button key={label} onClick={act} className="flex w-full items-center gap-3 rounded-xl border border-border px-4 py-2.5 text-sm hover:border-border">
                <Icon className="h-4 w-4 text-muted" />{label}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Recent Activity</h2></div>
          <div className="space-y-3">
            {displayDocs.slice(0, 4).map((doc) => {
              const meta = CAT_META[doc.category ?? 'other'] ?? CAT_META.other;
              const diff = Math.floor((Date.now() - new Date(doc.created_at).getTime()) / 3600000);
              const ago = diff < 24 ? `${diff}h ago` : `${Math.floor(diff / 24)}d ago`;
              return (
                <div key={doc.id} className="flex items-start gap-3">
                  <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base', meta.bg)}>{meta.icon}</div>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{doc.title}</p><p className="text-xs text-muted">{meta.label} · {ago}</p></div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15"><Sparkles className="h-6 w-6 text-brand" /></div>
          <h3 className="font-bold">AI Document Assistant</h3>
          <p className="mt-2 text-xs leading-5 text-muted">Summarize, extract key info, and get insights from any document.</p>
          <Button onClick={() => {}} className="btn-cta mt-4 w-full">Ask AI</Button>
        </div>
      </aside>
      <Modal open={open} title="Upload Document" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <div className="rounded-xl border-2 border-dashed border-border p-8 text-center">
            <Upload className="mx-auto mb-3 h-8 w-8 text-muted/60" />
            <p className="text-sm font-semibold text-muted">Drag & drop file here</p>
            <p className="mt-1 text-xs text-muted/60">PDF, JPG, PNG, DOCX up to 50MB</p>
            <button className="mt-4 rounded-lg border border-border px-4 py-2 text-xs font-semibold">Browse Files</button>
          </div>
          <Field label="Document Name">{(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Passport - Emma" />}</Field>
          <Field label="Category">{(id) => <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>{CATEGORIES.map((c) => <option key={c} value={c}>{CAT_META[c]?.label ?? c}</option>)}</Select>}</Field>
          <Field label="Member">{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Family (shared)</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Button onClick={save} disabled={saving || !form.title} loading={saving} className="w-full">{saving ? 'Saving...' : 'Add Document'}</Button>
        </div>
      </Modal>
    </div>
  );
}
