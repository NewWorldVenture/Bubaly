import type { Metadata } from 'next';
import { ShieldAlert } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ReportModeration } from '@/components/admin/report-moderation';
import {
  reasonLabel, STATUS_LABELS, summarizeReports, reportMatchesFilter, isReportFilter,
  type ReportStatus, type ReportFilter,
} from '@/lib/marketplace/reports';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

type Params = { searchParams: Promise<{ status?: string }> };

const FILTERS: { key: ReportFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_action', label: 'Needs action' },
  { key: 'actioned', label: 'Actioned' },
  { key: 'dismissed', label: 'Dismissed' },
];

export const metadata: Metadata = { title: 'reports.marketplaceReports', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_CHIP: Record<string, string> = {
  open: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  reviewing: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  actioned: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  dismissed: 'bg-border/60 text-muted',
};

/** Super-admin marketplace safety queue (gated by the /admin layout). Reads via
 *  the service role, oversees every family, open reports first. */
export default async function AdminMarketplaceReportsPage({ searchParams }: Params) {
  const tr = await getTranslations();
  const sp = await searchParams;
  const filter: ReportFilter = isReportFilter(sp.status) ? sp.status : 'all';
  const admin = createServiceClient();

  const { data: reports, error: reportsError } = await admin
    .from('marketplace_reports')
    .select('id, listing_id, family_id, reason, details, status, resolution, created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (reportsError) {
    console.error('[admin-marketplace-reports] report read failed', reportsError);
    return <AdminReadError />;
  }

  const rows = reports ?? [];
  const summary = summarizeReports(rows.map((r) => ({ status: r.status, reason: r.reason })));

  // Enrich with listing titles + reporter family names (service role, all families).
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const familyIds = [...new Set(rows.map((r) => r.family_id))];
  const [{ data: listings, error: listingsError }, { data: families, error: familiesError }] = await Promise.all([
    listingIds.length ? admin.from('marketplace_listings').select('id, title, status').in('id', listingIds) : Promise.resolve({ data: [], error: null }),
    familyIds.length ? admin.from('families').select('id, name').in('id', familyIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (listingsError || familiesError) {
    console.error('[admin-marketplace-reports] report enrichment read failed', listingsError ?? familiesError);
    return <AdminReadError />;
  }
  const listingOf = new Map((listings ?? []).map((l) => [l.id, l]));
  const familyOf = new Map((families ?? []).map((f) => [f.id, f.name as string]));

  // Open/reviewing first, then newest — then narrow to the selected status filter.
  const rank = (s: string) => (s === 'open' ? 0 : s === 'reviewing' ? 1 : 2);
  const ordered = [...rows]
    .sort((a, b) => rank(a.status) - rank(b.status))
    .filter((r) => reportMatchesFilter(r.status, filter));

  const filterCount: Record<ReportFilter, number> = {
    all: summary.total,
    needs_action: summary.open,
    actioned: summary.byStatus.actioned ?? 0,
    dismissed: summary.byStatus.dismissed ?? 0,
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ShieldAlert className="h-6 w-6 text-rose-500" /> {tr('adminMarketplaceReports.marketplaceReports')}
        </h1>
        <p className="mt-1 text-sm text-muted">{tr('reports.communitySafetyFlagsAcrossEvery')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Needs action', value: summary.open },
          { label: 'Actioned', value: summary.byStatus.actioned ?? 0 },
          { label: 'Dismissed', value: summary.byStatus.dismissed ?? 0 },
          { label: 'Total', value: summary.total },
        ].map((t) => (
          <Card key={t.label} className="p-4">
            <div className="text-2xl font-bold">{t.value}</div>
            <div className="text-xs text-muted">{t.label}</div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <a
            key={f.key}
            href={f.key === 'all' ? '/admin/marketplace/reports' : `/admin/marketplace/reports?status=${f.key}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition',
              filter === f.key ? 'border-brand bg-brand/10 text-brand-text' : 'border-border text-muted hover:bg-elevated',
            )}
          >
            {f.label} <span className="opacity-60">{filterCount[f.key]}</span>
          </a>
        ))}
      </div>

      {ordered.length === 0 ? (
        <EmptyState
          title={filter === 'all' ? 'No reports' : 'Nothing here'}
          description={filter === 'all' ? 'Nothing has been flagged. The marketplace is clean.' : 'No reports match this filter.'}
        />
      ) : (
        <ul className="space-y-2.5">
          {ordered.map((r) => {
            const listing = listingOf.get(r.listing_id) as { title: string; status: string } | undefined;
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', STATUS_CHIP[r.status])}>{STATUS_LABELS[r.status as ReportStatus]}</span>
                    <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{reasonLabel(r.reason)}</span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{listing?.title ?? '(listing removed)'}</p>
                    {listing && <span className="text-xs capitalize text-muted">{listing.status}</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Reported by {familyOf.get(r.family_id) ?? 'a family'} · {new Date(r.created_at).toLocaleDateString()}
                  </p>
                  {r.details && <p className="mt-1 text-sm text-fg/90">“{r.details}”</p>}
                  {r.resolution && <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">Resolution: {r.resolution}</p>}
                  <ReportModeration id={r.id} status={r.status} />
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

async function AdminReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{tr('reports.marketplaceReports')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('reports.communitySafetyFlagsAcrossEvery2')}</p>
      </div>
      <ErrorState message={tr('reports.couldNotLoadMarketplaceReports')} />
      <a href="/admin/marketplace/reports" className="text-sm font-medium text-brand-text underline">{tr('reports.refreshReports')}</a>
    </div>
  );
}
