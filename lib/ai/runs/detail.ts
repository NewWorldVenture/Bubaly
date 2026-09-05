// lib/ai/runs/detail.ts — the run detail read model behind GET /api/ai/runs/[id]
// and the run page (§17).
//
// Built on `store.loadRunDetail` (run, plan, steps, events) and widened with
// the request that started the run and the approvals it opened, because the
// page renders the question the person asked, the clarification it may be
// waiting on, and the approval cards inline.
//
// The client passed in is the CALLER'S RLS-bound client on purpose. A run from
// another family must come back as `null` — the route turns that into a 404 —
// rather than as a 403 that confirms the id exists. Every statement still
// filters `family_id` explicitly so the same function is correct when a
// server action hands it the service client.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult } from '@/lib/services/types';
import { toCardData, type ApprovalCardData } from '@/lib/services/approvals';
import { scopeForSystem } from '@/lib/services/scope';
import {
  loadRunDetail as loadRunCore, type PlanRow, type RequestRow, type RunEventRow, type RunRow, type StepRow,
} from './store';

type DB = SupabaseClient<Database>;
type ApprovalRow = Database['public']['Tables']['approval_requests']['Row'];

export type RunDetailView = {
  run: RunRow;
  request: RequestRow | null;
  plan: PlanRow | null;
  steps: StepRow[];
  events: RunEventRow[];
  approvals: ApprovalCardData[];
};

export type LoadRunDetailOptions = {
  /** The viewer's role decides `canEdit` on the approval cards; omit for a read that renders no controls. */
  viewerRole?: string | null;
  eventLimit?: number;
};

/**
 * Everything the run page shows, or `null` when the run is not this family's.
 * Reads fail closed: a run header without its steps would render as an empty,
 * finished-looking run.
 */
export async function loadRunDetail(
  db: DB,
  familyId: string,
  runId: string,
  opts: LoadRunDetailOptions = {},
): Promise<ServiceResult<RunDetailView | null>> {
  // `loadRunCore` only reads `familyId` and the client off the scope; the
  // system scope is the cheapest way to hand it exactly those two.
  const core = await loadRunCore(scopeForSystem(db, { id: familyId }), runId, { db, eventLimit: opts.eventLimit });
  if (!core.ok) return core;
  if (!core.data) return ok(null);
  const { run, plan, steps, events } = core.data;

  const [{ data: request, error: requestError }, { data: approvalRows, error: approvalError }] = await Promise.all([
    run.request_id
      ? db.from('ai_requests').select('*').eq('id', run.request_id).eq('family_id', familyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from('approval_requests').select('*').eq('family_id', familyId).eq('run_id', runId).order('created_at', { ascending: true }),
  ]);
  const readError = requestError ?? approvalError;
  if (readError) {
    console.error('[ai/runs] failed to read the run detail request/approvals', readError);
    return fail(describeDbError(readError, 'Bubaly could not open that run.'), { code: SERVICE_CODES.db, retryable: true });
  }

  const approvals = (approvalRows ?? []) as ApprovalRow[];
  const names = new Map<string, string>();
  const memberIds = [...new Set(approvals.map((a) => a.requested_by_member_id).filter((id): id is string => !!id))];
  if (memberIds.length) {
    const { data: members, error: memberError } = await db
      .from('family_members').select('id, display_name').eq('family_id', familyId).in('id', memberIds);
    // A missing requester name is cosmetic; the run itself still opens.
    if (memberError) console.error('[ai/runs] failed to resolve approval requester names', memberError);
    for (const m of members ?? []) names.set(m.id, m.display_name);
  }
  const canEdit = isManager(opts.viewerRole);

  return ok({
    run,
    request: (request as RequestRow | null) ?? null,
    plan,
    steps,
    events,
    approvals: approvals.map((row) => toCardData(row, { requestedBy: row.requested_by_member_id ? names.get(row.requested_by_member_id) ?? null : null, canEdit })),
  });
}
