// lib/trust/edit-rule.ts — whether an approver's edit keeps a held request
// under the rule it was filed under.
//
// A held request is filed under a rule — "Under $50, one of us" (single), or
// "Money needs both of us" (two parents) — chosen by the family's policies for
// the arguments Bubaly asked with. The Edit path (`editAndApprove`, a stored
// edit that `decide()` or the run executor performs) lets an approver change
// those arguments, the amount included, and then releases them under the rule
// the ORIGINAL ask was filed under. So one parent could turn a $40 card filed
// single into $900 and release it alone, while the family's own rule for $900
// asks for both parents.
//
// So an edit is weighed the way the gate that filed the request weighed the
// ask: the same actor and role, domain, capability, tags and confidence, with
// the EDITED amount. If the family's rules would put the edited version under a
// different require_approval policy, or a stricter model or count, or refuse it
// outright, the edit is not this card's to approve: nothing changes, and the
// family asks Bubaly again so the new amount reaches the right people.
//
// Only the amount is read from the arguments (`conditionsSatisfied` reads
// `amountCents` and nothing else of them; the tags are the tool's, the subject
// and role the asker's), so an edit that leaves the amount where it was cannot
// move the request to another rule, and is answered without reading anything.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { conformNulls } from '@/lib/ai/schema-to-json';
import { effectiveRisk } from '@/lib/ai/family-settings';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import { thresholdFor } from '@/lib/approvals/threshold';
import { loadAISettingsFor } from '@/lib/services/ai-settings';
import { carriesAmount, readAmountCents, UNKNOWN_AMOUNT_CENTS } from '@/lib/trust/amount';
import { evaluateAction, toolTags, type Actor, type Capability, type Decision, type TrustRole } from '@/lib/trust/engine';
import { loadTrustInputs, roleOf } from '@/lib/trust/server';

type DB = SupabaseClient<Database>;
type ApprovalRow = Database['public']['Tables']['approval_requests']['Row'];

/** The columns that say how, for whom and under which rule a held request was filed. */
export type FiledRequest = Pick<
  ApprovalRow,
  'family_id' | 'domain' | 'capability' | 'requested_by_kind' | 'requested_by_member_id'
  | 'approval_model' | 'required_approvals' | 'policy_id' | 'confidence'
>;

/** `FiledRequest`'s columns, for a select. */
export const FILED_REQUEST_COLUMNS =
  'family_id, domain, capability, requested_by_kind, requested_by_member_id, approval_model, required_approvals, policy_id, confidence';

type RuleTool = Pick<ToolDefinition, 'name' | 'domain' | 'capability' | 'risk' | 'readOnly' | 'input'>;

export type EditedRequest = {
  row: FiledRequest;
  /**
   * Which gate filed it, which decides the context it evaluated:
   *  - `tool`: a `{ name, args }` row. lib/ai/tools/execute.ts files the
   *    registry's canonical name and tags it with `op:`, `risk:` (the family's
   *    own risk for the tool) and `domain:`; lib/trust/ai-gate.ts files the
   *    surface's legacy alias and tags it with both spellings only.
   *  - `step`: a held run step, filed under the executor's `approvalRuleFor`
   *    (the registry's risk, the tool's capability for a read).
   */
  filedBy: { kind: 'tool'; filedName: string } | { kind: 'step' };
  /** The registry tool the arguments are for; null when none is known. */
  tool: RuleTool | null;
  original: unknown;
  edited: unknown;
};

export type EditRuleVerdict = { ok: true } | { ok: false; reason: 'outside_rule' | 'unreadable' };

/**
 * The amount the gate reads from these arguments: through the tool's own schema
 * when they fit it, so a key the schema drops cannot speak for the amount. A
 * money field whose value cannot be read is unbounded, not absent.
 */
function amountOf(tool: RuleTool | null, args: unknown): number | null {
  let source = args;
  if (tool) {
    const parsed = tool.input.safeParse(conformNulls(tool.input, args));
    if (parsed.success) source = parsed.data;
  }
  const cents = readAmountCents(source);
  if (cents !== null) return cents;
  return carriesAmount(source) ? UNKNOWN_AMOUNT_CENTS : null;
}

/**
 * The role the filing gate evaluated: the asker's, re-read. A row Bubaly filed
 * for nobody came from a cron or an ownerless run, which the gates evaluate as
 * `adult` (`trustRoleFor` in execute.ts); an asker no longer active is
 * evaluated as the least-trusted role, never as the approver.
 */
