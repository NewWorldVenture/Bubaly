import type { Metadata } from 'next';
import { FileText, Image as ImageIcon, FolderKanban, HardDrive, Clock } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllAsQuery, readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { DocumentRowActions } from '@/components/admin/document-row-actions';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('content.contentManagement'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

const TABS = [
  { key: 'all', label: 'All Content' },
  { key: 'photos', label: 'Photos' },
  { key: 'files', label: 'Files' },
  { key: 'categories', label: 'Categories' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Params = { searchParams: Promise<{ tab?: string; q?: string; category?: string; family?: string }> };

/** Rows a summed read may page through before it is reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;
/** The browsable list is the newest this many documents, and says so when there are more. */
const LIST_CEILING = 1_000;

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
  const tr = await getTranslations();
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'all';
  const supabase = createServiceClient();

  const q = (sp.q ?? '').trim().toLowerCase();
  const categoryFilter = sp.category ?? '';
  const familyFilter = sp.family ?? '';
  const since7 = new Date(Date.now() - 7 * 86400000);

  // This page used to read `documents.select('*')` once, unbounded, and compute
  // everything from what came back. PostgREST answers that with at most
  // `db-max-rows` (1,000) and no error, so past a thousand documents the Total
  // items tile pinned at 1,000, the storage total and the per-category bars
  // understated, and a category whose documents were all older than the newest
  // thousand was not on the page at all. admin/reports and admin/backup fixed
  // this for the same table; this page now reads the same way:
  //
  //   - the two tiles that are counts are `head: true` counts — exact, uncapped;
  //   - what is SUMMED (bytes, per-category counts) pages to a real ceiling,
  //     and reaching it is an error that lands in the read-error state below
  //     rather than a smaller platform. It pages on the id (readAllByIdAsQuery),
  //     not on offsets: families upload while this reads, and a document filed
  //     ahead of the next offset pushed one already read onto the next page,
  //     so its bytes were added twice;
  //   - the browsable list is an explicit newest-first page of LIST_CEILING,
  //     with the category and family filters applied by the server so they
  //     reach the whole table, and it says when there are more;
  //   - the "Recent uploads" rail is its own six-row read, so a filter on the
  //     list does not change what counts as recent;
  //   - uploaders are joined by the listed documents' created_by ids rather
  //     than by reading every profile, which was capped the same way.
  const [docCountResult, recentCountResult, aggregateResult, listResult, recentResult, familiesResult] = await settleAll([
    supabase.from('documents').select('id', { count: 'exact', head: true }),
    supabase.from('documents').select('id', { count: 'exact', head: true }).gte('created_at', since7.toISOString()),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('documents').select('id, category, size_bytes');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
    readAllAsQuery((from, to) => {
      let query = supabase.from('documents').select('*');
      if (familyFilter) query = query.eq('family_id', familyFilter);
      if (categoryFilter) {
        // 'other' is how a document with no category is shown and filtered.
        query = categoryFilter === 'other' ? query.or('category.is.null,category.eq.other') : query.eq('category', categoryFilter);
      }
      return query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to);
    }, { max: LIST_CEILING, failOnMax: false }),
    supabase.from('documents').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(6),
    readAllAsQuery((from, to) =>
      supabase.from('families').select('id, name').order('id').range(from, to), { max: SUM_ROW_CEILING }),
  ]);

  const { data: families, error: familiesError } = familiesResult;
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));

  let scoped = listResult.data ?? [];
  if (tab === 'photos') scoped = scoped.filter((d) => d.mime_type?.startsWith('image/'));
  if (tab === 'files') scoped = scoped.filter((d) => !d.mime_type?.startsWith('image/'));
  const filtered = scoped.filter((d) => !q || `${d.title} ${familyNameById.get(d.family_id) ?? ''}`.toLowerCase().includes(q));
  const shown = filtered.slice(0, 50);

  const uploaderIds = [...new Set([...shown, ...(recentResult.data ?? [])].map((d) => d.created_by).filter((id): id is string => !!id))];
  const { data: profiles, error: profilesError } = await readInChunks(uploaderIds, (chunk) =>
    supabase.from('profiles').select('id, full_name, email').in('id', chunk));

  // The storage and category figures past their ceiling cost those figures,
  // not the document list, its filters and row actions: they say they are not
  // shown rather than adding up part of the platform. Any other failure is
  // still the read-error state.
  const aggregateCeiling = 'truncated' in aggregateResult && aggregateResult.truncated;
  if (aggregateCeiling) console.warn('[admin-content] the storage read reached its ceiling; storage and categories are not shown');
  // Five reads of the one table; the first that failed names the failure.
  const { error: documentsError } = [docCountResult, recentCountResult, ...(aggregateCeiling ? [] : [aggregateResult]), listResult, recentResult].find((r) => r.error) ?? docCountResult;
  const readError = documentsError ?? familiesError ?? profilesError;
  if (readError) {
    console.error('[admin-content] content read failed', readError);
    return <AdminContentReadError />;
  }

  const docCount = docCountResult.count ?? 0;
  const recentUploads = recentCountResult.count ?? 0;
  const aggregate = aggregateResult.data ?? [];
  const recent = recentResult.data ?? [];
  const listTruncated = 'truncated' in listResult && listResult.truncated;
  const uploaderById = new Map(profiles.map((p) => [p.id, p.full_name || p.email || 'Unknown']));

  const totalBytes = aggregate.reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const categories = [...new Set(aggregate.map((d) => d.category ?? 'other'))];

  const countByCategory = new Map<string, number>();
  const bytesByCategory = new Map<string, number>();
  for (const d of aggregate) {
    const cat = d.category ?? 'other';
    countByCategory.set(cat, (countByCategory.get(cat) ?? 0) + 1);
    bytesByCategory.set(cat, (bytesByCategory.get(cat) ?? 0) + (d.size_bytes ?? 0));
  }

  const unavailable = tr('strategyMetrics.unavailable');
  // The category filter keeps working past the ceiling: it offers the listed
  // documents' categories, and the one already chosen, instead of none.
  const filterCategories = aggregateCeiling
    ? [...new Set([...(listResult.data ?? []).map((d) => d.category ?? 'other'), ...(categoryFilter ? [categoryFilter] : [])])]
    : categories;

  return (
    <div className="module-page">
      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={aggregateCeiling ? [tr('adminContent.storageUsed'), tr('adminContent.categories'), tr('adminContent.storageByCategory')] : []}
      />
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminContent.contentManagement')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminContent.manageAllDocumentsAndFilesAcross')}</p>
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
          <h2 className="mb-4 text-base font-semibold">{tr('adminContent.storageByCategory')}</h2>
          {aggregateCeiling ? (
            <p className="text-sm text-muted">{unavailable}</p>
          ) : categories.length === 0 ? (
            <EmptyState icon={FolderKanban} title={tr('adminContent.noDocumentsUploadedYet')} />
          ) : (
            <ul className="space-y-3">
              {categories.map((cat) => {
                const count = countByCategory.get(cat) ?? 0;
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-5">
            <div className="grid-stats">
              <StatCard icon={FileText} label={tr('adminContent.totalItems')} value={docCount} tone="bg-brand/10 text-brand-text" />
              <StatCard icon={HardDrive} label={tr('adminContent.storageUsed')} value={aggregateCeiling ? unavailable : fmtBytes(totalBytes)} tone="bg-success/10 text-success" />
              <StatCard icon={FolderKanban} label={tr('adminContent.categories')} value={aggregateCeiling ? unavailable : categories.length} tone="bg-accent/10 text-accent" />
              <StatCard icon={Clock} label={tr('adminContent.addedThisWeek')} value={recentUploads} tone="bg-warning/10 text-warning" />
            </div>

            <Card>
              <FilterForm action="/admin/content" hidden={{ tab }}>
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder={tr('adminContent.searchContentByTitleOrFamily')} />
                <FilterSelect name="category" label={tr('adminContent.category')} defaultValue={categoryFilter} options={[
                  { value: '', label: 'All Categories' },
                  ...filterCategories.map((c) => ({ value: c, label: c })),
                ]} />
                <FilterSelect name="family" label={tr('adminContent.family')} defaultValue={familyFilter} options={[
                  { value: '', label: 'All Families' },
                  ...(families ?? []).map((f) => ({ value: f.id, label: f.name })),
                ]} />
              </FilterForm>

              {filtered.length === 0 ? (
                <EmptyState icon={ImageIcon} title={tr('adminContent.noContentMatchesTheseFilters')} />
              ) : (
                <div className="table-responsive mt-4">
                  <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="px-3 py-2 font-medium">{tr('adminContent.title')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminContent.type')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminContent.family')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminContent.uploadedBy')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminContent.size')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminContent.added')}</th>
                        <th className="px-3 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {shown.map((d) => {
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
                  </table></div>
                  {filtered.length > 50 && (
                    <p className="mt-3 text-center text-xs text-muted">{tr('adminContent.showingTheFirst50Of')} {filtered.length} {tr('adminContent.matchingItemsNarrowYourSearchTo')}</p>
                  )}
                </div>
              )}
              {listTruncated && (
                <p className="mt-3 text-center text-xs text-muted">{tr('adminContent.theListIsTheNewestItems', { n: LIST_CEILING.toLocaleString() })}</p>
              )}
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminContent.recentUploads')}</h2>
              {recent.length === 0 ? (
                <p className="text-sm text-muted">{tr('adminContent.nothingUploadedYet')}</p>
              ) : (
                <ul className="space-y-3">
                  {recent.map((d) => {
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

async function AdminContentReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('content.contentManagement')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('content.manageAllDocumentsAndFiles')}</p>
      </div>
      <ErrorState message={tr('content.couldNotLoadContentFrom')} />
      <a href="/admin/content" className="text-sm font-medium text-brand-text underline">{tr('content.refreshContent')}</a>
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
