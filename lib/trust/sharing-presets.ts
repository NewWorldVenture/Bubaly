// lib/trust/sharing-presets.ts — plain-language, time-limited sharing presets.
//
// M23's permission model already exists in the database (permission_grants,
// trust_delegations) and is enforced by `evaluateTrust`. What was missing is a
// surface a parent can actually use: "the babysitter is here tonight" rather
// than "insert a delegation row over these eight domains with this expiry".
//
// This module is pure so the mapping preset → delegation payload can be tested
// exhaustively and so the SERVER decides the scope. The client only names a
// preset key; `createSharingPresetAction` looks it up here and hands the result
// to the existing `createDelegationAction`. A client that could pass its own
// domains and expiry would make the preset a suggestion rather than a rule.
//
// HONESTY BOUNDARY — read this before wording anything on top of it:
// a delegation grants AUTHORITY TO ACT (and to have Bubaly act) in the named
// domains. It does not scope what the person can READ: RLS is role-based
// (`is_family_member` vs `can_manage_family`, 0003/0266), so a caregiver or
// guest still sees the ordinary shared pages of the family they belong to.
// Per-member read scoping is M23's RLS migration (documents/notes/journal on
// member_id + a has_active_delegation() helper for sensitive tables); wider
// "care circle" sharing is M16. Neither is shipped, so nothing built on this
// module may say "they can only SEE …".

// TODO(M23 RLS migration): member-scoped RLS is what would make a preset bound
// READS as well as actions — policies on documents/notes/journal_entries that
// honour member_id (owner or can_manage_family), plus a
// has_active_delegation(family_id, domain) helper consulted by the sensitive
// tables. Until that ships, every sentence built on this module must say
// "actions".
// TODO(M16 care circles): one carer across several households is the wider
// version of the same idea and needs its own table; a delegation here is
// per-family by construction.

import {
  CAPABILITIES, HIGH_STAKES_AI_DOMAINS, ROLE_DEFAULTS, TRUST_DOMAINS,
  type Capability, type TrustDomain, type TrustRole,
} from '@/lib/trust/engine';

/** What a delegation actually governs — quoted by the UI, asserted by tests. */
export const SHARING_SCOPE = {
  /** Delegations gate actions through evaluateTrust. */
  governsActions: true,
  /** They do NOT bound Supabase reads. See the header note. */
  scopesReads: false,
} as const;

export type SharingPresetKey =
  | 'babysitter_tonight'
  | 'grandparent_this_week'
  | 'school_run_this_week'
  | 'away_for_the_weekend';

export type SharingPreset = {
  key: SharingPresetKey;
  /** English label, kept beside the key so non-UI callers (and this file's
   *  tests) read as prose; the UI renders `labelKey` through t(). */
  label: string;
  labelKey: string;
  description: string;
  descriptionKey: string;
  /** Domains the delegate may act in. Never a high-stakes domain — see below. */
  domains: TrustDomain[];
  /** How long the authority lasts, in hours. Delegations always expire. */
  durationHours: number;
  /** Stored on the row so the Trust page can say why it exists. */
  reason: string;
  reasonKey: string;
};

/**
 * The presets. Deliberately short and deliberately narrow:
 *
 *  - no preset names a HIGH_STAKES_AI_DOMAIN (medical, finances, banking,
 *    documents, passports, driving, insurance, emergency). Handing those over
 *    is a decision that deserves the full delegation form, not one tap;
 *  - every preset expires within a week, because "temporary" is the whole point
 *    of a delegation and an open-ended one is just a role change.
 */
export const SHARING_PRESETS: SharingPreset[] = [
  {
    key: 'babysitter_tonight',
    label: 'Babysitter tonight',
    labelKey: 'trustSharing.presetBabysitterTonight',
    description: 'Tonight only: the evening calendar, chores and dinner.',
    descriptionKey: 'trustSharing.presetBabysitterTonightWhat',
    domains: ['calendar', 'chores', 'meal_planning'],
    durationHours: 12,
    reason: 'Babysitting tonight',
    reasonKey: 'trustSharing.presetBabysitterTonightReason',
  },
  {
    key: 'grandparent_this_week',
    label: 'Grandparent this week',
    labelKey: 'trustSharing.presetGrandparentThisWeek',
    description: 'This week: the calendar, lifts and photos.',
    descriptionKey: 'trustSharing.presetGrandparentThisWeekWhat',
    domains: ['calendar', 'transportation', 'photos'],
    durationHours: 24 * 7,
    reason: 'Helping out this week',
    reasonKey: 'trustSharing.presetGrandparentThisWeekReason',
  },
  {
    key: 'school_run_this_week',
    label: 'School run this week',
    labelKey: 'trustSharing.presetSchoolRunThisWeek',
    description: 'This week: lifts, school forms and the calendar.',
    descriptionKey: 'trustSharing.presetSchoolRunThisWeekWhat',
    domains: ['transportation', 'school_forms', 'calendar'],
    durationHours: 24 * 5,
    reason: 'Covering the school run',
    reasonKey: 'trustSharing.presetSchoolRunThisWeekReason',
  },
  {
    key: 'away_for_the_weekend',
    label: 'Away for the weekend',
    labelKey: 'trustSharing.presetAwayForTheWeekend',
    description: 'Until Monday: the calendar, lifts, chores, meals and pets.',
    descriptionKey: 'trustSharing.presetAwayForTheWeekendWhat',
    domains: ['calendar', 'transportation', 'chores', 'meal_planning', 'pets'],
    durationHours: 24 * 3,
    reason: 'Away for the weekend',
    reasonKey: 'trustSharing.presetAwayForTheWeekendReason',
  },
];

