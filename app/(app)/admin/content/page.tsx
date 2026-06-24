import type { Metadata } from 'next';
import { FileText, Image as ImageIcon, FolderKanban, HardDrive, Clock } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { DocumentRowActions } from '@/components/admin/document-row-actions';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Content Management', robots: { index: false } };
export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'all', label: 'All Content' },
  { key: 'photos', label: 'Photos' },
  { key: 'files', label: 'Files' },
  { key: 'categories', label: 'Categories' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Params = { searchParams: Promise<{ tab?: string; q?: string; category?: string; family?: string }> };

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function typeLabel(mime: string | null): { label: string; icon: string } {
  if (!mime) return { label: 'File', icon: '📄' };
  if (mime.startsWith('image/')) return { label: 'Photo', icon: '🖼️' };
  if (mime.includes('pdf')) return { label: 'PDF', icon: '📕' };
  if (mime.includes('word') || mime.includes('document')) return { label: 'Document', icon: '📝' };
  return { label: 'File', icon: '📄' };
}

export default async function AdminContentPage({ searchParams }: Params) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'all';
  const supabase = createServiceClient();

  const [{ data: documents }, { data: families }, { data: profiles }] = await Promise.all([
    supabase.from('documents').select('*').order('created_at', { ascending: false }),
    supabase.from('families').select('id, name'),
    supabase.from('profiles').select('id, full_name, email'),
  ]);

  const docs = documents ?? [];
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const uploaderById = new Map((profiles ?? []).map((p) => [p.id, p.full_name || p.email || 'Unknown']));

  const totalBytes = docs.reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const categories = [...new Set(docs.map((d) => d.category ?? 'other'))];
  const since7 = new Date(Date.now() - 7 * 86400000);
  const recentUploads = docs.filter((d) => new Date(d.created_at) >= since7).length;

  const bytesByCategory = new Map<string, number>();
  for (const d of docs) bytesByCategory.set(d.category ?? 'other', (bytesByCategory.get(d.category ?? 'other') ?? 0) + (d.size_bytes ?? 0));

  const q = (sp.q ?? '').trim().toLowerCase();
  const categoryFilter = sp.category ?? '';
  const familyFilter = sp.family ?? '';

  let scoped = docs;
  if (tab === 'photos') scoped = scoped.filter((d) => d.mime_type?.startsWith('image/'));
  if (tab === 'files') scoped = scoped.filter((d) => !d.mime_type?.startsWith('image/'));

  const filtered = scoped.filter((d) => {
    if (q && !`${d.title} ${familyNameById.get(d.family_id) ?? ''}`.toLowerCase().includes(q)) return false;
    if (categoryFilter && (d.category ?? 'other') !== categoryFilter) return false;
    if (familyFilter && d.family_id !== familyFilter) return false;
    return true;
  });

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Content Management</h1>
        <p className="mt-1 text-sm text-muted">Manage all documents and files across every family on Bubaly.</p>
      </div>

      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/content?tab=${t.key}`} className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {tab === 'categories' ? (
        <Card>
          <h2 className="mb-4 text-base font-semibold">Storage by category</h2>
          {categories.length === 0 ? (
            <EmptyState icon={FolderKanban} title="No documents uploaded yet" />
          ) : (
            <ul className="space-y-3">
              {categories.map((cat) => {
                const count = docs.filter((d) => (d.category ?? 'other') === cat).length;
                const bytes = bytesByCategory.get(cat) ?? 0;
                const pct = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;
                return (
                  <li key={cat}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium capitalize">{cat}</span>
                      <span className="text-muted">{count} file{count !== 1 ? 's' : ''} · {fmtBytes(bytes)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-elevated">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-5">
            <div className="grid-stats">
              <StatCard icon={FileText} label="Total items" value={docs.length} tone="bg-brand/10 text-brand" />
              <StatCard icon={HardDrive} label="Storage used" value={fmtBytes(totalBytes)} tone="bg-success/10 text-success" />
              <StatCard icon={FolderKanban} label="Categories" value={categories.length} tone="bg-accent/10 text-accent" />
              <StatCard icon={Clock} label="Added this week" value={recentUploads} tone="bg-warning/10 text-warning" />
            </div>

            <Card>
              <FilterForm action="/admin/content" hidden={{ tab }}>
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder="Search content by title or family..." />
                <FilterSelect name="category" defaultValue={categoryFilter} options={[
                  { value: '', label: 'All Categories' },
                  ...categories.map((c) => ({ value: c, label: c })),
                ]} />
                <FilterSelect name="family" defaultValue={familyFilter} options={[
                  { value: '', label: 'All Families' },
                  ...(families ?? []).map((f) => ({ value: f.id, label: f.name })),
                ]} />
              </FilterForm>

              {filtered.length === 0 ? (
                <EmptyState icon={ImageIcon} title="No content matches these filters" />
              ) : (
                <div className="table-responsive mt-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="px-3 py-2 font-medium">Title</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">Family</th>
                        <th className="px-3 py-2 font-medium">Uploaded by</th>
                        <th className="px-3 py-2 font-medium">Size</th>
                        <th className="px-3 py-2 font-medium">Added</th>
                        <th className="px-3 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {filtered.slice(0, 50).map((d) => {
                        const type = typeLabel(d.mime_type);
                        return (
                          <tr key={d.id}>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2">
                                <span>{type.icon}</span>
                                <span className="font-medium">{d.title}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2.5"><Badge tone="neutral">{type.label}</Badge></td>
                            <td className="px-3 py-2.5 text-muted">{familyNameById.get(d.family_id) ?? '—'}</td>
                            <td className="px-3 py-2.5 text-muted">{d.created_by ? uploaderById.get(d.created_by) ?? '—' : '—'}</td>
                            <td className="px-3 py-2.5 text-muted">{fmtBytes(d.size_bytes ?? 0)}</td>
                            <td className="px-3 py-2.5 text-muted">{fmtDate(d.created_at, 'MMM d, yyyy')}</td>
                            <td className="px-3 py-2.5"><DocumentRowActions documentId={d.id} storagePath={d.storage_path} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filtered.length > 50 && (
                    <p className="mt-3 text-center text-xs text-muted">Showing the first 50 of {filtered.length} matching items — narrow your search to see more precisely.</p>
                  )}
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <h2 className="mb-3 text-base font-semibold">Recent uploads</h2>
              {docs.length === 0 ? (
                <p className="text-sm text-muted">Nothing uploaded yet.</p>
              ) : (
                <ul className="space-y-3">
                  {docs.slice(0, 6).map((d) => {
                    const type = typeLabel(d.mime_type);
                    return (
                      <li key={d.id} className="flex items-start gap-2.5 text-sm">
                        <span className="text-base">{type.icon}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{d.title}</p>
                          <p className="text-xs text-muted">{familyNameById.get(d.family_id) ?? 'Unknown family'} · {fmtDate(d.created_at, 'MMM d')}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{typeof value === 'number' ? value.toLocaleString() : value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