async function askerRole(db: DB, row: FiledRequest): Promise<{ ok: true; role: TrustRole } | { ok: false }> {
  if (!row.requested_by_member_id) return { ok: true, role: row.requested_by_kind === 'ai' ? 'adult' : 'guest' };
  const { data, error } = await db
    .from('family_members')
    .select('role')
    .eq('id', row.requested_by_member_id)
    .eq('family_id', row.family_id)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.error('[trust/edit-rule] could not read who asked; the edit is not checked on a guess', { familyId: row.family_id, error });
    return { ok: false };
  }
  return { ok: true, role: roleOf((data as { role?: string } | null)?.role ?? null) };
}

/** The tags the filing gate put on the context; null when the family's settings could not be read. */
async function gateTags(db: DB, request: EditedRequest): Promise<string[] | null> {
  const { tool, filedBy, row } = request;
  if (filedBy.kind === 'step') {
    return tool
      ? [...toolTags(tool.name), `op:${tool.capability}`, `risk:${tool.risk}`, `domain:${tool.domain}`]
      : [`domain:${row.domain}`];
  }
  if (!tool || filedBy.filedName !== tool.name) return toolTags(filedBy.filedName, tool?.name ?? null);
  const settings = await loadAISettingsFor(db, row.family_id);
  if (!settings.ok) return null;
  return [...toolTags(tool.name), `op:${tool.capability}`, `risk:${effectiveRisk(settings.data, tool)}`, `domain:${tool.domain}`];
}

/**
 * Whether the family's answer for the edited version is one this request's
 * rule already covers. An allow is: the edited version needs less than the
 * card already asks. A deny is not. A require_approval is when it comes from
 * the policy the row was filed under (or from no policy), asks for no more
 * approvals than the row, and does not narrow who may give them.
 */
export function withinFiledRule(
  decision: Decision,
  row: Pick<FiledRequest, 'approval_model' | 'required_approvals' | 'policy_id'>,
): boolean {
  if (decision.effect === 'allow') return true;
  if (decision.effect === 'deny') return false;
  if (decision.basis === 'policy' && (decision.policyId ?? null) !== (row.policy_id ?? null)) return false;
  const now = thresholdFor(decision.approvalModel ?? 'single', decision.requiredApprovals ?? 1, 1);
  const filed = thresholdFor(row.approval_model ?? 'single', row.required_approvals ?? 1, 1);
  if (now.parentsOnly && !filed.parentsOnly) return false;
  if (decision.approvalModel === 'consensus' && row.approval_model !== 'consensus') return false;
  return now.required <= filed.required;
}

export async function editStaysWithinFiledRule(db: DB, request: EditedRequest): Promise<EditRuleVerdict> {
  const before = amountOf(request.tool, request.original);
  const after = amountOf(request.tool, request.edited);
  if (before === after) return { ok: true };

  const { row } = request;
  const role = await askerRole(db, row);
  if (!role.ok) return { ok: false, reason: 'unreadable' };
  const trust = await loadTrustInputs(db, row.family_id);
  if (trust.degraded) return { ok: false, reason: 'unreadable' };
  const tags = await gateTags(db, request);
  if (!tags) return { ok: false, reason: 'unreadable' };

  const actor: Actor = row.requested_by_kind === 'ai'
    ? { kind: 'ai_agent', id: 'bubaly', role: role.role }
    : { kind: 'member', id: row.requested_by_member_id ?? 'unknown', role: role.role };
  // A held step was weighed with its tool's own capability when the tool only
  // reads (`approvalRuleFor`); every other row records the capability it was
  // filed under, and 0480 keeps that column as filed.
  const capability: Capability = request.filedBy.kind === 'step'
    ? (!request.tool || !request.tool.readOnly ? 'automate' : request.tool.capability)
    : row.capability as Capability;
  const decision = evaluateAction({
    actor,
    domain: row.domain,
    capability,
    context: { confidence: row.confidence ?? 0.85, tags, ...(after !== null ? { amountCents: after } : {}) },
    policies: trust.policies,
    grants: trust.grants,
    delegations: trust.delegations,
    emergencyDomains: trust.emergencyDomains,
  });
  return withinFiledRule(decision, row) ? { ok: true } : { ok: false, reason: 'outside_rule' };
}
