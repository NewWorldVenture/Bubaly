// lib/autopilot/policy-candidates.ts — learn narrow, explainable trust policies
// from the approvals a family has already given.
//
// Every other autopilot suggestion is a rule over upcoming dates. This one
// reads the family's own history: when Bubaly has asked for the same thing —
// the same domain, capability and tool — and a parent has said yes at least
// three times, has never said no, and the tool has never failed, the household
// has effectively already decided. The candidate offers to write that decision
// down as ONE narrow `trust_policies` row: AI × domain × capability, scoped by
// `conditions.tags` to that single tool, so it can never widen into "Bubaly
// may do anything here".
//
// Pure and deterministic: the scan hands it rows it has already loaded and it
// returns candidates with their evidence. No I/O, so the thresholds, the
// evidence string and the confidence are all unit-tested.
import { DOMAIN_LABELS } from '@/lib/trust/engine';
import type { SuggestionDraft } from '@/lib/autopilot/engine';

/** The approvals a parent has to have given before a policy is offered. */
export const POLICY_MIN_APPROVALS = 3;
/** How far back the scan looks. Older history is a different household. */
export const POLICY_WINDOW_DAYS = 90;
/**
 * A policy candidate is never `auto`: accepting it hands Bubaly standing
 * permission, and that is a decision only a person makes. Capping the
 * confidence below `AUTO_THRESHOLD` (90) keeps the suggestion in "needs a quick
 * yes" no matter how long the streak — and it carries no auto-executable
 * action type anyway.
 */
export const POLICY_MAX_CONFIDENCE = 89;
export const POLICY_BASE_CONFIDENCE = 70;
/** Every extra approval past the minimum is worth this much confidence. */
export const POLICY_CONFIDENCE_PER_APPROVAL = 4;

/** Dedupe keys the policy scan owns; the main scan leaves them alone. */
export const POLICY_KEY_PREFIX = 'policy:';
export const POLICY_SUGGESTION_KIND = 'policy';
export const POLICY_ACTION_TYPE = 'accept_policy';

export type ApprovalHistoryRow = {
  id: string;
  domain: string;
  capability: string;
  /** pending | approved | rejected | modified | expired | cancelled */
  status: string;
  decidedAt: string | null;
  /** 'ai' when Bubaly filed it; a member-filed row is not Bubaly's proposal. */
  requestedByKind: string;
  /** Canonical tool name from `payload.name`; null for plan/concierge rows. */
  toolName: string | null;
};

export type ToolCallHistoryRow = {
  toolName: string;
  /** reserved | succeeded | failed */
  state: string;
  createdAt: string;
};

/** A policy the family already holds, so the scan does not offer it twice. */
export type ExistingAiPolicy = {
  domain: string;
  capability: string;
  effect: string;
  enabled: boolean;
  conditions: unknown;
};

export type PolicyCandidate = {
  domain: string;
  capability: string;
  toolName: string;
  approvals: number;
  rejections: number;
  /** Approved with edits — the proposal was not right as Bubaly made it. */
  corrections: number;
  failedCalls: number;
  succeededCalls: number;
  firstApprovedAt: string;
  lastApprovedAt: string;
  /** 'Approved 4 times since 12 Aug, never rejected' */
  evidence: string;
  /** 0–100, always below AUTO_THRESHOLD. */
  confidence: number;
  dedupeKey: string;
  title: string;
  actionLabel: string;
};

/** What an accepted suggestion asks the trust action to write. Persisted in `payload`. */
export type PolicyProposal = {
  domain: string;
  capability: string;
  tool: string;
  approvals: number;
  evidence: string;
  firstApprovedAt: string;
};

export type FindPolicyCandidatesInput = {
  approvals: ApprovalHistoryRow[];
  toolCalls: ToolCallHistoryRow[];
  /** Policies the family already has; a covered tool is not offered again. */
  existingPolicies?: ExistingAiPolicy[];
  now: Date | string;
  windowDays?: number;
  minApprovals?: number;
};

export function policyDedupeKey(domain: string, capability: string, toolName: string): string {
  return `${POLICY_KEY_PREFIX}${domain}:${capability}:${toolName}`;
}

