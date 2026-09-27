import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { settleAll, describeReadError } from '@/lib/supabase/settle';
import { ErrorState } from '@/components/ui/states';
import { DiningModule, type DiningRow, type DiningStats } from '@/components/modules/dining-module';

export const metadata: Metadata = { title: 'Dining Out' };
export const dynamic = 'force-dynamic';

const COLS = 'id, name, kind, cuisine, category, price_level, rating, distance_km, is_favorite, amount_cents, item_count, visited_at';

// The lists are capped for the page's sake. The TILES are not derived from them:
// they are counted and summed over the whole family, because "Spend · 30d
// $840.00" is a claim about the family's month, not about the thirty rows this
// request happened to fetch. A tile derived from a capped list understates by
// however much the cap dropped, to the cent, with nothing on screen saying so.
const RESTAURANT_LIST_CAP = 50;
const VISIT_LIST_CAP = 30;

// A sum still has to read rows, so it is bounded too — but the bound is checked
// against the exact count, and a figure we cannot complete is reported as
// unknown rather than as a partial total dressed up as a whole one.
const SUM_CAP = 2000;

const THIRTY_DAYS_MS = 30 * 86400_000;

/** The sum/average is only a fact about the family if the cap did not bite. */
function completeOverCap(count: number | null, rows: unknown[]): boolean {
  return count == null ? rows.length < SUM_CAP : count <= rows.length;
}

/** How many rows matched: the exact count when the database gave one, else the
 *  rows read — but only while they are below the bound, since a read that hit
 *  SUM_CAP says "at least 2000", not "2000". */
function exactCount(count: number | null, rows: unknown[]): number | null {
  if (count != null) return count;
  return rows.length < SUM_CAP ? rows.length : null;
}

/**
 * The dining_out TABLE is absent — an environment its migration has not reached.
 *
 * Deliberately narrower than lib/supabase/errors.ts's isMissingRelationError
 * (and its alias isMissingTableError), which also answers yes to a missing
 * COLUMN (42703, PGRST204) and to any message containing "does not exist". The
 * two are different facts about the family: with no table, no family can have a
 * dining row, so "No saved restaurants yet" is true; with a dropped or renamed
 * column, the rows are there and this page cannot show them, so the same words
 * are false and "Add place" re-enters rows that already exist.
 */
function diningTableIsAbsent(error: object): boolean {
  const code = 'code' in error ? error.code : undefined;
  return code === '42P01' || code === 'PGRST205';
}

/** The Postgres/PostgREST code, which describeReadError drops when a message is
 *  present — and '42501' vs '57014' is the first thing an operator needs. */
function errorCode(error: object): string | null {
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && code !== '' ? code : null;
}

export default async function DiningPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const monthAgoIso = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

  // settleAll, not Promise.all: a transport rejection on one leg must arrive as
  // { data: null, error } so the triage below sees it, instead of rejecting the
  // batch (lib/supabase/settle.ts).
  const [restaurantsRes, visitsRes, favoritesRes, windowRes, ratedRes] = await settleAll([
    supabase.from('dining_out').select(COLS)
      .eq('family_id', familyId).eq('kind', 'restaurant')
      .order('is_favorite', { ascending: false })
      .order('rating', { ascending: false, nullsFirst: false }).limit(RESTAURANT_LIST_CAP),
    supabase.from('dining_out').select(COLS)
      .eq('family_id', familyId).eq('kind', 'visit')
      .order('visited_at', { ascending: false, nullsFirst: false }).limit(VISIT_LIST_CAP),
    // Favorites: an exact count, not a tally of the fetched page. `is_favorite`
    // is the first sort key above, so the list happens to hold every favorite
    // below the cap — and silently reports 50 for a family with 55.
    supabase.from('dining_out').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('kind', 'restaurant').eq('is_favorite', true),
    // Visits · 30d and Spend · 30d over the WHOLE trailing window, not over the
    // thirty most recent visits overall.
    supabase.from('dining_out').select('amount_cents', { count: 'exact' })
      .eq('family_id', familyId).eq('kind', 'visit').gte('visited_at', monthAgoIso).limit(SUM_CAP),
    // Avg rating over every rated saved place. The list's fill order is `rating`
    // desc, so an average taken from it drops the worst and always flatters.
    supabase.from('dining_out').select('rating', { count: 'exact' })
      .eq('family_id', familyId).eq('kind', 'restaurant').not('rating', 'is', null).limit(SUM_CAP),
  ]);

  // Every failure is named in the log, with its code — a partial outage on this
  // table used to be invisible, which is the exact failure
  // lib/meals/degrade-read.ts exists to prevent. Then: a database the dining_out
  // migration has not reached (the TABLE is absent: 42P01, PGRST205) degrades to
  // empty, and anything else — an RLS denial, a statement timeout, a dropped or
  // renamed column (42703, PGRST204), a reset connection — fails closed, because
  // an empty Dining Out page is a claim the family will act on.
  const reads = [
    ['restaurants', restaurantsRes],
    ['visits', visitsRes],
    ['favorites', favoritesRes],
    ['spend30d', windowRes],
    ['ratings', ratedRes],
  ] as const;
  let hardFailure = false;
  for (const [label, res] of reads) {
    if (!res.error) continue;
    console.error(`[dashboard/dining] ${label} read failed`, { code: errorCode(res.error), message: describeReadError(res.error) });
    if (!diningTableIsAbsent(res.error)) hardFailure = true;
  }
  if (hardFailure) {
    return <ErrorState message={t('dining.couldNotLoadYourDiningOut')} />;
  }

  const restaurants = (restaurantsRes.data ?? []) as unknown as DiningRow[];
  const visits = (visitsRes.data ?? []) as unknown as DiningRow[];

  const windowRows = (windowRes.data ?? []) as unknown as { amount_cents: number | null }[];
  const ratedRows = (ratedRes.data ?? []) as unknown as { rating: number | null }[];

  // A tolerated (un-migrated) failure leaves the figure UNKNOWN. It does not
  // leave it zero: "Spend · 30d $0" is a number a parent can act on, and a read
  // that did not happen is not evidence that they spent nothing. The same goes
  // for a count the database did not return: supabase-js hands back
  // { error: null, count: null } for a HEAD it got an empty 404 for — which is
  // what the favorites read receives when the table is absent.
  const stats: DiningStats = {
    favorites: favoritesRes.error ? null : favoritesRes.count,
    visits30d: windowRes.error ? null : exactCount(windowRes.count, windowRows),
    spend30dCents: windowRes.error || !completeOverCap(windowRes.count, windowRows)
      ? null
      : windowRows.reduce((sum, row) => sum + (row.amount_cents ?? 0), 0),
    avgRating: ratedRes.error || !completeOverCap(ratedRes.count, ratedRows) || ratedRows.length === 0
      ? null
      : Math.round((ratedRows.reduce((sum, row) => sum + (row.rating ?? 0), 0) / ratedRows.length) * 10) / 10,
  };

  return <DiningModule restaurants={restaurants} visits={visits} stats={stats} />;
}
