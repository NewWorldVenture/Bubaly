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

type DB = SupabaseClient<Database>;

export type LoadCompletedOptions = {
  now: Date;
  /** How many items the section shows; each feed fetches the same number so the newest are never cut by a smaller window. */
  limit?: number;
  /** How far back the agent and autopilot feeds reach. */
  activityWindowMs?: number;
};

export async function loadCompletedByBubaly(db: DB, familyId: string, opts: LoadCompletedOptions): Promise<ServiceResult<CompletedItem[]>> {
  const limit = opts.limit ?? 6;
  const since = new Date(opts.now.getTime() - (opts.activityWindowMs ?? 2 * 86_400_000)).toISOString();

  try {
    const [runsRes, agentRes, autoRes] = await Promise.all([
      db.from('family_automation_runs').select('id, summary, state, progress, completed_at, updated_at, plan_id')
        .eq('family_id', familyId).in('state', ['completed', 'partially_completed'])
        .order('completed_at', { ascending: false, nullsFirst: false }).limit(limit),
      db.from('agent_activity').select('id, title, detail, href, created_at, agent')
        .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', since)
        .order('created_at', { ascending: false }).limit(limit),
      db.from('autopilot_suggestions').select('id, title, created_at')
        .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', since)
        .order('created_at', { ascending: false }).limit(limit),
    ]);
    const readError = runsRes.error ?? agentRes.error ?? autoRes.error;
    if (readError) {
      console.error('[home] completed by Bubaly read failed', readError);
      return fail(describeDbError(readError, 'Bubaly could not read what it finished.'), { code: SERVICE_CODES.db, retryable: true });
    }

    const runs = (runsRes.data ?? []) as CompletedRunRow[];
    const evidence = await loadRunEvidence(db, familyId, runs);
    if (!evidence.ok) return evidence;

    const activity: AiActivityRow[] = [
      ...((agentRes.data ?? []) as AiActivityRow[]),
      ...((autoRes.data ?? []) as { id: string; title: string; created_at: string }[])
        .map((s) => ({ id: s.id, title: s.title, detail: null, href: '/dashboard/autopilot', created_at: s.created_at, agent: 'autopilot' })),
    ];
    return ok(mergeCompletedByBubaly(runs, activity, { evidence: evidence.data, limit }));
  } catch (error) {
    console.error('[home] completed by Bubaly read failed', error);
    return fail(describeDbError(error, 'Bubaly could not read what it finished.'), { code: SERVICE_CODES.db, retryable: true });
  }
}