export function findSharingPreset(key: string): SharingPreset | null {
  return SHARING_PRESETS.find((p) => p.key === key) ?? null;
}

/** Exactly the shape `createDelegationAction` takes — no extra fields, so the
 *  preset path cannot write anything the manual form could not. */
export type PresetDelegation = {
  fromMemberId: string;
  toMemberId: string;
  domains: string[];
  reason: string;
  expiresAt: string;
};

/**
 * Turn a preset into the delegation the existing action inserts.
 *
 * `now` is a parameter so the expiry is testable; `reason` lets the server pass
 * the translated wording (it is persisted and read back by the Trust page, so
 * it should be in the manager's language rather than always English).
 */
export function delegationFromPreset(
  preset: SharingPreset,
  input: { fromMemberId: string; toMemberId: string; now?: Date; reason?: string },
): PresetDelegation {
  const now = input.now ?? new Date();
  const expires = new Date(now.getTime() + preset.durationHours * 3_600_000);
  return {
    fromMemberId: input.fromMemberId,
    toMemberId: input.toMemberId,
    domains: [...preset.domains],
    reason: input.reason?.trim() || preset.reason,
    expiresAt: expires.toISOString(),
  };
}

// ── Per-member "what this means" summary ────────────────────────────────────

export type GrantRow = { member_id: string; domain: string; capability: string; effect: string };
export type DelegationRow = {
  to_member_id: string;
  domains: string[] | null;
  expires_at: string;
  revoked_at?: string | null;
  reason?: string | null;
};

export type MemberAccessSummary = {
  memberId: string;
  role: TrustRole;
  /** Capabilities the role holds by default. ACTIONS — never reads. */
  capabilities: Capability[];
  /** Domains where this role's writes still need a manager's approval. */
  approvalDomains: string[];
  /** Explicit per-member allow grants (they widen the role default). */
  allowed: { domain: string; capability: string }[];
  /** Explicit per-member deny grants. A deny always wins. */
  denied: { domain: string; capability: string }[];
  /** Domains currently delegated TO this member, deduped across delegations. */
  delegatedDomains: string[];
  /** The soonest expiry among those delegations, or null when there are none. */
  delegationExpiresAt: string | null;
  /** Can Bubaly act for this member without per-action approval? */
  automationTrusted: boolean;
};

const ROLE_KEYS = Object.keys(ROLE_DEFAULTS) as TrustRole[];
const isRole = (role: string): role is TrustRole => (ROLE_KEYS as string[]).includes(role);
const isKnownDomain = (d: string) => (TRUST_DOMAINS as readonly string[]).includes(d);
const isKnownCapability = (c: string) => (CAPABILITIES as readonly string[]).includes(c);

/**
 * Derive one member's effective authority from ROLE_DEFAULTS + their grants +
 * their live delegations. Read-only and honest by construction: everything it
 * reports is something the trust engine actually consults, and the delegation
 * half is filtered exactly the way `loadTrustInputs` filters it (not revoked,
 * not expired) so the panel cannot show authority that has already lapsed.
 */
export function summarizeMemberAccess(input: {
  memberId: string;
  role: string;
  grants: GrantRow[];
  delegations: DelegationRow[];
  now?: Date;
}): MemberAccessSummary {
  const now = input.now ?? new Date();
  const role: TrustRole = isRole(input.role) ? input.role : 'guest';
  const defaults = ROLE_DEFAULTS[role];

  const mine = input.grants.filter(
    (g) => g.member_id === input.memberId && isKnownDomain(g.domain) && isKnownCapability(g.capability),
  );

  const live = input.delegations.filter(
    (d) =>
      d.to_member_id === input.memberId &&
      !d.revoked_at &&
      new Date(d.expires_at).getTime() > now.getTime(),
  );

  const delegatedDomains = [...new Set(live.flatMap((d) => (d.domains ?? []).filter(isKnownDomain)))].sort();
  const expiries = live.map((d) => new Date(d.expires_at).getTime()).sort((a, b) => a - b);

  return {
    memberId: input.memberId,
    role,
    capabilities: [...defaults.capabilities],
    approvalDomains: [...defaults.sensitiveDomains],
    allowed: mine.filter((g) => g.effect === 'allow').map((g) => ({ domain: g.domain, capability: g.capability })),
    denied: mine.filter((g) => g.effect === 'deny').map((g) => ({ domain: g.domain, capability: g.capability })),
    delegatedDomains,
    delegationExpiresAt: expiries.length ? new Date(expiries[0]).toISOString() : null,
    automationTrusted: defaults.automationTrusted,
  };
}

/** True when a preset would hand over a domain that must never be one tap. */
export function presetTouchesHighStakes(preset: SharingPreset): boolean {
  return preset.domains.some((d) => HIGH_STAKES_AI_DOMAINS.includes(d));
}
