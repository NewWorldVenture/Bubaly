// lib/trust/edit-rule.ts — whether releasing a held request, edited or as
// asked, keeps it under the rule it was filed under.
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
// move the request to another rule.
//
// THE RULE NOW, NOT ONLY THE EDIT (AUD-1028-AI-LEGACY). A card keeps the rule
// it was filed under for as long as it waits, and a plain yes released it on
// that rule without asking whether it still holds. A card filed before the
// held-step rule read its bound amount, or before a held step answered to a
// family's deny, carries "one of us" (single, no policy) for a $900 the
// family's rules now send to both parents, or refuse outright — and one yes
// released it, with the gate skipped. So every release — a plain yes, an edit,
// and the run executor resuming a step on a decided card — is weighed against
// the family's rules as they are now, for what it will run: a rule that
// refuses it outright, or that asks for more approvals or narrower approvers
// than the card carries, means this card cannot release it. Nothing is written,
// and the family declines it and asks Bubaly again. A card filed under the
// current rules is untouched by this: its own rule is the answer.
//
// AT THE CONFIDENCE IT WAS FILED AT, OR AT EVERY ONE IT MIGHT HAVE BEEN
// (AUD-1028-AI-CONFIDENCE). A rule may hang on `minConfidence`, and the engine
// applies that to a deny or a "both of us" as readily as to an allow — so no
// single stand-in for an unknown confidence is the cautious one: 0 hides a
// "when Bubaly is sure, both of us" rule, and 1 lets a "when Bubaly is sure,
// one of us" rule stand over the stricter one beneath it. When the confidence
// a card was filed at cannot be known, its release must hold at every
// confidence that changes which rules apply.
//
// WHOSE CONSENSUS (AUD-1028-AI-QUORUM). A consensus card needs everyone who
// can vote, which is a count of people, and the household changes. Which
// count governs is decided by WHEN the release is weighed (`quorum`):
//  - a pending card is released by a yes in `decide()`, which counts the votes
//    against the family's managers NOW (`thresholdOf`), so that is the count
//    the card carries against today's rule;
//  - a card already decided carries the decision `decide()` took — the yeses
//    it recorded, against the threshold it computed then. A member who joined
//    since is not asked again, one who left still voted, and the run executor
//    resuming the card weighs it at those recorded yeses (`recordedQuorum`):
//    what today's rule asks is compared with the votes the card has, never
//    with a membership the decision did not see.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { conformNulls } from '@/lib/ai/schema-to-json';
import { effectiveRisk } from '@/lib/ai/family-settings';
import type { ToolDefinition } from '@/lib/ai/tools/types';
import { thresholdFor } from '@/lib/approvals/threshold';
import { loadAISettingsFor } from '@/lib/services/ai-settings';
import { carriesAmount, readAmountCents, UNKNOWN_AMOUNT_CENTS } from '@/lib/trust/amount';
import { evaluateAction, riskTierStance, toolTags, type Actor, type Capability, type Decision, type Policy, type TrustRole } from '@/lib/trust/engine';
import { loadTrustInputs, roleOf } from '@/lib/trust/server';

type DB = SupabaseClient<Database>;
type ApprovalRow = Database['public']['Tables']['approval_requests']['Row'];

/** The columns that say how, for whom and under which rule a held request was filed. */
export type FiledRequest = Pick<
  ApprovalRow,
  'id' | 'family_id' | 'domain' | 'capability' | 'requested_by_kind' | 'requested_by_member_id'
  | 'approval_model' | 'required_approvals' | 'policy_id' | 'confidence'
>;

/** `FiledRequest`'s columns, for a select. */
export const FILED_REQUEST_COLUMNS =
  'id, family_id, domain, capability, requested_by_kind, requested_by_member_id, approval_model, required_approvals, policy_id, confidence';

/**
 * The confidence the run executor's `approvalRuleFor` weighs a held step at.
 * A held step's card is re-weighed at the same value, never at the row's
 * `confidence` column (see `filingConfidence`).
 */
export const HELD_STEP_CONFIDENCE = 0.85;

type RuleTool = Pick<ToolDefinition, 'name' | 'domain' | 'capability' | 'risk' | 'readOnly' | 'input'>;

export type ReleasedRequest = {
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
  /** The ask as filed (a held step's bindings resolved): what an edit is measured from. */
  asked: unknown;
  /** What the release runs: the approver's edit, or the ask itself. */
  released: unknown;
  /** Whether `released` is an approver's edit of `asked`. */
  edited: boolean;
  /**
   * False for a release that runs nothing itself — a plan's pure approval
   * step, or a row with no step parked on it — where only an edit is weighed.
   */
  runsWork?: boolean;
  /**
   * How many people a consensus counts at this release (see the top of this
   * file): the family's active managers now for a yes in `decide()`, the
   * card's recorded yeses (`recordedQuorum`) for a decided card the run
   * executor resumes. Omitted, 1 — the strictest reading of a consensus card.
   */
  quorum?: number;
};

