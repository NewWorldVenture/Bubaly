// The command bar's window into household search.
//
// The ⌘K bar is a client component and household search runs under the
// caller's RLS-bound Supabase client, so the lookup cannot happen in the
// browser. This action is the seam: the bar debounces keystrokes and calls it,
// the service does the fan-out, and only ranked rows the caller is allowed to
// see come back.
//
// It is READ-ONLY on purpose. Nothing here writes, nothing here proposes, and
// there is therefore no approval spine to route through — the trust boundary
// that matters is which SOURCES the caller may search, and that is decided
// inside `lib/services/search` from `scope.role`, not here.
//
// A failure comes back as `{ ok: false, error }` rather than an empty list. The
// bar renders that as a line saying the lookup failed; "no records matched" and
// "we could not look" are different facts and the palette must not merge them.
'use server';

import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { searchHousehold } from '@/lib/services/search';
import { MAX_RECORD_RESULTS, MIN_RECORD_QUERY, type CommandRecord } from '@/lib/command-bar/route';
import type { SearchKind } from '@/lib/search/rank';
import { describeActionError } from '@/lib/supabase/errors';

export type CommandRecordsResult =
  | {
    ok: true;
    records: CommandRecord[];
    /** Source tables that could not be searched — the bar says so rather than implying completeness. */
    partial: string[];
    /** Kinds this member may not search at all (money, account numbers). */
    withheld: SearchKind[];
  }
  | { ok: false; error: string };

/**
 * The top household records matching `query`, for the ⌘K bar.
 *
 * Asks for a few more than the bar shows so `routeCommand` still has something
 * to choose from after its own cap, and so "See all results" is not the only
 * way to discover a second match.
 */
export async function searchRecordsAction(query: string): Promise<CommandRecordsResult> {
  const t = await getTranslations();
  const trimmed = (query ?? '').trim();
  if (trimmed.length < MIN_RECORD_QUERY) return { ok: true, records: [], partial: [], withheld: [] };

  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const scope = scopeFromUserContext(ctx, supabase);
    const result = await searchHousehold(scope, trimmed, MAX_RECORD_RESULTS * 2);
    if (!result.ok) return { ok: false, error: result.error };
    return {
      ok: true,
      records: result.data.hits.map((hit): CommandRecord => ({
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        href: hit.href,
        occurredAt: hit.occurredAt,
        score: hit.score,
      })),
      partial: result.data.partial.map((failure) => failure.table),
      withheld: result.data.withheld,
    };
  } catch (error) {
    console.error('[search-action] household search failed', error);
    return { ok: false, error: describeActionError(error, t('search.couldNotSearchYourRecords')) };
  }
}
