// What Bubaly actually did, what it is allowed to do, and what it was allowed
// to read — the three questions the Trust Center's Activity tab answers.
//
// WHY THIS FILE EXISTS: the Trust page was a permissions console. It could say
// what the rules ARE (policies, grants, delegations) and what one decision's
// REASON was (`trust_audit_logs.reason`), but not what Bubaly did with those
// permissions. The three facts a family needs were each persisted and each
// invisible:
//
//   * `ai_tool_calls` — every tool Bubaly ran, readable per run only;
//   * `family_ai_settings.category_behavior` — the autonomy dial, which lives
//     in Settings, a page away from the policies it interacts with;
//   * `ai_request_context.sensitive_omitted` plus the snapshot's slice names —
//     what a request was allowed to read and what policy withheld, written by
//     `lib/ai/context/builder.ts` and read by no UI at all.
//
// TWO RULES THIS MODULE KEEPS:
//
//  1. NAMES, NEVER PAYLOAD. The context snapshot holds the assembled rows — a
//     budget, document titles, a schedule. Only its slice NAMES leave this
//     module (`sliceNamesOf`), and the tool-call ledger never selects `inputs`
//     or `outputs` (see `loadRecentToolCalls`). "Bubaly read your schedule and
//     your food preferences" is the disclosure; re-publishing the data on a
//     page the whole family can open is not.
//
//  2. FAIL CLOSED. Every read here returns its error rather than an empty
//     list. A ledger that renders "Bubaly has done nothing" because a query
//     failed is exactly the reassuring lie this tab exists to remove, so the
//     tab shows a retryable error state instead. The failure is scoped to the
//     tab: the permissions console beside it keeps rendering.
//
// TODO (needs a migration, deliberately not in this change): a full
// sensitive-ACCESS history — which sensitive tables a request actually read,
// not only which slices policy withheld — needs a new
// `ai_context_access_log(request_id, family_id, slice, table_name, row_count,
// sensitive, created_at)` table written by `lib/ai/context/builder.ts`, with a
// family-manager read policy. Until it exists this module reports the slice
// names of the snapshot that was assembled and the names policy omitted, which
// is what is persisted today.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { isManager } from '@/lib/constants/roles';
import { getTool } from '@/lib/ai/tools/registry';
import { HIGH_STAKES_AI_DOMAINS, type AutonomyBehavior } from '@/lib/trust/engine';
import { settingsFromRow } from '@/lib/ai/family-settings';
import { AI_CATEGORIES } from '@/lib/ai/categories';
import { loadRecentToolCalls, type ToolCallLedgerRow } from '@/lib/ai/runs/store';

/** One line of "what Bubaly did", with the run it belongs to. Never the arguments. */
export type TrustToolCall = {
  id: string;
  /** The canonical dotted tool name — an identifier, shown beside its domain. */
  toolName: string;
  domain: string | null;
  state: ToolCallLedgerRow['state'];
  actorKind: ToolCallLedgerRow['actor_kind'];
  createdAt: string;
  durationMs: number | null;
  /** The persisted failure message, so a failed call is never shown as a success. */
  error: string | null;
  /** Links to `/dashboard/concierge/runs/<id>`; null for a call made outside a run. */
  runId: string | null;
};

/** The autonomy dial for one category — the Settings half of "what may Bubaly do". */
export type TrustDial = {
  domain: string;
  behavior: AutonomyBehavior;
  /** True when the family never set this category and it follows the household default. */
  inherited: boolean;
};

export type TrustDials = {
  enabled: boolean;
  defaultBehavior: AutonomyBehavior;
  categories: TrustDial[];
};

/** What one request was allowed to read, by slice name — never the slice's contents. */
export type TrustContextRead = {
  requestId: string;
  /** The family's own words, trimmed; empty when the request carried none. */
  requestText: string;
  intent: string | null;
  createdAt: string;
  /** Slice names present in the persisted snapshot. */
  read: string[];
  /** Slice names policy withheld from that viewer (`sensitive_omitted`). */
  withheld: string[];
};

