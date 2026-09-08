// lib/ai/explanation.ts — "Why this?" explanations for AI recommendations (T7).
//
// Every AI recommendation / automation in the app should be able to answer three
// questions inline: *why* was this surfaced, *what inputs* drove it, and how
// confident is Bubaly. This pure module turns each engine's output into one
// consistent, DOM-free `Explanation` the reusable <WhyThis> affordance renders.
// No I/O — the surfaces feed it already-loaded data. Fully unit-tested.

export type ExplanationFactor = {
  label: string;         // e.g. "Confidence"
  value: string;         // e.g. "92% — Bubaly can auto-handle"
  detail?: string;       // optional secondary line
};

export type Explanation = {
  reason: string;              // one-line "why this surfaced"
  factors: ExplanationFactor[]; // the concrete inputs used
  confidence?: number;         // 0..100 when the source is confidence-scored
  tip?: string;                // optional guidance / what happens next
};

// ── humanizers ──────────────────────────────────────────────────────────────

const titleCase = (s: string): string =>
  s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

const AUTOPILOT_KIND_LABEL: Record<string, string> = {
  groceries: 'grocery list', document: 'documents', appointment: 'appointments',
  chore: 'chores', birthday: 'birthdays', reminder: 'reminders',
  wellbeing: 'wellbeing signals', finance: 'finances', subscription: 'subscriptions',
  medication: 'medications', meal: 'meal plans', insurance: 'insurance',
  policy: 'approval history',
};

const SOURCE_LABEL: Record<string, string> = {
  grocery_items: 'grocery list', documents: 'documents', calendar_events: 'calendar',
  chore_assignments: 'chores', family_members: 'family profiles', family_reminders: 'reminders',
  subscriptions: 'subscriptions', medications: 'medications', meal_plans: 'meal history',
  behavior_logs: 'wellbeing signals', insurance_policies: 'insurance',
  approval_requests: 'approval history',
};

/** What accepting a learned-policy suggestion does — and, as importantly, what it does not. */
const POLICY_SUGGESTION_TIP =
  'Accepting writes one narrow policy: Bubaly may run this one tool in this one area without asking. '
  + 'Nothing runs until you accept, and you can switch the policy off any time in Trust → Policies.';

const INSIGHT_KIND_LABEL: Record<string, string> = {
  departure: 'Leave-earlier nudge', conflict: 'Schedule clash', homework: 'Homework due',
  approval: 'Waiting on you', reminder_overdue: 'Overdue reminder', renewal: 'Renewal due',
  document: 'Document expiring', meal: 'Unplanned dinners', grocery: 'Grocery run',
  autopilot: 'Autopilot suggestion',
};

const AGENT_LABEL: Record<string, string> = {
  chief: 'Chief of Staff', scheduler: 'Scheduler', finance: 'Finance', meals: 'Meals',
  health: 'Health', errands: 'Errands', school: 'School', social: 'Social',
  home: 'Home', travel: 'Travel', memory: 'Memory',
};

const humanAutopilotKind = (k: string) => AUTOPILOT_KIND_LABEL[k] ?? titleCase(k);
const humanSource = (s: string | null | undefined) => (s ? SOURCE_LABEL[s] ?? titleCase(s) : null);
const humanInsightKind = (k: string) => INSIGHT_KIND_LABEL[k] ?? titleCase(k);
const humanAgent = (a: string) => AGENT_LABEL[a] ?? titleCase(a);

/** Confidence → autopilot tier label + what happens next. */
export function confidenceNarrative(confidence: number): { label: string; tip: string } {
  if (confidence >= 90) return { label: 'high — Bubaly can auto-handle this', tip: 'High confidence: Bubaly can take this action automatically, or you can do it yourself.' };
  if (confidence >= 70) return { label: 'good — worth doing, with a quick OK', tip: 'Bubaly is fairly sure, so it asks for a one-tap confirmation before acting.' };
  return { label: 'low — surfaced for your awareness', tip: 'Lower confidence: this is shared as awareness, not an action Bubaly will take on its own.' };
}

