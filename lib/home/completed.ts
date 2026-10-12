// lib/home/completed.ts — the one read behind "Completed by Bubaly" (M6), for
// Home and the dashboard variant alike.
//
// Two pages rendered this section from their own copies of the same three
// queries, and neither could say which tool acted or why. This reads the
// finished runs, the specialist agents' done actions and the autopilot's
// auto-executed suggestions, then `loadRunEvidence` for the runs, and merges
// them through the pure `mergeCompletedByBubaly` — so both pages show the same
// list, with the same source and reason under each row.
//
// Fails closed, deliberately breaking with the rest of the Home reads: this
// section is a CLAIM ("Bubaly finished these"), and "nothing finished yet"
// after a failed read is the reassuring lie the honesty rules forbid. The
// caller renders the error and a way to retry.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadRunEvidence } from '@/lib/ai/runs/evidence';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult } from '@/lib/services/types';
import { mergeCompletedByBubaly, type AiActivityRow, type CompletedItem, type CompletedRunRow } from './today';
import { settleAll } from '@/lib/supabase/settle';
import { suggestionVisibleTo, type AudienceViewer } from '@/lib/autopilot/audience';

type DB = SupabaseClient<Database>;

export type LoadCompletedOptions = {
  now: Date;
  /** How many items the section shows; each feed fetches the same number so the newest are never cut by a smaller window. */
  limit?: number;
  /** How far back the agent and autopilot feeds reach. */
  activityWindowMs?: number;
  /**
   * Who is reading. An auto-executed suggestion is a copy of a renewal, a
   * subscription or an insurance policy, and `autopilot_suggestions` is read
   * family-wide (0085): its title is listed only to the readers the card is
   * for (lib/autopilot/audience.ts) — every role reaches Home.
   */
  viewer: AudienceViewer;
};

type AutoExecutedRow = { id: string; title: string; created_at: string; kind: string | null; source_kind: string | null; member_id: string | null };

export async function loadCompletedByBubaly(db: DB, familyId: string, opts: LoadCompletedOptions): Promise<ServiceResult<CompletedItem[]>> {
  const limit = opts.limit ?? 6;
  const since = new Date(opts.now.getTime() - (opts.activityWindowMs ?? 2 * 86_400_000)).toISOString();

  // A page of the auto-executed feed. Paged rather than one `limit`: the cards
  // this reader is not shown are dropped after the read, and a guest's six
  // newest must not be cut down to the two that survive a page of six.
  const autoPage = (from: number) => db.from('autopilot_suggestions').select('id, title, created_at, kind, source_kind, member_id')
    .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', since)
    .order('created_at', { ascending: false }).order('id').range(from, from + limit - 1);
  const visible = (s: AutoExecutedRow) => suggestionVisibleTo(s, opts.viewer);

  try {
    const [runsRes, agentRes, autoRes] = await settleAll([
      db.from('family_automation_runs').select('id, summary, state, progress, completed_at, updated_at, plan_id')
        .eq('family_id', familyId).in('state', ['completed', 'partially_completed'])
        .order('completed_at', { ascending: false, nullsFirst: false }).limit(limit),
      db.from('agent_activity').select('id, title, detail, href, created_at, agent')
        .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', since)
        .order('created_at', { ascending: false }).limit(limit),
      autoPage(0),
    ]);
    const readError = runsRes.error ?? agentRes.error ?? autoRes.error;
    if (readError) {
      console.error('[home] completed by Bubaly read failed', readError);
      return fail(describeDbError(readError, 'Bubaly could not read what it finished.'), { code: SERVICE_CODES.db, retryable: true });
    }

    // Further pages only while this reader is short of `limit` and the last
    // page was full; the feed is bounded by its window either way.
    let page = (autoRes.data ?? []) as AutoExecutedRow[];
    const autoExecuted = page.filter(visible);
    for (let from = limit; autoExecuted.length < limit && page.length === limit; from += limit) {
      const next = await autoPage(from);
      if (next.error) {
        console.error('[home] completed by Bubaly read failed', next.error);
        return fail(describeDbError(next.error, 'Bubaly could not read what it finished.'), { code: SERVICE_CODES.db, retryable: true });
      }
      page = (next.data ?? []) as AutoExecutedRow[];
      autoExecuted.push(...page.filter(visible));
    }

    const runs = (runsRes.data ?? []) as CompletedRunRow[];
    const evidence = await loadRunEvidence(db, familyId, runs);
    if (!evidence.ok) return evidence;

    const activity: AiActivityRow[] = [
      ...((agentRes.data ?? []) as AiActivityRow[]),
      ...autoExecuted.slice(0, limit)
        .map((s) => ({ id: s.id, title: s.title, detail: null, href: '/dashboard/autopilot', created_at: s.created_at, agent: 'autopilot' })),
    ];
    return ok(mergeCompletedByBubaly(runs, activity, { evidence: evidence.data, limit }));
  } catch (error) {
    console.error('[home] completed by Bubaly read failed', error);
    return fail(describeDbError(error, 'Bubaly could not read what it finished.'), { code: SERVICE_CODES.db, retryable: true });
  }
}
