// lib/autopilot/policy-scan.ts — the Autopilot pass that learns from what the
// family has already approved.
//
// Reads the window's decided approvals, the tool-call ledger and the policies
// the family already holds, runs the pure candidate finder, and reconciles the
// `autopilot_suggestions` rows it owns (kind 'policy', dedupe key
// `policy:<domain>:<capability>:<tool>`): new candidates are inserted as OPEN,
// an open one whose evidence grew is refreshed, a resolved one is respected,
// and an open one whose streak broke (a rejection, a failed call) is cleared.
//
// It writes suggestions and nothing else. The policy itself is written only
// when a manager accepts the suggestion (`acceptPolicySuggestionAction`).
//
// Fail closed: a read that fails is a scan that did not happen. Treating a
// failed read as "no approvals" would clear every open policy suggestion the
// family has, and would silently stop offering the policies it has earned.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool } from '@/lib/ai/tools/registry';
import {
  findPolicyCandidates, policyCandidateToDraft, toolNameFromApprovalPayload,
  POLICY_SUGGESTION_KIND, POLICY_WINDOW_DAYS,
  type ApprovalHistoryRow, type ExistingAiPolicy, type PolicyCandidate, type ToolCallHistoryRow,
} from '@/lib/autopilot/policy-candidates';

type DB = SupabaseClient<Database>;

export type PolicyScanResult = {
  /** Candidates the history supports this scan. */
  candidates: number;
  inserted: number;
  refreshed: number;
  cleared: number;
};

export type PolicyHistory = {
  approvals: ApprovalHistoryRow[];
  toolCalls: ToolCallHistoryRow[];
  existingPolicies: ExistingAiPolicy[];
  existingSuggestions: { id: string; dedupe_key: string; status: string; detail: string | null; confidence: number }[];
};

/** A legacy alias in `payload.name` resolves to the canonical registry name; an unknown name is kept as written. */
function canonicalToolName(name: string | null): string | null {
  if (!name) return null;
  return getTool(name)?.name ?? name;
}

/**
 * Every row the candidate finder needs, family-scoped. Throws on the first
 * read error after logging it — the caller's scan fails rather than acting on
 * a partial history.
 */
export async function loadPolicyHistory(supabase: DB, familyId: string, now: Date, windowDays = POLICY_WINDOW_DAYS): Promise<PolicyHistory> {
  const sinceIso = new Date(now.getTime() - windowDays * 86400000).toISOString();
  const [approvalsResult, toolCallsResult, policiesResult, suggestionsResult] = await Promise.all([
    supabase.from('approval_requests')
      .select('id, domain, capability, status, decided_at, requested_by_kind, payload, payload_kind')
      .eq('family_id', familyId).eq('requested_by_kind', 'ai')
      .in('status', ['approved', 'rejected', 'modified'])
      .gte('decided_at', sinceIso).limit(1000),
    supabase.from('ai_tool_calls')
      .select('id, tool_name, state, created_at')
      .eq('family_id', familyId).gte('created_at', sinceIso).limit(2000),
    // A policy addressed to `everyone` reaches Bubaly too, so an offer under it
    // would be redundant the moment it was accepted.
    supabase.from('trust_policies')
      .select('id, domain, capability, effect, enabled, conditions')
      .eq('family_id', familyId).in('subject_kind', ['ai', 'everyone']).eq('enabled', true).limit(200),
    supabase.from('autopilot_suggestions')
      .select('id, dedupe_key, status, detail, confidence')
      .eq('family_id', familyId).eq('kind', POLICY_SUGGESTION_KIND).limit(200),
  ]);

  const failed = [approvalsResult, toolCallsResult, policiesResult, suggestionsResult].find((r) => r.error);
  if (failed) {
    console.error('[autopilot] policy scan read failed', failed.error);
    throw new Error('Autopilot could not read the approval history');
  }

  return {
    approvals: (approvalsResult.data ?? []).map((r) => ({
      id: r.id,
      domain: r.domain,
      capability: r.capability,
      status: r.status,
      decidedAt: r.decided_at,
      requestedByKind: r.requested_by_kind,
      // Only a row that names one tool can become a per-tool policy; plan and
      // concierge approvals resolve to null and are ignored by the finder.
      toolName: r.payload_kind && r.payload_kind !== 'tool' ? null : canonicalToolName(toolNameFromApprovalPayload(r.payload)),
    })),
    toolCalls: (toolCallsResult.data ?? []).map((r) => ({
      toolName: canonicalToolName(r.tool_name) ?? r.tool_name,
      state: r.state,
      createdAt: r.created_at,
    })),
    existingPolicies: (policiesResult.data ?? []).map((p) => ({
      domain: p.domain, capability: p.capability, effect: p.effect, enabled: p.enabled, conditions: p.conditions,
    })),
    existingSuggestions: (suggestionsResult.data ?? []).map((s) => ({
      id: s.id, dedupe_key: s.dedupe_key, status: s.status, detail: s.detail, confidence: s.confidence,
    })),
  };
}

