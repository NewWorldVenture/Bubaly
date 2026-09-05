// ════════════════════════════════════════════════════════════════════════════
// Family Trust & Permissions Engine — pure evaluation core.
//
// This module is deterministic and side-effect-free (no DB, no I/O) so it can be
// unit-tested exhaustively and run identically on client and server. The server
// loads policies/grants/delegations from Supabase and calls `evaluateAction`;
// the result drives whether an action runs, is denied, or needs approval.
//
// Evaluation order (least-privilege by default):
//   1. Emergency override   — an active emergency elevates listed domains to allow
//   2. Explicit deny grant  — a per-member deny always wins (safety)
//   3. Highest-priority matching policy whose conditions are satisfied
//   4. Explicit allow grant / delegation
//   5. Role-default capability matrix
//   6. Fallback: deny (nothing executes without a granted path)
// ════════════════════════════════════════════════════════════════════════════

export const TRUST_DOMAINS = [
  'medical', 'dental', 'vision', 'mental_health',
  'education', 'school_forms', 'homework',
  'transportation', 'driving', 'travel', 'passports',
  'finances', 'banking', 'subscriptions', 'shopping',
  'meal_planning', 'documents', 'photos',
  'messaging', 'phone_calls', 'email', 'sms',
  'calendar', 'scheduling', 'tasks', 'chores', 'rewards',
  'pets', 'insurance', 'home_maintenance', 'vehicles',
  'emergency',
] as const;
export type TrustDomain = (typeof TRUST_DOMAINS)[number];