/**
 * The quorum a decided card's decision was taken on: the distinct members it
 * records a yes from. 0389 freezes a decided row's votes, and 0381 let it
 * into approved/modified only with the yeses its model asked for then.
 */
export function recordedQuorum(approvals: unknown): number {
  if (!Array.isArray(approvals)) return 0;
  const yeses = new Set<string>();
  for (const vote of approvals) {
    if (!vote || typeof vote !== 'object') continue;
    const { member_id: member, decision } = vote as { member_id?: unknown; decision?: unknown };
    if (decision === 'approved' && typeof member === 'string' && member) yeses.add(member);
  }
  return yeses.size;
}

/**
 * - `outside_rule`: the approver's edit moved the request to another rule.
 * - `rule_changed`: the family's rules no longer let this card release what it
 *   runs — they refuse it outright, or ask more of it than the card carries.
 * - `unreadable`: the rules could not be read, and nothing is released on a guess.
 */
export type ReleaseVerdict = { ok: true } | { ok: false; reason: 'outside_rule' | 'rule_changed' | 'unreadable' };

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
    console.error('[trust/edit-rule] could not read who asked; the release is not checked on a guess', { familyId: row.family_id, error });
    return { ok: false };
  }
  return { ok: true, role: roleOf((data as { role?: string } | null)?.role ?? null) };
}

/** The tags the filing gate put on the context; null when the family's settings could not be read. */
async function gateTags(db: DB, request: ReleasedRequest): Promise<string[] | null> {
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
 * Whether a decision is a refusal no approval may lift: a rule the household
 * wrote about this very action — a deny policy (the Autopilot dial's "off"
 * included) or a member's deny grant. The gate leaves those standing whatever
 * the risk tier says (`riskTierStance` is `silent`), so it never files a card
 * for one. The role matrix's generic "no" (`fallback`) is not such a refusal:
 * the gate's risk tier speaks over it, and may itself ask a person.
 */
export function refusesOutright(decision: Decision): boolean {
  return decision.effect === 'deny' && riskTierStance(decision) === 'silent';
}

/**
 * Whether `decision` asks for more approvals, or narrower approvers, than the
 * row was filed with — a consensus on either side counted at `quorum` (see
 * `ReleasedRequest.quorum`).
 */
function asksMoreThanFiled(
  decision: Decision,
  row: Pick<FiledRequest, 'approval_model' | 'required_approvals'>,
  quorum: number,
): boolean {
  const now = thresholdFor(decision.approvalModel ?? 'single', decision.requiredApprovals ?? 1, quorum);
  const filed = thresholdFor(row.approval_model ?? 'single', row.required_approvals ?? 1, quorum);
  if (now.parentsOnly && !filed.parentsOnly) return true;
  if (decision.approvalModel === 'consensus' && row.approval_model !== 'consensus') return true;
  return now.required > filed.required;
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
  quorum = 1,
): boolean {
  if (decision.effect === 'allow') return true;
  if (decision.effect === 'deny') return false;
  if (decision.basis === 'policy' && (decision.policyId ?? null) !== (row.policy_id ?? null)) return false;
  return !asksMoreThanFiled(decision, row, quorum);
}

/**
 * Whether the card may still release what it was filed for, by the family's
 * rules as they are now. Not when a rule refuses it outright, nor when a rule
 * asks for more approvals or narrower approvers than the card carries — a
 * single card filed before "Money needs both of us" read its amount. Any other
 * answer (an allow, the role matrix's own "ask a person", a no the gate's risk
 * tier speaks over) is one the card's own rule already covers.
 *
 * Laxer than `withinFiledRule` about WHICH policy: a card filed under one rule
 * that a family re-saved, or that now matches a different rule asking no more,
 * still releases. What a release must never do is need less than today's rule.
 */
export function filedRuleStillHolds(
  decision: Decision,
  row: Pick<FiledRequest, 'approval_model' | 'required_approvals'>,
  quorum = 1,
): boolean {
  if (refusesOutright(decision)) return false;
  if (decision.effect === 'require_approval') return !asksMoreThanFiled(decision, row, quorum);
  return true;
}

/**
 * The confidence the request was filed at, from a record no approver can
 * change. The row's own `confidence` column is NOT that: 0251 lets a manager
 * rewrite any column of a pending row that 0381/0389/0480 do not pin, and
 * confidence is not pinned, so raising it would let a rule conditioned on
 * `minConfidence` release a card (or an edit) that today's rules would send
 * to more people (#1028 review: RV-1028-CONF, AMT-EDIT-CONF).
 *
 *  - A held step was weighed at HELD_STEP_CONFIDENCE, always.
 *  - A card a gate filed has the confidence that gate weighed in its filing
 *    line in `trust_audit_logs` (`evaluateTrust` writes it with the
 *    approval's id), a table only the service role writes (0260).
 *
 * No filing line, or none that recorded a confidence, is UNKNOWN (`null`),
 * not 0 (AUD-1028-AI-CONFIDENCE): 0 is cautious only for a rule that relaxes
 * when Bubaly is sure, and the engine applies `minConfidence` to a deny or a
 * "both of us" too, which 0 would hide. The caller weighs an unknown
 * confidence at every value that matters (`confidencesThatMatter`). Not ok
 * when the ledger cannot be read, so the caller answers "unreadable".
 */
async function filingConfidence(db: DB, request: ReleasedRequest): Promise<{ ok: true; confidence: number | null } | { ok: false }> {
  if (request.filedBy.kind === 'step') return { ok: true, confidence: HELD_STEP_CONFIDENCE };
  const { data, error } = await db.from('trust_audit_logs')
    .select('confidence, created_at')
    .eq('family_id', request.row.family_id)
    .eq('approval_id', request.row.id)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) {
    console.error('[trust/edit-rule] could not read the confidence a request was filed at', { approvalId: request.row.id, code: error.code });
    return { ok: false };
  }
  const filed = (data ?? [])[0]?.confidence;
  return { ok: true, confidence: typeof filed === 'number' && Number.isFinite(filed) ? filed : null };
}