export type TrustActivity = {
  toolCalls: TrustToolCall[];
  /**
   * Tool calls in high-stakes domains, hidden because the viewer is not a
   * parent or adult. Reported as a count so the page can say "3 entries are
   * only shown to parents" instead of pretending the ledger is shorter.
   */
  hiddenToolCalls: number;
  dials: TrustDials;
  contextReads: TrustContextRead[];
  /** False for a child or teen: what a request read is a manager-only view. */
  canSeeContext: boolean;
};

/** Slice names read and withheld, for one request. */
export type BasedOn = { read: string[]; withheld: string[] };

type ContextRow = {
  request_id: string;
  sensitive_omitted: string[] | null;
  snapshot: unknown;
  created_at: string;
};

function canManageScope(scope: Pick<ServiceScope, 'role'>): boolean {
  return scope.role === 'system' || isManager(scope.role);
}

/** The trust domain a tool belongs to, from the registry — null when the name is unknown. */
export function domainForTool(toolName: string): string | null {
  return getTool(toolName)?.domain ?? null;
}

/**
 * A tool call a non-manager must not see: anything in a high-stakes domain
 * (§4's medical, money, documents, driving, emergency) — and anything whose
 * tool the registry no longer knows, because a call nobody can classify is not
 * a call we may assume is harmless.
 */
export function isSensitiveToolCall(toolName: string): boolean {
  const domain = domainForTool(toolName);
  return domain === null || HIGH_STAKES_AI_DOMAINS.includes(domain);
}

/** Slice NAMES only. The snapshot's `slices` object itself is never returned. */
export function sliceNamesOf(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const slices = (snapshot as { slices?: unknown }).slices;
  if (!slices || typeof slices !== 'object' || Array.isArray(slices)) return [];
  return Object.keys(slices as Record<string, unknown>).filter((name) => typeof name === 'string' && name.length > 0);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

const MAX_REQUEST_TEXT = 120;

function trimText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > MAX_REQUEST_TEXT ? `${text.slice(0, MAX_REQUEST_TEXT - 1)}…` : text;
}

/**
 * Everything the Activity tab renders.
 *
 * `contextReads` is manager-only: `ai_request_context` can hold the money and
 * document slices assembled for a parent, and 0250's RLS already says so — the
 * check here means a child's page does not even ask.
 */
