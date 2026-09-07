// /dashboard/search?q=… — everything the household has recorded, in one list.
//
// Reached from the ⌘K bar's "See all results", never from the sidebar: this is
// the overflow for a query the palette could only show four rows of, not a
// destination someone navigates to cold.
//
// Three things it will not do:
//   • It will not render "nothing matched" when a source failed. A failed
//     source is named in the partial notice; when EVERY source fails the
//     service returns an error and the page shows a retryable error state,
//     because "the database did not answer" is not "your household is empty".
//   • It will not imply it searched what it did not. A member who may not see
//     money records is told that bills, warranties and renewals were not
//     searched, rather than being shown a confident empty group.
//   • It will not invent a destination. Every link is a route that already
//     exists; only vacations have a per-record page, so the rest land on the
//     list the record lives on.
import type { Metadata } from 'next';
import Link from 'next/link';
import { Search, FileText, Package, Plane, Palmtree, Receipt, ShieldCheck, RefreshCw, Scale, CalendarDays, StickyNote, Brain } from 'lucide-react';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { searchHousehold, MAX_LIMIT, MIN_QUERY_CHARS } from '@/lib/services/search';
import { groupByKind, kindLabelKey, type SearchKind } from '@/lib/search/rank';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Household search | Bubaly' };
export const dynamic = 'force-dynamic';

const KIND_ICON: Record<SearchKind, typeof FileText> = {
  document: FileText,
  item: Package,
  trip: Plane,
  vacation: Palmtree,
  bill: Receipt,
  warranty: ShieldCheck,
  renewal: RefreshCw,
  decision: Scale,
  event: CalendarDays,
  note: StickyNote,
  fact: Brain,
};

/** The record's own date, in the reader's locale. Undated records simply show nothing. */
function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function HouseholdSearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const t = await getTranslations();
  const { locale } = await getLocaleContext();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  const result = q.length >= MIN_QUERY_CHARS ? await searchHousehold(scope, q, MAX_LIMIT) : null;

  const header = (
    <header className="mb-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Search className="h-5 w-5 text-muted" aria-hidden />
        {t('search.householdSearch')}
      </h1>
      <p className="mt-1 text-sm text-muted">{t('search.everythingYourHouseholdHasRecorded')}</p>
    </header>
  );

  if (!result) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        {header}
        <p className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted">
          {t('search.pressCommandKAndType', { min: MIN_QUERY_CHARS })}
        </p>
      </div>
    );
  }

  // Every source failed. Not an empty household — an outage, said as one.
  if (!result.ok) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        {header}
        <ErrorState message={result.error} />
        <p className="mt-3 text-center text-sm">
          <Link className="text-brand-text underline" href={`/dashboard/search?q=${encodeURIComponent(q)}`}>
            {t('search.tryThatSearchAgain')}
          </Link>
        </p>
      </div>
    );
  }

  const { hits, partial, withheld } = result.data;
  const groups = groupByKind(hits);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {header}

      <p className="mb-4 text-sm text-muted">
        {hits.length === 1
          ? t('search.oneRecordMatches', { query: q })
          : t('search.recordsMatch', { count: hits.length, query: q })}
      </p>

      {partial.length > 0 && (
        <div className="mb-4">
          <ErrorState message={t('search.someSourcesCouldNotBeSearched', { sources: partial.map((p) => p.table).join(', ') })} />
        </div>
      )}

      {withheld.length > 0 && (
        <p className="mb-4 rounded-xl border border-border bg-elevated px-4 py-3 text-xs text-muted">
          {t('search.moneyRecordsAreOnlySearched', {
            kinds: withheld.map((kind) => t(kindLabelKey(kind))).join(', '),
          })}
        </p>
      )}

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-6 py-14 text-center text-sm text-muted">
          {t('search.noRecordsMatched', { query: q })}
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const Icon = KIND_ICON[group.kind];
            return (
              <section key={group.kind}>
                <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {t(kindLabelKey(group.kind))}
                  <span className="font-normal normal-case tracking-normal">({group.hits.length})</span>
                </h2>
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                  {group.hits.map((hit) => {
                    const when = formatDate(hit.occurredAt, locale.code);
                    return (
                      <li key={`${hit.table}-${hit.id}`}>
                        <Link href={hit.href} className="block px-4 py-3 hover:bg-elevated">
                          <span className="block truncate text-sm font-medium">{hit.title}</span>
                          {hit.snippet && <span className="mt-0.5 block truncate text-xs text-muted">{hit.snippet}</span>}
                          {/* The evidence line: which table this row came from, and its date. */}
                          <span className="mt-1 block text-[11px] text-muted">
                            {when
                              ? t('search.fromTableDated', { table: hit.table, date: when })
                              : t('search.fromTable', { table: hit.table })}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