export function isPolicySuggestionKey(dedupeKey: string): boolean {
  return dedupeKey.startsWith(POLICY_KEY_PREFIX);
}

/** `payload.name` of a tool approval, or null when the row is not one tool. */
export function toolNameFromApprovalPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const name = (payload as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '12 Aug' — UTC, so the same history reads the same on every machine. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function camelToWords(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().trim();
}

/**
 * 'reminders.create' → 'create reminders'; 'calendar.createEvent' → 'create
 * event in calendar'. Good enough to read in a suggestion title; the tool's
 * own description is not available to a pure module.
 */
export function humanizeToolName(toolName: string): string {
  const dot = toolName.indexOf('.');
  if (dot < 0) return camelToWords(toolName);
  const area = camelToWords(toolName.slice(0, dot));
  const verb = camelToWords(toolName.slice(dot + 1));
  if (!verb) return area;
  return verb.includes(' ') ? `${verb} in ${area}` : `${verb} ${area}`;
}

export function policyEvidence(approvals: number, firstApprovedAt: string): string {
  return `Approved ${approvals} times since ${shortDate(firstApprovedAt)}, never rejected`;
}

export function policyConfidence(approvals: number, minApprovals = POLICY_MIN_APPROVALS): number {
  const extra = Math.max(0, approvals - minApprovals);
  return Math.min(POLICY_MAX_CONFIDENCE, POLICY_BASE_CONFIDENCE + extra * POLICY_CONFIDENCE_PER_APPROVAL);
}

function tagsOf(conditions: unknown): string[] {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return [];
  const tags = (conditions as { tags?: unknown }).tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * True when an enabled AI allow policy already lets this tool through: one
 * scoped to the tool by tag, or a blanket one for the domain and capability
 * with no tag at all.
 */
export function policyCoversTool(policy: ExistingAiPolicy, domain: string, capability: string, toolName: string): boolean {
  if (!policy.enabled) return false;
  if (policy.effect !== 'allow' && policy.effect !== 'auto_approve') return false;
  if (policy.domain !== 'all' && policy.domain !== domain) return false;
  if (policy.capability !== 'all' && policy.capability !== capability) return false;
  const tags = tagsOf(policy.conditions);
  return tags.length === 0 || tags.includes(toolName) || tags.includes(`tool:${toolName}`);
}

type Bucket = {
  domain: string; capability: string; toolName: string;
  approvals: number; rejections: number; corrections: number;
  approvedAt: string[];
};

/**
 * Group the window's decided AI approvals by domain + capability + tool, and
 * keep the groups a parent approved at least `minApprovals` times with no
 * rejection, no correction and no failed call of that tool in the window.
 */
export function findPolicyCandidates(input: FindPolicyCandidatesInput): PolicyCandidate[] {
  const now = typeof input.now === 'string' ? new Date(input.now) : input.now;
  const windowDays = input.windowDays ?? POLICY_WINDOW_DAYS;
  const minApprovals = input.minApprovals ?? POLICY_MIN_APPROVALS;
  const sinceMs = now.getTime() - windowDays * 86400000;
  const inWindow = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= sinceMs && t <= now.getTime();
  };

  const buckets = new Map<string, Bucket>();
  for (const a of input.approvals) {
    if (a.requestedByKind !== 'ai') continue;
    if (!a.toolName) continue;
    if (!inWindow(a.decidedAt)) continue;
    if (a.status !== 'approved' && a.status !== 'rejected' && a.status !== 'modified') continue;
    const key = policyDedupeKey(a.domain, a.capability, a.toolName);
    let b = buckets.get(key);
    if (!b) {
      b = { domain: a.domain, capability: a.capability, toolName: a.toolName, approvals: 0, rejections: 0, corrections: 0, approvedAt: [] };
      buckets.set(key, b);
    }
    if (a.status === 'approved') { b.approvals += 1; b.approvedAt.push(a.decidedAt as string); }
    else if (a.status === 'rejected') b.rejections += 1;
    else b.corrections += 1;
  }

  const callsByTool = new Map<string, { failed: number; succeeded: number }>();
  for (const c of input.toolCalls) {
    if (!inWindow(c.createdAt)) continue;
    const entry = callsByTool.get(c.toolName) ?? { failed: 0, succeeded: 0 };
    if (c.state === 'failed') entry.failed += 1;
    else if (c.state === 'succeeded') entry.succeeded += 1;
    callsByTool.set(c.toolName, entry);
  }

  const existing = input.existingPolicies ?? [];
  const out: PolicyCandidate[] = [];
  for (const b of buckets.values()) {
    if (b.approvals < minApprovals) continue;
    if (b.rejections > 0 || b.corrections > 0) continue;
    const calls = callsByTool.get(b.toolName) ?? { failed: 0, succeeded: 0 };
    if (calls.failed > 0) continue;
    if (existing.some((p) => policyCoversTool(p, b.domain, b.capability, b.toolName))) continue;

    const sorted = [...b.approvedAt].sort();
    const firstApprovedAt = sorted[0];
    const lastApprovedAt = sorted[sorted.length - 1];
    out.push({
      domain: b.domain,
      capability: b.capability,
      toolName: b.toolName,
      approvals: b.approvals,
      rejections: 0,
      corrections: 0,
      failedCalls: 0,
      succeededCalls: calls.succeeded,
      firstApprovedAt,
      lastApprovedAt,
      evidence: policyEvidence(b.approvals, firstApprovedAt),
      confidence: policyConfidence(b.approvals, minApprovals),
      dedupeKey: policyDedupeKey(b.domain, b.capability, b.toolName),
      title: `Let Bubaly ${humanizeToolName(b.toolName)} without asking`,
      actionLabel: 'Trust Bubaly with this',
    });
  }

  // Strongest streak first; ties by key so the order is stable across scans.
  out.sort((a, b) => b.approvals - a.approvals || (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0));
  return out;
}

/** The suggestion row a candidate becomes. Never auto-executable: no reminder, no grocery, no policy is written by the scan. */
export function policyCandidateToDraft(c: PolicyCandidate, opts: { now: Date | string; windowDays?: number }): SuggestionDraft {
  const now = typeof opts.now === 'string' ? new Date(opts.now) : opts.now;
  const proposal: PolicyProposal = {
    domain: c.domain,
    capability: c.capability,
    tool: c.toolName,
    approvals: c.approvals,
    evidence: c.evidence,
    firstApprovedAt: c.firstApprovedAt,
  };
  return {
    kind: POLICY_SUGGESTION_KIND,
    title: c.title,
    detail: `${c.evidence}. ${DOMAIN_LABELS[c.domain] ?? c.domain} · ${c.toolName}`,
    confidence: c.confidence,
    urgency: 1,
    actionType: POLICY_ACTION_TYPE,
    actionLabel: c.actionLabel,
    payload: proposal as unknown as Record<string, unknown>,
    sourceKind: 'approval_requests',
    sourceId: null,
    memberId: null,
    dedupeKey: c.dedupeKey,
    // The evidence goes stale with the window it was counted in.
    expiresAt: new Date(now.getTime() + (opts.windowDays ?? POLICY_WINDOW_DAYS) * 86400000).toISOString(),
  };
}

/** Read a proposal back out of a persisted suggestion; null when it is not one. */
export function policyProposalFromPayload(payload: unknown): PolicyProposal | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.domain !== 'string' || typeof p.capability !== 'string' || typeof p.tool !== 'string') return null;
  if (!p.domain.trim() || !p.capability.trim() || !p.tool.trim()) return null;
  return {
    domain: p.domain.trim(),
    capability: p.capability.trim(),
    tool: p.tool.trim(),
    approvals: typeof p.approvals === 'number' ? p.approvals : 0,
    evidence: typeof p.evidence === 'string' ? p.evidence : '',
    firstApprovedAt: typeof p.firstApprovedAt === 'string' ? p.firstApprovedAt : '',
  };
}

/** The `trust_policies.name` an accepted proposal is saved under (≤160 chars by 0093's CHECK). */
export function acceptedPolicyName(proposal: Pick<PolicyProposal, 'tool'>): string {
  return `Bubaly may ${humanizeToolName(proposal.tool)}`.slice(0, 160);
}