export const CAPABILITIES = [
  'view', 'create', 'edit', 'delete', 'approve',
  'delegate', 'automate', 'share', 'archive', 'export',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type TrustRole =
  | 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

export type PolicyEffect = 'allow' | 'deny' | 'require_approval' | 'auto_approve';
export type ApprovalModel = 'single' | 'two_parent' | 'first_available' | 'consensus' | 'sequential';

/** Human-friendly domain labels for UI. */
export const DOMAIN_LABELS: Record<string, string> = {
  medical: 'Medical', dental: 'Dental', vision: 'Vision', mental_health: 'Mental Health',
  education: 'Education', school_forms: 'School Forms', homework: 'Homework',
  transportation: 'Transportation', driving: 'Driving', travel: 'Travel', passports: 'Passports',
  finances: 'Finances', banking: 'Banking', subscriptions: 'Subscriptions', shopping: 'Shopping',
  meal_planning: 'Meal Planning', documents: 'Documents', photos: 'Photos',
  messaging: 'Messaging', phone_calls: 'Phone Calls', email: 'Email', sms: 'SMS',
  calendar: 'Calendar', scheduling: 'Scheduling', tasks: 'Tasks', chores: 'Chores', rewards: 'Rewards',
  pets: 'Pets', insurance: 'Insurance', home_maintenance: 'Home Maintenance', vehicles: 'Vehicles',
  emergency: 'Emergency', all: 'All domains',
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve',
  delegate: 'Delegate', automate: 'Automate', share: 'Share', archive: 'Archive', export: 'Export',
};

// Domains where AI automation ALWAYS needs human review unless an explicit policy
// or grant says otherwise — regardless of which role the agent acts for. The
// spec is emphatic: "The AI must never assume authority it has not been granted",
// and large financial / medical / legal actions always need explicit approval.
export const HIGH_STAKES_AI_DOMAINS: string[] = [
  'medical', 'dental', 'vision', 'mental_health',
  'finances', 'banking', 'insurance', 'passports',
  'driving', 'documents', 'emergency',
];

// ── Default least-privilege capability matrix per role ──────────────────────
// Each role gets a set of capabilities it holds across ALL domains by default;
// `sensitiveDomains` are carved out to require approval even for otherwise-capable
// roles. Per-member grants and policies refine this further.
type RoleDefault = {
  capabilities: Capability[];
  // Domains where even a capable role's WRITE/automate actions need approval.
  sensitiveDomains: string[];
  // Can this role's actions be automated by AI without per-action approval?
  automationTrusted: boolean;
};

export const ROLE_DEFAULTS: Record<TrustRole, RoleDefault> = {
  parent: {
    capabilities: ['view', 'create', 'edit', 'delete', 'approve', 'delegate', 'automate', 'share', 'archive', 'export'],
    sensitiveDomains: [],
    automationTrusted: true,
  },
  adult: {
    capabilities: ['view', 'create', 'edit', 'delete', 'approve', 'delegate', 'automate', 'share', 'archive', 'export'],
    sensitiveDomains: ['banking', 'passports', 'emergency'],
    automationTrusted: true,
  },
  teen: {
    capabilities: ['view', 'create', 'edit', 'share'],
    sensitiveDomains: ['medical', 'dental', 'vision', 'finances', 'banking', 'driving', 'passports', 'insurance'],
    automationTrusted: false,
  },
  child: {
    capabilities: ['view', 'create'],
    sensitiveDomains: ['medical', 'dental', 'vision', 'mental_health', 'finances', 'banking', 'driving', 'travel', 'passports', 'insurance', 'documents'],
    automationTrusted: false,
  },
  caregiver: {
    capabilities: ['view', 'create', 'edit'],
    sensitiveDomains: ['finances', 'banking', 'passports', 'insurance', 'documents'],
    automationTrusted: false,
  },
  guest: {
    capabilities: ['view'],
    sensitiveDomains: [],
    automationTrusted: false,
  },
};

// ── Inputs ──────────────────────────────────────────────────────────────────
export type Actor = {
  kind: 'member' | 'ai_agent';
  /** member id, or AI agent name */
  id: string;
  /** the member's role (for ai_agent, the role of the user the agent acts for) */
  role: TrustRole;
  /** 0–100; influences automation thresholds */
  trustScore?: number;
};

export type PolicyConditions = {
  maxAmountCents?: number;
  minConfidence?: number;       // 0–1
  /** local "HH:MM" window the action must fall within */
  timeStart?: string;
  timeEnd?: string;
  /** only match when the action carries (any of) these tags */
  tags?: string[];
};

export type Policy = {
  id: string;
  domain: string;               // specific domain or 'all'
  capability: Capability | 'all';
  subjectKind: 'role' | 'member' | 'ai' | 'everyone';
  subjectRole?: string | null;
  subjectMemberId?: string | null;
  effect: PolicyEffect;
  conditions: PolicyConditions;
  approvalModel: ApprovalModel;
  requiredApprovals: number;
  priority: number;
  enabled: boolean;
};

export type Grant = {
  memberId: string;
  domain: string;
  capability: Capability;
  effect: 'allow' | 'deny';
};

export type Delegation = {
  toMemberId: string;
  /** empty = all delegable domains */
  domains: string[];
  startsAt: number;   // epoch ms
  expiresAt: number;  // epoch ms
  revoked: boolean;
};

export type ActionContext = {
  amountCents?: number;
  confidence?: number;          // 0–1, for AI actions
  tags?: string[];
  /** epoch ms; defaults to Date.now() at call site */
  now?: number;
  /** "HH:MM" local time of the action; derived if omitted */
  localTime?: string;
};

export type EvaluateInput = {
  actor: Actor;
  domain: string;
  capability: Capability;
  context?: ActionContext;
  policies?: Policy[];
  grants?: Grant[];
  delegations?: Delegation[];
  /** active emergency elevations: the domains currently elevated to allow */
  emergencyDomains?: string[];
};

export type Decision = {
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
  policyId?: string;
  approvalModel?: ApprovalModel;
  requiredApprovals?: number;
  /** the rule path that produced this, for explainability */
  basis: 'emergency' | 'deny_grant' | 'policy' | 'allow_grant' | 'delegation' | 'role_default' | 'risk_tier' | 'family_setting' | 'fallback';
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function withinTimeWindow(localTime: string | undefined, start?: string, end?: string): boolean {
  if (!start || !end) return true;
  if (!localTime) return false;
  const t = timeToMinutes(localTime); const s = timeToMinutes(start); const e = timeToMinutes(end);
  if (t == null || s == null || e == null) return true;
  // window may wrap past midnight (e.g. 22:00–06:00)
  return s <= e ? (t >= s && t <= e) : (t >= s || t <= e);
}

function conditionsSatisfied(c: PolicyConditions, ctx: ActionContext): boolean {
  if (c.maxAmountCents != null && (ctx.amountCents ?? 0) > c.maxAmountCents) return false;
  if (c.minConfidence != null && (ctx.confidence ?? 0) < c.minConfidence) return false;
  if (c.tags && c.tags.length > 0) {
    const tags = ctx.tags ?? [];
    if (!c.tags.some((t) => tags.includes(t))) return false;
  }
  if ((c.timeStart || c.timeEnd) && !withinTimeWindow(ctx.localTime, c.timeStart, c.timeEnd)) return false;
  return true;
}

function policyApplies(p: Policy, actor: Actor, domain: string, capability: Capability): boolean {
  if (!p.enabled) return false;
  if (p.domain !== 'all' && p.domain !== domain) return false;
  if (p.capability !== 'all' && p.capability !== capability) return false;
  switch (p.subjectKind) {
    case 'everyone': return true;
    case 'ai': return actor.kind === 'ai_agent';
    case 'role': return p.subjectRole === actor.role;
    case 'member': return p.subjectMemberId === actor.id && actor.kind === 'member';
    default: return false;
  }
}

function activeDelegationCoversDomain(dels: Delegation[], memberId: string, domain: string, now: number): boolean {
  return dels.some((d) =>
    !d.revoked && d.toMemberId === memberId && now >= d.startsAt && now <= d.expiresAt &&
    (d.domains.length === 0 || d.domains.includes(domain)));
}

// ── The core evaluator ───────────────────────────────────────────────────────
export function evaluateAction(input: EvaluateInput): Decision {
  const { actor, domain, capability } = input;
  const ctx: ActionContext = input.context ?? {};
  const now = ctx.now ?? Date.now();
  const policies = (input.policies ?? []).filter((p) => p.enabled);
  const grants = input.grants ?? [];
  const delegations = input.delegations ?? [];
  const emergencyDomains = input.emergencyDomains ?? [];

  // 1) Emergency override — listed domains are elevated to allow while active.
  if (emergencyDomains.includes(domain) || emergencyDomains.includes('all')) {
    return { effect: 'allow', reason: `Emergency mode is active for ${DOMAIN_LABELS[domain] ?? domain}; permissions are temporarily elevated.`, basis: 'emergency' };
  }

  // 2) Explicit per-member deny always wins (safety first).
  if (actor.kind === 'member') {
    const deny = grants.find((g) => g.memberId === actor.id && g.domain === domain && g.capability === capability && g.effect === 'deny');
    if (deny) return { effect: 'deny', reason: `${DOMAIN_LABELS[domain] ?? domain} · ${CAPABILITY_LABELS[capability]} is explicitly blocked for this member.`, basis: 'deny_grant' };
  }

  // 3) Highest-priority matching policy whose conditions hold.
  const matching = policies
    .filter((p) => policyApplies(p, actor, domain, capability) && conditionsSatisfied(p.conditions, ctx))
    .sort((a, b) => b.priority - a.priority);
  if (matching.length > 0) {
    const p = matching[0];
    if (p.effect === 'deny') return { effect: 'deny', reason: `Blocked by policy: ${DOMAIN_LABELS[domain] ?? domain}.`, policyId: p.id, basis: 'policy' };
    if (p.effect === 'allow' || p.effect === 'auto_approve') {
      return { effect: 'allow', reason: p.effect === 'auto_approve' ? 'Auto-approved by a household policy.' : 'Allowed by a household policy.', policyId: p.id, basis: 'policy' };
    }
    // require_approval
    return {
      effect: 'require_approval',
      reason: 'A household policy requires approval for this action.',
      policyId: p.id, approvalModel: p.approvalModel, requiredApprovals: p.requiredApprovals, basis: 'policy',
    };
  }

  // 4) Explicit per-member allow grant, or an active delegation covering the domain.
  if (actor.kind === 'member') {
    const allow = grants.find((g) => g.memberId === actor.id && g.domain === domain && g.capability === capability && g.effect === 'allow');
    if (allow) return { effect: 'allow', reason: 'Granted directly to this member.', basis: 'allow_grant' };
    if (activeDelegationCoversDomain(delegations, actor.id, domain, now)) {
      return { effect: 'allow', reason: `Allowed via an active delegation for ${DOMAIN_LABELS[domain] ?? domain}.`, basis: 'delegation' };
    }
  }

  // 5) Role-default capability matrix.
  const def = ROLE_DEFAULTS[actor.role];
  if (def) {
    const hasCap = def.capabilities.includes(capability);
    const readonly = capability === 'view';
    if (hasCap) {
      const sensitive = def.sensitiveDomains.includes(domain);
      const writey = !readonly;
      // AI automation of write actions in sensitive/high-stakes domains needs approval.
      if (actor.kind === 'ai_agent' && capability === 'automate') {
        const highStakes = HIGH_STAKES_AI_DOMAINS.includes(domain);
        if (!def.automationTrusted || sensitive || highStakes) {
          const why = highStakes ? `${DOMAIN_LABELS[domain] ?? domain} is a high-stakes area, so a person should review it`
            : def.automationTrusted ? 'this is a sensitive domain' : "a parent should review AI actions for this role";
          return { effect: 'require_approval', reason: `AI automation here needs review — ${why}.`, approvalModel: 'single', requiredApprovals: 1, basis: 'role_default' };
        }
        return { effect: 'allow', reason: 'Within this role’s automation trust.', basis: 'role_default' };
      }
      if (sensitive && writey) {
        return { effect: 'require_approval', reason: `${DOMAIN_LABELS[domain] ?? domain} is a sensitive area for a ${actor.role}; a parent should approve.`, approvalModel: 'single', requiredApprovals: 1, basis: 'role_default' };
      }
      return { effect: 'allow', reason: `Within a ${actor.role}'s default permissions.`, basis: 'role_default' };
    }
  }

  // 6) Fallback — least privilege.
  return { effect: 'deny', reason: `A ${actor.role} doesn't have ${CAPABILITY_LABELS[capability]} permission for ${DOMAIN_LABELS[domain] ?? domain}. Ask a parent to grant it.`, basis: 'fallback' };
}

// ── Dynamic trust score ──────────────────────────────────────────────────────
// A simple, explainable score in [0,100]. Starts at a role-appropriate baseline
// and moves with successful/failed outcomes + verification.
export function computeTrustScore(input: {
  role?: TrustRole;
  interactions: number;
  successes: number;
  verified?: boolean;
}): number {
  const base = input.role === 'parent' ? 80 : input.role === 'adult' ? 70 : input.role === 'teen' ? 50 : input.role === 'caregiver' ? 55 : input.role === 'child' ? 40 : 50;
  const n = Math.max(0, input.interactions);
  const successRate = n > 0 ? input.successes / n : 0.5;
  // reliability contributes up to +20, scaled by how much history we have (cap at 25 interactions)
  const confidence = Math.min(1, n / 25);
  const reliability = (successRate - 0.5) * 40 * confidence; // −10..+10 early, −20..+20 with history
  const verifiedBonus = input.verified ? 5 : 0;
  return Math.max(0, Math.min(100, Math.round(base + reliability + verifiedBonus)));
}

/** A short, human label for a score band. */
export function trustBand(score: number): 'low' | 'building' | 'trusted' | 'high' {
  if (score >= 85) return 'high';
  if (score >= 65) return 'trusted';
  if (score >= 40) return 'building';
  return 'low';
}

// ── Risk tiers for AI tool calls (§12) ───────────────────────────────────────
// `evaluateAction` above answers "may this actor touch this domain at all".
// It does not know how big the thing being asked for is: adding a soccer game
// and deleting the family's entire calendar are both `calendar` × `automate`.
// The tool registry attaches an honest risk tier to every tool
// (`lib/ai/tools/types.ts`), and `riskToDecision` turns that tier plus the
// family's autonomy behaviour into a decision.
//
// WHERE IT SITS IN THE ORDER — this is the whole point of returning `null`:
// the caller (`lib/ai/tools/execute.ts`) applies it only when
// `evaluateAction` landed on `role_default` or `fallback`. A household's own
// policy, an explicit grant, a delegation or an emergency elevation is a
// decision the family made deliberately and it always wins; the risk tier
// speaks only where the answer would otherwise have come from the generic
// role matrix. `null` means "the tier has nothing to add here" and leaves the
// engine's decision standing — it can tighten, never loosen.
//
// It is pure, so a planner can dry-run it without writing an audit row.

/** `family_ai_settings.behavior` (§11): what the family has told Bubaly it may do unasked. */
export type AutonomyBehavior = 'recommend' | 'prepare' | 'execute';

export type RiskDecisionInput = {
  /** The tool's declared tier, after any per-family `risk_overrides`. */
  risk: 'low' | 'medium' | 'high';
  actor: Actor;
  domain: string;
  /** `automate` for AI writes, `view` for reads — the capability actually evaluated. */
  capability: Capability;
  /**
   * The family's autonomy setting for this tool's category. Optional because
   * the storage for it (`family_ai_settings`, migration 0253) arrives with
   * P3-04; until then a family expresses the same intent through the
   * `subject_kind='ai'` trust policies the autopilot dial already writes, and
   * those are matched a whole layer earlier — so an absent behaviour means
   * "no household preference recorded", not "assume the most permissive one".
   */
  behavior?: AutonomyBehavior;
  /** True when an explicit allow policy/grant already matched this action. */
  explicitAllow?: boolean;
  /** Tools whose READ output is private even inside the family (finances, documents, health). */
  sensitiveRead?: boolean;
};

/** Roles a household would not hand a private read to without saying so. */
const RESTRICTED_READ_ROLES: TrustRole[] = ['teen', 'child', 'caregiver', 'guest'];

function isSensitiveDomainFor(role: TrustRole, domain: string): boolean {
  const def = ROLE_DEFAULTS[role];
  return HIGH_STAKES_AI_DOMAINS.includes(domain) || (def ? def.sensitiveDomains.includes(domain) : false);
}

/**
 * The risk tier's contribution, or `null` when it has none.
 *
 * Order inside the function matters as much as the function's place in the
 * chain: the view rule runs first because a read that should never have
 * happened cannot be undone by a later gate, then `high` (which is
 * unconditional), then the behaviour-driven `medium`, then `low`.
 */
export function riskToDecision(input: RiskDecisionInput): Decision | null {
  const { actor, domain, capability, risk } = input;
  const role = actor.role;
  const label = DOMAIN_LABELS[domain] ?? domain;

  // View-sensitivity (§4.2). ROLE_DEFAULTS grants `view` to every role in
  // every domain and its `sensitiveDomains` carve-out only bites on writes, so
  // without this a child could read the family's transactions through any
  // read tool. An explicit allow (a parent deliberately sharing the domain
  // with a teen) still wins, because it was matched before we got here.
  if (capability === 'view') {
    if (!input.explicitAllow && RESTRICTED_READ_ROLES.includes(role) && (input.sensitiveRead || isSensitiveDomainFor(role, domain))) {
      return {
        effect: 'deny',
        reason: `${label} details are private to the adults in this family. Ask a parent if you need them.`,
        basis: 'risk_tier',
      };
    }
    return null;
  }

  // High risk is destructive, expensive or hard to undo. A person decides,
  // every time, unless the family wrote a policy that says otherwise.
  if (risk === 'high') {
    if (input.explicitAllow) return null;
    return {
      effect: 'require_approval',
      reason: `This is a big change to ${label} — Bubaly wants a person to say yes first.`,
      approvalModel: 'single',
      requiredApprovals: 1,
      basis: 'risk_tier',
    };
  }

  if (risk === 'medium') {
    // 'recommend' means Bubaly may suggest and never act; 'prepare' means it
    // may stage the work for a person to release. 'execute' adds nothing here
    // — the role matrix (which still guards sensitive and high-stakes
    // domains) gets the final word.
    if (input.behavior === 'recommend') {
      return {
        effect: 'deny',
        reason: `Bubaly is set to recommend only, so it can suggest this ${label} change but not make it.`,
        basis: 'risk_tier',
      };
    }
    if (input.behavior === 'prepare') {
      return {
        effect: 'require_approval',
        reason: `Bubaly is set to prepare work for you, so this ${label} change is waiting on your yes.`,
        approvalModel: 'single',
        requiredApprovals: 1,
        basis: 'risk_tier',
      };
    }
    return null;
  }

  // Low risk: the small, reversible work a family wants done without being
  // asked twice — but never inside a domain the role treats as sensitive, and
  // never in a high-stakes one, where `evaluateAction`'s own gate must stand.
  if (isSensitiveDomainFor(role, domain)) return null;
  const def = ROLE_DEFAULTS[role];
  if (!def) return null;
  if (def.automationTrusted || role === 'teen') {
    return { effect: 'allow', reason: `A small, reversible ${label} change — Bubaly can just do it.`, basis: 'risk_tier' };
  }
  return null;
}
