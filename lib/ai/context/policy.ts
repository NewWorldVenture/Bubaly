// lib/ai/context/policy.ts — what a prompt may know about a family.
//
// WHY: §4 says a child must not inspect household finances or confidential
// documents, and §27 says a meal plan must never see passports or insurance.
// Both are decided HERE, before any slice runs, rather than inside each slice:
// a deny-list of tables no slice may read, and a per-slice visibility rule
// keyed on the viewer's role. `tests/context-policy.test.ts` ratchets the first
// statically (no file under `slices/` may select from a denied table) and the
// second behaviourally (a child's bundle never carries the money slice).
//
// The deny-list is explicit and long on purpose. A short list of "obviously
// sensitive" tables invites the next slice author to read `medications` for a
// well-meaning morning brief; naming every table that carries health, location,
// credential or account-number detail makes the omission a deliberate, reviewed
// change instead of an accident.
//
// This module also hosts the shared slice types (`SliceEnv`, `SliceResult`,
// `SliceDefinition`). They live here rather than in the builder because policy
// is what a slice is written against: the env tells it who is asking and what
// they may see, and the result is what the builder renders and persists.
import 'server-only';
import type { FamilyMember } from '@/lib/services/family';
import type { ServiceResult, ServiceScope } from '@/lib/services/types';
import { isManager } from '@/lib/constants/roles';
import { sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import type { SliceName } from './intents';

/**
 * Tables no context slice may select from, with the reason. A few carry an
 * `except` naming the one column or the service that may surface a narrow
 * projection (allergies from a medical profile, a document's title) — that
 * projection is done inside the domain service, which is what the static test
 * allows: slices call services, never these tables.
 */
export const SENSITIVE_TABLES: ReadonlyArray<{ table: string; reason: string; except?: string }> = [
  // Credentials and tokens — absolute, no exception.
  { table: 'family_credentials', reason: 'passwords and logins' },
  { table: 'child_logins', reason: 'child login credentials' },
  { table: 'social_account_tokens', reason: 'OAuth tokens' },
  { table: 'sync_tokens', reason: 'calendar/provider tokens' },
  { table: 'admin_integrations', reason: 'provider secrets' },
  // Document bodies and confidential household records.
  { table: 'documents', reason: 'file contents and storage paths', except: 'title/category/expiry via services/documents listDocuments' },
  { table: 'vacation_documents', reason: 'passport and ticket scans' },
  { table: 'tax_documents', reason: 'tax filings' },
  { table: 'paperwork_items', reason: 'scanned paperwork bodies' },
  { table: 'household_info', reason: 'rows flagged is_sensitive (alarm codes, wifi keys)' },
  { table: 'insurance_policies', reason: 'policy numbers' },
  { table: 'family_insurance_policies', reason: 'policy numbers' },
  { table: 'auto_insurance_policies', reason: 'policy numbers' },
  { table: 'home_warranties', reason: 'warranty account numbers' },
  // Health — everything past the allergy/diet flags a meal plan needs.
  { table: 'medical_profiles', reason: 'conditions, physicians, emergency contacts', except: 'allergies column via services/meals foodProfile' },
  { table: 'medications', reason: 'prescriptions' },
  { table: 'medication_schedules', reason: 'prescriptions' },
  { table: 'medication_doses', reason: 'prescriptions' },
  { table: 'health_visits', reason: 'visit notes' },
  { table: 'health_providers', reason: 'clinicians' },
  { table: 'health_metrics', reason: 'measurements' },
  { table: 'health_goals', reason: 'health targets' },
  { table: 'immunizations', reason: 'vaccination records' },
  { table: 'symptom_logs', reason: 'symptoms' },
  { table: 'care_log', reason: 'care notes' },
  { table: 'vacation_medical_information', reason: 'travel medical detail' },
  { table: 'sleep_logs', reason: 'sleep tracking' },
  { table: 'sleep_checkins', reason: 'sleep tracking' },
  { table: 'nutrition_logs', reason: 'per-person intake' },
  { table: 'behavior_logs', reason: 'behaviour notes about children' },
  { table: 'journal_entries', reason: 'private journals' },
  // Emergency and location.
  { table: 'family_emergency_contacts', reason: 'emergency contacts' },
  { table: 'family_emergency_plans', reason: 'emergency plans' },
  { table: 'emergency_sessions', reason: 'active emergencies' },
  { table: 'vacation_emergency_contacts', reason: 'emergency contacts' },
  { table: 'member_locations', reason: 'live location' },
  { table: 'location_events', reason: 'location history' },
  { table: 'safety_check_ins', reason: 'check-in locations' },
  { table: 'driving_trips', reason: 'driving telemetry' },
  { table: 'driver_licenses', reason: 'licence numbers' },
  { table: 'vehicle_registrations', reason: 'registration numbers' },
  { table: 'rides', reason: 'ride locations' },
  { table: 'weather_locations', reason: 'stored coordinates' },
  // Money instruments — balances by category are fine (money slice, managers); account numbers never.
  { table: 'financial_accounts', reason: 'account numbers' },
  { table: 'stripe_financial_accounts', reason: 'account numbers' },
  { table: 'stripe_issuing_cards', reason: 'card numbers' },
  { table: 'stripe_cardholders', reason: 'cardholder identity' },
  { table: 'stripe_authorizations', reason: 'card authorisations' },
  { table: 'stripe_connected_accounts', reason: 'payout accounts' },
  { table: 'wallet_cards', reason: 'card details' },
  { table: 'wallet_transactions', reason: 'per-child card activity' },
  { table: 'wallet_passes', reason: 'stored passes' },
  { table: 'child_wallets', reason: 'child balances' },
  { table: 'family_wallets', reason: 'wallet balances' },
  { table: 'billing_customers', reason: 'billing identity' },
  { table: 'checkout_sessions', reason: 'payment sessions' },
  { table: 'pay_handles', reason: 'payment handles' },
  { table: 'babysitter_payments', reason: 'payment detail' },
  { table: 'gift_payments', reason: 'payment detail' },
  { table: 'invest_holdings', reason: 'investment positions' },
  { table: 'invest_orders', reason: 'investment orders' },
  // Private conversations — other people's messages are not the requester's context.
  { table: 'family_messages', reason: 'private messages' },
  { table: 'family_conversations', reason: 'private messages' },
  { table: 'family_inbox_messages', reason: 'inbound mail bodies' },
  { table: 'call_logs', reason: 'call recordings and transcripts' },
  { table: 'ai_messages', reason: 'other conversations' },
];

/** Table names only, for the static ratchet and quick membership checks. */
export const SENSITIVE_TABLE_NAMES: ReadonlySet<string> = new Set(SENSITIVE_TABLES.map((t) => t.table));

export function isSensitiveTable(table: string): boolean {
  return SENSITIVE_TABLE_NAMES.has(table);
}

/**
 * Per-slice visibility. `managerOnly` slices need `can_manage_family`
 * (parent | adult) or a system actor; there is no override — an intent that
 * "requires" money for a child still does not get it, because §4 puts that
 * rule above the request.
 */
export const SLICE_ACCESS: Record<SliceName, { managerOnly: boolean; note: string }> = {
  people: { managerOnly: false, note: 'names, roles, ages — no contact details' },
  schedule: { managerOnly: false, note: 'events, routines, conflicts, timing constraints' },
  activities: { managerOnly: false, note: 'school classes/events/homework, teams, practices' },
  food: { managerOnly: false, note: 'allergies, diet, likes, recent and planned meals, recipes' },
  shopping: { managerOnly: false, note: 'open grocery items, low or expiring pantry, shopping habits' },
  tasks: { managerOnly: false, note: 'open to-dos and chores, per-member load, rebalance moves' },
  money: { managerOnly: true, note: 'budgets vs actual, savings goals, bills due — adults only (§4)' },
  home: { managerOnly: false, note: 'home, vehicles (no VIN/plate), pets, open maintenance' },
  vendors: { managerOnly: false, note: 'saved contractors; contact details for managers only' },
  travel: { managerOnly: false, note: 'live trips and travel preferences' },
  documents: { managerOnly: true, note: 'titles, categories and expiry only — adults only (§4)' },
  memory: { managerOnly: false, note: 'confirmed facts; medical/account categories for managers only' },
  proactive: { managerOnly: false, note: 'reasoning report, signals, pending suggestions and recommendations' },
  moving: { managerOnly: true, note: 'the move on file and what needs a new address: subscriptions, bills, schools, vets — adults only (§4)' },
};

/** Who is looking, as the slices see it. */
export type Viewer = {
  role: ServiceScope['role'];
  memberId: string | null;
  /** parent | adult | system — the roles allowed to see manager-only slices. */
  canManage: boolean;
};

export function viewerFor(scope: Pick<ServiceScope, 'role' | 'memberId'>): Viewer {
  return {
    role: scope.role,
    memberId: scope.memberId,
    canManage: scope.role === 'system' || isManager(scope.role),
  };
}

export type SliceAccessDecision = { allowed: true } | { allowed: false; reason: string };

export function canViewSlice(slice: SliceName, viewer: Pick<Viewer, 'canManage'>): SliceAccessDecision {
  const rule = SLICE_ACCESS[slice];
  if (rule.managerOnly && !viewer.canManage) {
    return { allowed: false, reason: `${slice} is only shown to the adults who manage the family` };
  }
  return { allowed: true };
}

/**
 * Apply the policy to a requested slice list. Returns the slices that may run,
 * in the order given (the order IS the trim priority), and the names withheld,
 * which the builder persists on `ai_request_context.sensitive_omitted`.
 */
export function applySlicePolicy(slices: SliceName[], viewer: Pick<Viewer, 'canManage'>): { allowed: SliceName[]; omitted: SliceName[] } {
  const allowed: SliceName[] = [];
  const omitted: SliceName[] = [];
  const seen = new Set<SliceName>();
  for (const slice of slices) {
    if (seen.has(slice)) continue;
    seen.add(slice);
    if (canViewSlice(slice, viewer).allowed) allowed.push(slice);
    else omitted.push(slice);
  }
  return { allowed, omitted };
}

// ── Shared slice contract ───────────────────────────────────────────────────

/** Everything a slice needs beyond the scope, computed once per build. */
export type SliceEnv = {
  now: Date;
  tz: string;
  /** YYYY-MM-DD in the family's zone. */
  todayKey: string;
  /** ISO instants bounding "the coming week": local midnight today → +7 days. */
  weekFromIso: string;
  weekToIso: string;
  viewer: Viewer;
  /** The active roster, loaded once and shared so slices resolve names without re-querying. */
  members: FamilyMember[];
  pageContext: { module?: string; entityIds?: string[] } | null;
};

/**
 * What one slice hands back. `data` is the structured, already-redacted view
 * that is persisted on the snapshot; `lines` is the prompt rendering with
 * every row-derived string already fenced; `count` is what `context_stats`
 * records so a reviewer can see how much of the household a request saw.
 */
export type SliceResult = {
  data: unknown;
  count: number;
  lines: string[];
};

export type SliceDefinition = {
  name: SliceName;
  /** Section heading in the prompt. */
  title: string;
  load: (scope: ServiceScope, env: SliceEnv) => Promise<ServiceResult<SliceResult>>;
};

/** Longest display name that appears in a prompt line. */
export const MAX_NAME_CHARS = 40;

/**
 * A member's display name for an id, or null — never the raw id in a prompt.
 *
 * Names are row-derived text too, but they recur on almost every line (who an
 * event is for, who a chore is assigned to), and a fence around each mention
 * would cost more budget than the roster itself. So the roster fences each
 * name once (the `people` slice), and every other mention is sanitised and
 * cut to `MAX_NAME_CHARS` — short enough that a name cannot carry a working
 * instruction, and already introduced to the model as data.
 */
export function memberName(env: Pick<SliceEnv, 'members'>, memberId: string | null | undefined): string | null {
  if (!memberId) return null;
  const member = env.members.find((m) => m.id === memberId);
  return member ? displayName(member.displayName) : null;
}

/** The sanitised, length-capped form of any person's name used outside the roster. */
export function displayName(name: string): string {
  return sanitizeUntrusted(name, MAX_NAME_CHARS) || 'Unnamed';
}
