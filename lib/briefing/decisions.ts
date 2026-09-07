// What the brief's "decisions" section is made of.
//
// A decision is a row a person is being waited on for: a pending
// `approval_requests` row Bubaly opened (§12), a run parked in
// `awaiting_approval` or `awaiting_context`, a pending money approval in
// `parent_approvals`, or a pending `family_ai_recommendations` row. Home's
// "Needs you" list already reads exactly these and maps them through
// `lib/home/needs-build.ts`; this module reads the same rows the same way so
// the brief and the Command Center never disagree about what is waiting.
//
// TWO RULES, BOTH ABOUT HONESTY:
//
//   1. Fail closed. A read that errors returns `ok: false` and the caller
//      shows a retryable error — never a brief that says "nothing needs you"
//      because the approvals table could not be read. `console.error` carries
//      the `[briefing]` tag every read boundary in this repo logs under.
//
//   2. Money is for managers. `parent_approvals` is a wallet table; a child
//      or guest asking for their brief does not get to see who is asking to
//      spend what. The rule mirrors `lib/ai/context/policy.ts`, whose
//      `viewerFor` decides the same thing for the prompt context, so the
//      brief a child reads and the context a child's request is planned
//      against agree.
import 'server-only';
import { viewerFor } from '@/lib/ai/context/policy';
import type { ApprovalCardData } from '@/lib/approvals/card-data';
import { isAppPath } from '@/lib/briefing/response-schema';
import type { NeedItem } from '@/lib/home/needs-attention';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import type { AwaitingRunRow, ParentApprovalRow, RecommendationRow } from '@/lib/home/needs-sources';
import { listPending } from '@/lib/services/approvals';
import { scopeNow } from '@/lib/services/scope';
import { settleAll } from '@/lib/supabase/settle';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';

export type BriefDecisions = {
  /** Unranked; `buildBrief` ranks. Only the decision kinds — no count-based signals. */
  items: NeedItem[];
  /** Card data for `ai_approval` items, keyed by approval id — what the approval card renders. */
  approvals: Record<string, ApprovalCardData>;
  /** `parent_approvals.kind` for `approval` items, keyed by approval id — which wallet action the buttons run. */
  moneyApprovalKinds: Record<string, string>;
  /** Whether the viewer may decide. Every action re-checks this on the server. */
  canDecide: boolean;
};

/** Run states in which a person, not the executor, is holding the run. */
const WAITING_ON_A_PERSON = ['awaiting_approval', 'awaiting_context'] as const;

/**
 * Read everything waiting on a person for the scope's family.
 *
 * `scope.db` is whatever the caller holds — the member's RLS-bound client for
 * the API route, the service client for the cron — and every read filters
 * `family_id` itself, as every service in this repo does.
 */
/** Where a decision points when its own href cannot be trusted. */
const DECISIONS_FALLBACK_HREF = '/dashboard/needs-you';

export async function readBriefDecisions(scope: ServiceScope): Promise<ServiceResult<BriefDecisions>> {
  const now = scopeNow(scope);
  const viewer = viewerFor(scope);
  try {
    // `listPending` is a ServiceResult, not a Postgrest response, so it is
    // awaited BESIDE the batch rather than inside it: settleAll substitutes the
    // { data, error } shape for a rejection, which has no `ok` to branch on.
    // Separating them also stops the batch orphaning it — a `.from()` that
    // throws while the array literal is still being built (a transport failure,
    // which is exactly what settleAll exists for) used to leave this promise
    // running with nobody awaiting it, and its rejection then went unhandled.
    const pendingRes = await listPending(scope).catch((cause) => {
      console.error('[briefing] pending approvals read threw', cause);
      return fail('Bubaly could not load what is waiting on you.', { code: SERVICE_CODES.db, retryable: true });
    });
    const [runsRes, recsRes, moneyRes] = await settleAll([
      scope.db.from('family_automation_runs').select('id, summary, state, updated_at, created_at')
        .eq('family_id', scope.familyId).in('state', [...WAITING_ON_A_PERSON])
        .order('updated_at', { ascending: false }).limit(20),
      scope.db.from('family_ai_recommendations').select('id, title, priority, cta_href, created_at')
        .eq('family_id', scope.familyId).eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(10),
      viewer.canManage
        ? scope.db.from('parent_approvals').select('id, kind, amount_cents, created_at')
          .eq('family_id', scope.familyId).eq('status', 'pending')
          .order('created_at', { ascending: false }).limit(20)
        : Promise.resolve({ data: [] as ParentApprovalRow[], error: null }),
    ]);

    if (!pendingRes.ok) {
      console.error('[briefing] pending approvals read failed', pendingRes.error);
      return pendingRes;
    }
    for (const [label, res] of [
      ['waiting runs', runsRes], ['recommendations', recsRes], ['money approvals', moneyRes],
    ] as const) {
      if (res.error) {
        console.error(`[briefing] ${label} read failed`, res.error);
        return fail(describeDbError(res.error, 'Bubaly could not load what is waiting on you.'), { code: SERVICE_CODES.db, retryable: true });
      }
    }

    const aiApprovals = pendingRes.data;
    const money = (moneyRes.data ?? []) as ParentApprovalRow[];
    const items = buildHomeNeeds({
      approvals: money,
      // The count-based signals (chores, reminders, groceries…) are not
      // decisions; they stay in the digest half of the brief.
      renewals: [], documents: [], conflicts: [],
      pendingApprovals: 0, overdueMeds: false, overdueReminders: 0, dueTodayReminders: 0,
      pendingChores: 0, lowGrocery: false, openTodos: 0,
      now,
      aiApprovals: aiApprovals.map((a) => ({
        id: a.id, title: a.title, runId: a.runId, priority: a.priority ?? null, requestedAt: a.requestedAt, expiresAt: a.expiresAt,
      })),
      awaitingRuns: (runsRes.data ?? []) as AwaitingRunRow[],
      recommendations: (recsRes.data ?? []) as RecommendationRow[],
    });

    // A decision deep-links into the app and nowhere else (the client pins
    // this with `BriefDecisionSchema`). A recommendation's `cta_href` is free
    // text on a row any member can write, so one off-app value must not fail
    // the whole brief: the item keeps its place and points at the page that
    // lists every decision instead.
    const safeItems = items.map((item) => (isAppPath(item.href) ? item : { ...item, href: DECISIONS_FALLBACK_HREF }));

    return ok({
      items: safeItems,
      approvals: Object.fromEntries(aiApprovals.map((a) => [a.id, a])),
      moneyApprovalKinds: Object.fromEntries(money.map((a) => [a.id, a.kind])),
      canDecide: viewer.canManage,
    });
  } catch (error) {
    // A client that throws (a network failure, a stub in a test) is still a
    // failed read, and a failed read must not become an empty section.
    console.error('[briefing] decisions read failed', error);
    return fail('Bubaly could not load what is waiting on you.', { code: SERVICE_CODES.db, retryable: true });
  }
}