const urgencyLabel = (u: number) => (u >= 3 ? 'high' : u === 2 ? 'medium' : 'low');

// ── builders (one per AI surface) ────────────────────────────────────────────

export type AutopilotLike = {
  kind: string;
  title: string;
  detail?: string | null;
  confidence: number;
  urgency?: number | null;
  source_kind?: string | null;
  action_label?: string | null;
};

/** Explain an Autopilot suggestion. */
export function explainAutopilot(s: AutopilotLike): Explanation {
  const kindLabel = humanAutopilotKind(s.kind);
  const src = humanSource(s.source_kind);
  const conf = confidenceNarrative(s.confidence);
  const factors: ExplanationFactor[] = [
    { label: 'Signal', value: titleCase(kindLabel), detail: src ? `read from your ${src}` : undefined },
    { label: 'Confidence', value: `${s.confidence}% — ${conf.label}` },
    { label: 'Urgency', value: urgencyLabel(s.urgency ?? 1) },
  ];
  if (s.action_label) factors.push({ label: 'Proposed action', value: s.action_label });
  return {
    reason: s.detail?.trim() || `Bubaly noticed this in your ${kindLabel}.`,
    factors,
    confidence: s.confidence,
    // A policy suggestion is never auto-handled, however sure Bubaly is: the
    // confidence tip would promise an action the scan is built never to take.
    tip: s.kind === 'policy' ? POLICY_SUGGESTION_TIP : conf.tip,
  };
}