/**
 * Every confidence at which the family's rules can answer differently: 0, 1,
 * and each enabled policy's `minConfidence` between them. The engine reads a
 * confidence only as `confidence >= minConfidence` (`conditionsSatisfied`),
 * so which policies apply is constant from one threshold up to the next, and
 * these points between them reach every answer a confidence in [0, 1] can.
 */
function confidencesThatMatter(policies: readonly Policy[]): number[] {
  const points = new Set<number>([0, 1]);
  for (const policy of policies) {
    const raw = policy.enabled ? policy.conditions?.minConfidence : null;
    if (raw === null || raw === undefined) continue;
    // A jsonb value the engine compares as a number, whatever it was saved as.
    const threshold = Number(raw);
    if (Number.isFinite(threshold)) points.add(Math.min(1, Math.max(0, threshold)));
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * The family's answers for this request at a given amount, evaluated as the
 * gate that filed it evaluated the ask: one, at the confidence it was filed
 * at, or one per confidence that matters when that is unknown — and the
 * release must hold under every one. Null when what that needs cannot be read.
 */
async function ruleFor(db: DB, request: ReleasedRequest): Promise<((amountCents: number | null) => Decision[]) | null> {
  const { row } = request;
  const role = await askerRole(db, row);
  if (!role.ok) return null;
  const trust = await loadTrustInputs(db, row.family_id);
  if (trust.degraded) return null;
  const tags = await gateTags(db, request);
  if (!tags) return null;

  const actor: Actor = row.requested_by_kind === 'ai'
    ? { kind: 'ai_agent', id: 'bubaly', role: role.role }
    : { kind: 'member', id: row.requested_by_member_id ?? 'unknown', role: role.role };
  // A held step was weighed with its tool's own capability when the tool only
  // reads (`approvalRuleFor`); every other row records the capability it was
  // filed under, and 0480 keeps that column as filed.
  const capability: Capability = request.filedBy.kind === 'step'
    ? (!request.tool || !request.tool.readOnly ? 'automate' : request.tool.capability)
    : row.capability as Capability;
  const filed = await filingConfidence(db, request);
  if (!filed.ok) return null;
  const confidences = filed.confidence !== null ? [filed.confidence] : confidencesThatMatter(trust.policies);
  return (amountCents) => confidences.map((confidence) => evaluateAction({
    actor,
    domain: row.domain,
    capability,
    context: { confidence, tags, ...(amountCents !== null ? { amountCents } : {}) },
    policies: trust.policies,
    grants: trust.grants,
    delegations: trust.delegations,
    emergencyDomains: trust.emergencyDomains,
  }));
}

/**
 * Whether releasing this request keeps it under the rule it was filed under:
 * an approver's edit that moved the amount is weighed as `withinFiledRule`
 * weighs it, and whatever runs — the edit or the ask — must still be
 * releasable by this card under the family's rules now (`filedRuleStillHolds`).
 * Both hold under every answer `ruleFor` gives, each consensus counted at the
 * request's `quorum`.
 */
export async function releaseStaysWithinFiledRule(db: DB, request: ReleasedRequest): Promise<ReleaseVerdict> {
  const after = amountOf(request.tool, request.released);
  const weighsEdit = request.edited && amountOf(request.tool, request.asked) !== after;
  const weighsRule = request.runsWork !== false;
  if (!weighsEdit && !weighsRule) return { ok: true };

  const rule = await ruleFor(db, request);
  if (!rule) return { ok: false, reason: 'unreadable' };
  const decisions = rule(after);
  const quorum = request.quorum ?? 1;
  if (weighsEdit && !decisions.every((decision) => withinFiledRule(decision, request.row, quorum))) {
    return { ok: false, reason: 'outside_rule' };
  }
  if (weighsRule && !decisions.every((decision) => filedRuleStillHolds(decision, request.row, quorum))) {
    return { ok: false, reason: 'rule_changed' };
  }
  return { ok: true };
}