/** The candidates the family's history supports right now. Read-only. */
export async function loadPolicyCandidates(supabase: DB, familyId: string, now = new Date()): Promise<PolicyCandidate[]> {
  const history = await loadPolicyHistory(supabase, familyId, now);
  return findPolicyCandidates({ approvals: history.approvals, toolCalls: history.toolCalls, existingPolicies: history.existingPolicies, now });
}

export async function runPolicyScan(
  supabase: DB,
  familyId: string,
  userId: string | null,
  opts: { now?: Date } = {},
): Promise<PolicyScanResult> {
  const now = opts.now ?? new Date();
  const history = await loadPolicyHistory(supabase, familyId, now);
  const candidates = findPolicyCandidates({
    approvals: history.approvals,
    toolCalls: history.toolCalls,
    existingPolicies: history.existingPolicies,
    now,
  });
  const drafts = candidates.map((c) => policyCandidateToDraft(c, { now }));
  const draftKeys = new Set(drafts.map((d) => d.dedupeKey));
  const existingByKey = new Map(history.existingSuggestions.map((s) => [s.dedupe_key, s]));

  // 1) An OPEN policy suggestion whose streak broke this scan is withdrawn.
  //    Resolved rows stay: a dismissed offer is not re-made, an accepted one
  //    is the record of a policy the family holds.
  const stale = history.existingSuggestions.filter((s) => s.status === 'open' && !draftKeys.has(s.dedupe_key)).map((s) => s.id);
  if (stale.length > 0) {
    const { error } = await supabase.from('autopilot_suggestions').delete().in('id', stale).eq('family_id', familyId);
    if (error) throw new Error('Autopilot could not clear stale policy suggestions');
  }

  let inserted = 0;
  let refreshed = 0;
  for (const d of drafts) {
    const prior = existingByKey.get(d.dedupeKey);
    if (prior) {
      // The streak grew since the offer was made: say so on the open card.
      if (prior.status === 'open' && (prior.detail !== d.detail || prior.confidence !== d.confidence)) {
        const { error } = await supabase.from('autopilot_suggestions')
          .update({ detail: d.detail, confidence: d.confidence, payload: d.payload as never, expires_at: d.expiresAt })
          .eq('id', prior.id).eq('family_id', familyId);
        if (error) throw new Error('Autopilot could not refresh the policy suggestion');
        refreshed++;
      }
      continue;
    }
    const { error } = await supabase.from('autopilot_suggestions').insert({
      family_id: familyId,
      member_id: null,
      kind: d.kind,
      title: d.title,
      detail: d.detail,
      confidence: d.confidence,
      urgency: d.urgency,
      status: 'open',
      action_type: d.actionType,
      action_label: d.actionLabel,
      payload: d.payload as never,
      source_kind: d.sourceKind,
      source_id: null,
      dedupe_key: d.dedupeKey,
      expires_at: d.expiresAt,
      resolved_at: null,
      resolved_by: null,
      created_by: userId,
    });
    if (error) throw new Error('Autopilot could not save the policy suggestion');
    inserted++;
  }

  return { candidates: drafts.length, inserted, refreshed, cleared: stale.length };
}