// ── trust decisions ──────────────────────────────────────────────────────────

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** '12 August 2026' — UTC, so an audit line reads the same on every device. */
function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function tagsOf(conditions: unknown): string[] {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return [];
  const tags = (conditions as { tags?: unknown }).tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

export type TrustPolicyLike = {
  name: string;
  /** When the policy row was written — for an accepted suggestion, the day the family said yes. */
  created_at?: string | null;
  conditions?: unknown;
  effect?: string | null;
};

export type TrustDecisionLike = {
  /** allow | deny | require_approval | approved | rejected | emergency_override | … */
  decision: string;
  reason?: string | null;
  domain?: string | null;
  capability?: string | null;
  confidence?: number | null;
  /** The policy the decision cites, when the audit row names one and it still exists. */
  policy?: TrustPolicyLike | null;
};

/** True for a policy Autopilot proposed and a manager accepted, as opposed to one typed into the Trust form. */
export function isAcceptedPolicy(conditions: unknown): boolean {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return false;
  return (conditions as { source?: unknown }).source === 'autopilot';
}

/**
 * Explain a trust decision the audit trail recorded. When the decision came
 * from a policy the family accepted out of an Autopilot suggestion, the
 * explanation says so and names the day — "allowed by a policy you accepted
 * on 12 August 2026" — because that is the answer to "why did Bubaly not ask?".
 */
export function explainTrustDecision(d: TrustDecisionLike): Explanation {
  const policy = d.policy ?? null;
  const accepted = policy ? isAcceptedPolicy(policy.conditions) : false;
  const tools = policy ? tagsOf(policy.conditions).filter((t) => !t.includes(':')) : [];
  const allowed = d.decision === 'allow' || d.decision === 'auto_approve';
  const denied = d.decision === 'deny';

  let reason: string;
  if (policy && accepted && policy.created_at) {
    reason = allowed
      ? `Allowed by a policy you accepted on ${longDate(policy.created_at)}.`
      : denied
        ? `Blocked by a policy you accepted on ${longDate(policy.created_at)}.`
        : `Decided by a policy you accepted on ${longDate(policy.created_at)}.`;
  } else if (policy) {
    reason = allowed
      ? `Allowed by the household policy “${policy.name}”.`
      : denied
        ? `Blocked by the household policy “${policy.name}”.`
        : `Decided by the household policy “${policy.name}”.`;
  } else {
    reason = d.reason?.trim() || `${titleCase(d.decision)}${d.domain ? ` for ${titleCase(d.domain)}` : ''}.`;
  }

  const factors: ExplanationFactor[] = [{ label: 'Decision', value: titleCase(d.decision) }];
  if (d.domain) factors.push({ label: 'Area', value: titleCase(d.domain), detail: d.capability ? titleCase(d.capability) : undefined });
  if (policy) {
    factors.push({
      label: 'Policy',
      value: policy.name,
      detail: tools.length ? `only ${tools.join(', ')}` : accepted ? 'accepted from an Autopilot suggestion' : undefined,
    });
  }
  if (typeof d.confidence === 'number') factors.push({ label: 'Confidence', value: `${Math.round(d.confidence * 100)}%` });

  return {
    reason,
    factors,
    confidence: typeof d.confidence === 'number' ? Math.round(d.confidence * 100) : undefined,
    tip: policy
      ? 'Switch the policy off in Trust → Policies and Bubaly asks again.'
      : undefined,
  };
}

export type InsightLike = {
  kind: string;
  title: string;
  detail?: string | null;
  impact: number;
  /** How many other candidate insights were considered but not surfaced today. */
  alternatives?: number | null;
};

/** Explain the "insight of the day" — why THIS one won the single slot. */
export function explainInsight(i: InsightLike): Explanation {
  const factors: ExplanationFactor[] = [
    { label: 'Type', value: humanInsightKind(i.kind) },
    { label: 'Priority', value: `${Math.round(i.impact)}/100 impact` },
  ];
  if (typeof i.alternatives === 'number' && i.alternatives > 0) {
    factors.push({ label: 'Chosen over', value: `${i.alternatives} other signal${i.alternatives === 1 ? '' : 's'} today` });
  }
  return {
    reason: i.detail?.trim() || 'This is the single most time-sensitive thing on your plate right now.',
    factors,
    tip: 'Only one insight is surfaced at a time — dismiss it and the next-most-important takes its place.',
  };
}

export type AgentActivityLike = {
  agent: string;
  kind: string;          // insight | recommendation | action | handoff
  title: string;
  detail?: string | null;
  severity?: string | null;
};

/** Explain an agent activity item. */
export function explainAgentActivity(a: AgentActivityLike): Explanation {
  const factors: ExplanationFactor[] = [
    { label: 'Agent', value: humanAgent(a.agent) },
    { label: 'Type', value: titleCase(a.kind) },
  ];
  if (a.severity) factors.push({ label: 'Priority', value: titleCase(a.severity) });
  return {
    reason: a.detail?.trim() || a.title,
    factors,
    tip: `Your ${humanAgent(a.agent)} agent flagged this while watching that part of family life.`,
  };
}

export type ConsensusLike = {
  label: string;
  rationale: string;
  votes: number;
  votePct: number;
  blendedScore: number;
  totalVotes: number;
  consensusLevel: number;   // 0..1
  budgetCents?: number | null;
};

/** Explain a Group-Voting consensus recommendation (T6 → T7 reuse). */
export function explainConsensus(c: ConsensusLike): Explanation {
  const agreement = c.consensusLevel >= 0.6 ? 'strong agreement' : c.consensusLevel >= 0.4 ? 'leaning one way' : 'a split vote';
  const factors: ExplanationFactor[] = [
    { label: 'Votes', value: `${c.votes} (${c.votePct}% of ${c.totalVotes})` },
    { label: 'Overall fit', value: `${c.blendedScore}/100 (votes + budget + needs)` },
    { label: 'Family agreement', value: titleCase(agreement) },
  ];
  if (typeof c.budgetCents === 'number') {
    factors.push({ label: 'Budget checked', value: `$${(c.budgetCents / 100).toFixed(0)} cap` });
  }
  return {
    reason: c.rationale || `“${c.label}” best balances what the family wants with what actually fits.`,
    factors,
    tip: 'Bubaly weighs the vote against your budget and any dietary needs — the family still makes the final call.',
  };
}