export async function loadTrustActivity(
  scope: ServiceScope,
  opts?: { db?: SupabaseClient<Database>; toolCallLimit?: number; contextLimit?: number },
): Promise<ServiceResult<TrustActivity>> {
  const db = opts?.db ?? scope.db;
  const canManage = canManageScope(scope);
  const contextLimit = Math.min(Math.max(opts?.contextLimit ?? 12, 1), 50);

  const [callsRes, settings, contexts] = await Promise.all([
    loadRecentToolCalls(scope, { db, limit: opts?.toolCallLimit ?? 25 }),
    db.from('family_ai_settings').select('*').eq('family_id', scope.familyId).maybeSingle(),
    canManage
      ? db
          .from('ai_request_context')
          .select('request_id, sensitive_omitted, snapshot, created_at')
          .eq('family_id', scope.familyId)
          .order('created_at', { ascending: false })
          .limit(contextLimit)
      : Promise.resolve({ data: [] as ContextRow[], error: null }),
  ]);

  // The ledger read logs and describes its own failure (`lib/ai/runs/store`).
  if (!callsRes.ok) return callsRes;

  if (settings.error) {
    console.error('[trust/activity] autonomy dial read failed', settings.error);
    return fail(describeDbError(settings.error, 'Bubaly could not read what it is allowed to do on its own.'), {
      code: SERVICE_CODES.db,
      retryable: true,
    });
  }
  if (contexts.error) {
    console.error('[trust/activity] request context read failed', contexts.error);
    return fail(describeDbError(contexts.error, 'Bubaly could not read what it looked at.'), {
      code: SERVICE_CODES.db,
      retryable: true,
    });
  }

  const contextRows = (contexts.data ?? []) as ContextRow[];
  const requestIds = contextRows.map((row) => row.request_id).filter(Boolean);
  const requestById = new Map<string, { requestText: string | null; intent: string | null }>();
  if (requestIds.length > 0) {
    const { data: requests, error: requestsError } = await db
      .from('ai_requests')
      .select('id, request_text, interpreted_intent')
      .eq('family_id', scope.familyId)
      .in('id', requestIds);
    if (requestsError) {
      console.error('[trust/activity] request read failed', requestsError);
      return fail(describeDbError(requestsError, 'Bubaly could not read what it looked at.'), {
        code: SERVICE_CODES.db,
        retryable: true,
      });
    }
    for (const row of (requests ?? []) as { id: string; request_text: string | null; interpreted_intent: string | null }[]) {
      requestById.set(row.id, { requestText: row.request_text, intent: row.interpreted_intent });
    }
  }

  const visibleCalls: TrustToolCall[] = [];
  let hiddenToolCalls = 0;
  for (const row of callsRes.data) {
    if (!canManage && isSensitiveToolCall(row.tool_name)) {
      hiddenToolCalls += 1;
      continue;
    }
    visibleCalls.push({
      id: row.id,
      toolName: row.tool_name,
      domain: domainForTool(row.tool_name),
      state: row.state,
      actorKind: row.actor_kind,
      createdAt: row.created_at,
      durationMs: row.duration_ms,
      error: row.error,
      runId: row.run_id,
    });
  }

  const aiSettings = settingsFromRow(scope.familyId, (settings.data as Parameters<typeof settingsFromRow>[1]) ?? null);
  const dials: TrustDials = {
    enabled: aiSettings.enabled,
    defaultBehavior: aiSettings.behavior,
    categories: AI_CATEGORIES.map((category) => ({
      domain: category.domain,
      behavior: aiSettings.categoryBehavior[category.domain] ?? aiSettings.behavior,
      inherited: aiSettings.categoryBehavior[category.domain] === undefined,
    })),
  };

  const contextReads: TrustContextRead[] = contextRows.map((row) => {
    const request = requestById.get(row.request_id);
    return {
      requestId: row.request_id,
      requestText: trimText(request?.requestText),
      intent: request?.intent ?? null,
      createdAt: row.created_at,
      read: sliceNamesOf(row.snapshot),
      withheld: stringArray(row.sensitive_omitted),
    };
  });

  return ok({ toolCalls: visibleCalls, hiddenToolCalls, dials, contextReads, canSeeContext: canManage });
}

/**
 * The "Based on" line for a set of approvals: the slice names of the context
 * each one's request was built from.
 *
 * Manager-only, and names only — an approval card stays a decision about
 * consequences, not a data dump. A read failure is returned rather than
 * swallowed; the caller renders no expander instead of an empty one, because
 * "based on nothing" would be a claim this read cannot support.
 */
export async function loadApprovalBasedOn(
  scope: ServiceScope,
  requestIds: (string | null | undefined)[],
  opts?: { db?: SupabaseClient<Database> },
): Promise<ServiceResult<Record<string, BasedOn>>> {
  const ids = [...new Set(requestIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0 || !canManageScope(scope)) return ok({});
  const db = opts?.db ?? scope.db;
  const { data, error } = await db
    .from('ai_request_context')
    .select('request_id, sensitive_omitted, snapshot, created_at')
    .eq('family_id', scope.familyId)
    .in('request_id', ids.slice(0, 100));
  if (error) {
    console.error('[trust/activity] approval context read failed', error);
    return fail(describeDbError(error, 'Bubaly could not read what this was based on.'), {
      code: SERVICE_CODES.db,
      retryable: true,
    });
  }
  const out: Record<string, BasedOn> = {};
  for (const row of (data ?? []) as ContextRow[]) {
    out[row.request_id] = { read: sliceNamesOf(row.snapshot), withheld: stringArray(row.sensitive_omitted) };
  }
  return ok(out);
}
