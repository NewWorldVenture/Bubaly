// Call-level role tests for every server action in
// app/(app)/dashboard/trust/actions.ts (Register B, group 6).
//
// THE POLICY THESE PIN, from the sources rather than from the actions:
//   - 0093_trust_engine.sql is the last migration that creates or alters a write
//     policy on trust_policies, permission_grants, trust_delegations and
//     emergency_sessions, and all four say `fm.role IN ('parent','adult')`
//     ("members of the family can read; managers (parent/adult) write").
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - app/(app)/dashboard/trust/page.tsx hands the module `canManage={isManager(...)}`,
//     so only a manager is offered a control on this page.
//   - Approvals: lib/services/approvals `openForDecision` refuses a non-manager,
//     and the action's own comment calls its check "the early, friendly refusal".
// So a parent or adult writes; a teen, child, caregiver or guest is refused and
// nothing changes; a signed-out caller is redirected by requireUserContext.
//
// Two households are seeded: A (the caller's) and B (another family). Every id
// argument that belongs to B must be refused or match nothing, and neither
// household's rows may change.
//
// TIME WINDOWS ARE NOT PINNED HERE. Open PR #1175 changes how policy time
// windows are evaluated (lib/trust/engine.ts, lib/trust/server.ts); no case
// below writes or reads a `conditions.timeStart`/`timeEnd`.
//
// The seams: the session (requireUserContext), the database (createServer and
// createServiceClient both answer the in-memory client, so the ledger rows the
// service-role writer adds are readable), next/cache, the translator (the real
// en-US catalogue, the sentences asserted are typed out), and
// loadPolicyCandidates — the family's approval-history scan — which
// acceptPolicySuggestionAction re-derives a proposal from; it is stubbed with
// one supported candidate, as tests/autopilot-persistence-boundaries.test.ts
// does. Everything else, the approvals service included, is the real code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  signedOut: false,
  candidates: [] as unknown[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // What next/navigation's redirect() does: it throws, it does not return.
    if (harness.signedOut) throw new Error('NEXT_REDIRECT;replace;/login;307;');
    return harness.ctx;
  },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/autopilot/policy-scan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/autopilot/policy-scan')>()),
  loadPolicyCandidates: async () => harness.candidates,
}));
// decide() kicks the run executor after a decision; nothing here has a run.
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const {
  acceptPolicySuggestionAction, activateEmergencyAction, createDelegationAction, createSharingPresetAction,
  decideApprovalAction, deletePolicyAction, endEmergencyAction, revokeDelegationAction, savePolicyAction,
  setPermissionGrantAction, togglePolicyAction,
} = await import('@/app/(app)/dashboard/trust/actions');

// ── Fixtures: fixed fake ids, example.com addresses ──────────────────────────
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
const MEMBER: Record<Role, string> = {
  parent: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  adult: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  teen: 'aaaaaaaa-0000-4000-8000-0000000000a3',
  child: 'aaaaaaaa-0000-4000-8000-0000000000a4',
  caregiver: 'aaaaaaaa-0000-4000-8000-0000000000a5',
  guest: 'aaaaaaaa-0000-4000-8000-0000000000a6',
};
const USER: Record<Role, string> = {
  parent: 'aaaaaaaa-0000-4000-8000-0000000000c1',
  adult: 'aaaaaaaa-0000-4000-8000-0000000000c2',
  teen: 'aaaaaaaa-0000-4000-8000-0000000000c3',
  child: 'aaaaaaaa-0000-4000-8000-0000000000c4',
  caregiver: 'aaaaaaaa-0000-4000-8000-0000000000c5',
  guest: 'aaaaaaaa-0000-4000-8000-0000000000c6',
};
const B_PARENT = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const B_TEEN = 'bbbbbbbb-0000-4000-8000-0000000000b2';

const POLICY_A = 'aaaaaaaa-0000-4000-8000-00000000f001';
const POLICY_B = 'bbbbbbbb-0000-4000-8000-00000000f001';
const GRANT_B = 'bbbbbbbb-0000-4000-8000-00000000a0b1';
const DELEGATION_A = 'aaaaaaaa-0000-4000-8000-00000000d001';
const DELEGATION_B = 'bbbbbbbb-0000-4000-8000-00000000d001';
const EMERGENCY_A = 'aaaaaaaa-0000-4000-8000-00000000e001';
const EMERGENCY_B = 'bbbbbbbb-0000-4000-8000-00000000e001';
const SUGGESTION_A = 'aaaaaaaa-0000-4000-8000-000000005001';
const SUGGESTION_B = 'bbbbbbbb-0000-4000-8000-000000005001';
const APPROVAL_A = 'aaaaaaaa-0000-4000-8000-000000007001';
const APPROVAL_B = 'bbbbbbbb-0000-4000-8000-000000007001';

const MANAGERS: Role[] = ['parent', 'adult'];
const NON_MANAGERS: Role[] = ['teen', 'child', 'caregiver', 'guest'];

// The sentences a refused member reads (lib/i18n/messages/en-US.json), typed out.
const NOT_A_TRUST_MANAGER = 'Only a parent or adult can manage the Trust Engine.';
const NOT_AN_APPROVER = 'Only a parent or adult can decide approvals.';

const TABLES = [
  'trust_policies', 'permission_grants', 'trust_delegations', 'emergency_sessions',
  'autopilot_suggestions', 'approval_requests', 'trust_audit_logs',
] as const;

const PROPOSAL = {
  domain: 'scheduling', capability: 'automate', tool: 'reminders.create',
  approvals: 4, evidence: 'Approved 4 times since 12 Aug, never rejected', firstApprovedAt: '2026-08-12T10:00:00Z',
};
const SUPPORTED = {
  domain: 'scheduling', capability: 'automate', toolName: 'reminders.create',
  approvals: 4, rejections: 0, corrections: 0, failedCalls: 0, succeededCalls: 4,
  firstApprovedAt: '2026-08-12T10:00:00Z', lastApprovedAt: '2026-09-01T10:00:00Z',
  evidence: 'Approved 4 times since 12 Aug, never rejected', confidence: 74,
  dedupeKey: 'policy:scheduling:automate:reminders.create',
  title: 'Let Bubaly create reminders without asking', actionLabel: 'Trust Bubaly with this',
};

let db: InMemorySupabase;

function signInAs(role: Role) {
  harness.signedOut = false;
  harness.ctx = {
    user: { id: USER[role], email: `${role}@example.com` },
    memberships: [],
    active: {
      familyId: FAMILY_A,
      role,
      member: { id: MEMBER[role], family_id: FAMILY_A, user_id: USER[role] },
      family: { id: FAMILY_A, name: 'Household A', timezone: 'UTC' },
    },
  };
}

function suggestion(id: string, family: string): Row {
  return {
    id, family_id: family, member_id: null, kind: 'policy', status: 'open',
    title: 'Let Bubaly create reminders without asking', detail: 'Approved 4 times',
    confidence: 74, urgency: 1, action_type: 'accept_policy', action_label: 'Trust Bubaly with this',
    payload: PROPOSAL, source_kind: 'approval_requests', source_id: null,
    dedupe_key: 'policy:scheduling:automate:reminders.create',
    updated_at: '2026-09-02T10:00:00.000Z', resolved_at: null, resolved_by: null,
  };
}

function approval(id: string, family: string): Row {
  return {
    id, family_id: family, domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'Concierge', title: 'Add soccer Saturday', summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool', amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier',
    approval_model: 'single', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z', executed_at: null,
    execution_result: null, request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], evidence: null, edited_payload: null, reviewed_by: null, review_note: null,
    updated_at: '2026-09-05T10:00:00.000Z',
  };
}

const FUTURE = '2099-01-01T00:00:00.000Z';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.candidates = [SUPPORTED];
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC' },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC' },
  ]);
  db.seed('family_members', [
    ...(Object.keys(MEMBER) as Role[]).map((role) => ({
      id: MEMBER[role], family_id: FAMILY_A, user_id: USER[role], display_name: `A ${role}`, role, is_active: true,
    })),
    { id: B_PARENT, family_id: FAMILY_B, user_id: 'bbbbbbbb-0000-4000-8000-0000000000c1', display_name: 'B parent', role: 'parent', is_active: true },
    { id: B_TEEN, family_id: FAMILY_B, user_id: 'bbbbbbbb-0000-4000-8000-0000000000c2', display_name: 'B teen', role: 'teen', is_active: true },
  ]);
  db.seed('trust_policies', [
    { id: POLICY_A, family_id: FAMILY_A, name: 'Ask first about money', domain: 'finances', capability: 'automate', subject_kind: 'ai', effect: 'require_approval', enabled: true, conditions: {} },
    { id: POLICY_B, family_id: FAMILY_B, name: 'B: ask first', domain: 'finances', capability: 'automate', subject_kind: 'ai', effect: 'require_approval', enabled: true, conditions: {} },
  ]);
  db.seed('permission_grants', [
    { id: GRANT_B, family_id: FAMILY_B, member_id: B_TEEN, domain: 'calendar', capability: 'edit', effect: 'allow' },
  ]);
  db.seed('trust_delegations', [
    { id: DELEGATION_A, family_id: FAMILY_A, from_member_id: MEMBER.parent, to_member_id: MEMBER.caregiver, domains: ['calendar'], expires_at: FUTURE, revoked_at: null },
    { id: DELEGATION_B, family_id: FAMILY_B, from_member_id: B_PARENT, to_member_id: B_TEEN, domains: ['calendar'], expires_at: FUTURE, revoked_at: null },
  ]);
  db.seed('emergency_sessions', [
    { id: EMERGENCY_A, family_id: FAMILY_A, kind: 'medical', elevated_domains: ['medical'], activated_by: MEMBER.parent, expires_at: FUTURE, ended_at: null, ended_by: null },
    { id: EMERGENCY_B, family_id: FAMILY_B, kind: 'medical', elevated_domains: ['medical'], activated_by: B_PARENT, expires_at: FUTURE, ended_at: null, ended_by: null },
  ]);
  db.seed('autopilot_suggestions', [suggestion(SUGGESTION_A, FAMILY_A), suggestion(SUGGESTION_B, FAMILY_B)]);
  db.seed('approval_requests', [approval(APPROVAL_A, FAMILY_A), approval(APPROVAL_B, FAMILY_B)]);
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.signedOut = false;
});

/** Every table these actions write, as it stands now. */
function snapshot() {
  return structuredClone(Object.fromEntries(TABLES.map((name) => [name, db.table(name)])));
}
const byId = (table: string, id: string) => db.table(table).find((row) => row.id === id);
const familyRows = (table: string, family: string) => db.table(table).filter((row) => row.family_id === family);
/** Rows of household B, for "B did not change". */
const householdB = () => structuredClone(Object.fromEntries(TABLES.map((name) => [name, familyRows(name, FAMILY_B)])));

/** Household A has no live emergency, so an activation is not refused as a second one. */
function endHouseholdAEmergency() {
  db.replace('emergency_sessions', db.table('emergency_sessions').filter((row) => row.family_id !== FAMILY_A));
}

// ─── savePolicyAction ────────────────────────────────────────────────────────
describe('savePolicyAction', () => {
  const ID = 'ACTION-B107F1871DA9';
  const input = {
    name: 'Bubaly may add calendar events', domain: 'calendar', capability: 'create',
    subjectKind: 'ai', effect: 'allow',
  };

  it.each(MANAGERS)(`${ID} the %s creates one policy in their own household and records it`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await savePolicyAction(input)).toEqual({ ok: true });
    const created = db.table('trust_policies').filter((row) => row.name === input.name);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      family_id: FAMILY_A, created_by: USER[role], domain: 'calendar', capability: 'create',
      subject_kind: 'ai', effect: 'allow', enabled: true,
    });
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'policy_changed', actor_id: MEMBER[role], domain: 'calendar' }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(MANAGERS)(`${ID} the %s edits a policy of their own household`, async (role) => {
    signInAs(role);
    expect(await savePolicyAction({ ...input, id: POLICY_A, name: 'Renamed' })).toEqual({ ok: true });
    expect(byId('trust_policies', POLICY_A)).toMatchObject({ family_id: FAMILY_A, name: 'Renamed', effect: 'allow' });
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused, for a new policy or an edit, and nothing is written`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await savePolicyAction(input)).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(await savePolicyAction({ ...input, id: POLICY_A, name: 'Renamed' })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent editing household B's policy is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await savePolicyAction({ ...input, id: POLICY_B, name: 'Hijacked' }))
      .toEqual({ ok: false, error: 'Could not update that policy.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── togglePolicyAction ──────────────────────────────────────────────────────
describe('togglePolicyAction', () => {
  const ID = 'ACTION-41B123BCB323';

  it.each(MANAGERS)(`${ID} the %s turns a policy of their own household off and records it`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await togglePolicyAction({ id: POLICY_A, enabled: false })).toEqual({ ok: true });
    expect(byId('trust_policies', POLICY_A)).toMatchObject({ enabled: false, family_id: FAMILY_A });
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'policy_changed', actor_id: MEMBER[role] }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and the policy stays on`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await togglePolicyAction({ id: POLICY_A, enabled: false })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent toggling household B's policy is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await togglePolicyAction({ id: POLICY_B, enabled: false })).toEqual({ ok: false, error: 'Could not update that policy.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── deletePolicyAction ──────────────────────────────────────────────────────
describe('deletePolicyAction', () => {
  const ID = 'ACTION-B5CAAFBB69C4';

  it.each(MANAGERS)(`${ID} the %s deletes a policy of their own household and records it`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await deletePolicyAction({ id: POLICY_A })).toEqual({ ok: true });
    expect(byId('trust_policies', POLICY_A)).toBeUndefined();
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'policy_changed', actor_id: MEMBER[role], reason: 'Policy deleted' }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and the policy survives`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await deletePolicyAction({ id: POLICY_A })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent deleting household B's policy is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await deletePolicyAction({ id: POLICY_B })).toEqual({ ok: false, error: 'Could not delete that policy.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── acceptPolicySuggestionAction ────────────────────────────────────────────
describe('acceptPolicySuggestionAction', () => {
  const ID = 'ACTION-604D3EBDBFDA';

  it.each(MANAGERS)(`${ID} the %s accepts a suggestion: one narrow AI policy, the suggestion executed`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await acceptPolicySuggestionAction({ suggestionId: SUGGESTION_A })).toEqual({ ok: true });
    const written = db.table('trust_policies').filter((row) => row.id !== POLICY_A && row.id !== POLICY_B);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      family_id: FAMILY_A, created_by: USER[role], subject_kind: 'ai', effect: 'allow',
      domain: 'scheduling', capability: 'automate',
    });
    expect(byId('autopilot_suggestions', SUGGESTION_A)).toMatchObject({ status: 'executed', resolved_by: USER[role] });
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused, no policy is written and the suggestion stays open`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await acceptPolicySuggestionAction({ suggestionId: SUGGESTION_A })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent accepting household B's suggestion is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await acceptPolicySuggestionAction({ suggestionId: SUGGESTION_B }))
      .toEqual({ ok: false, error: 'That suggestion does not propose a policy.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── setPermissionGrantAction ────────────────────────────────────────────────
describe('setPermissionGrantAction', () => {
  const ID = 'ACTION-2BF1B4138494';

  it.each(MANAGERS)(`${ID} the %s grants a member of their own household a capability and records it`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await setPermissionGrantAction({ memberId: MEMBER.teen, domain: 'calendar', capability: 'edit', effect: 'allow' }))
      .toEqual({ ok: true });
    expect(familyRows('permission_grants', FAMILY_A)).toEqual([
      expect.objectContaining({ member_id: MEMBER.teen, domain: 'calendar', capability: 'edit', effect: 'allow', created_by: USER[role] }),
    ]);
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'grant_changed', actor_id: MEMBER[role], domain: 'calendar', capability: 'edit' }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused, granting or clearing, and nothing is written`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await setPermissionGrantAction({ memberId: MEMBER[role], domain: 'finances', capability: 'edit', effect: 'allow' }))
      .toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(await setPermissionGrantAction({ memberId: MEMBER[role], domain: 'finances', capability: 'edit', effect: 'clear' }))
      .toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent clearing a grant held by a member of household B removes nothing in B`, async () => {
    signInAs('parent');
    const before = householdB();
    expect(await setPermissionGrantAction({ memberId: B_TEEN, domain: 'calendar', capability: 'edit', effect: 'clear' }))
      .toEqual({ ok: true });
    expect(byId('permission_grants', GRANT_B)).toMatchObject({ family_id: FAMILY_B, member_id: B_TEEN, effect: 'allow' });
    expect(householdB()).toEqual(before);
    // The ledger says nothing was cleared, rather than claiming a clearance.
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'grant_changed', reason: 'No edit grant on calendar to clear' }),
    ]);
  });
});

// ─── createDelegationAction ──────────────────────────────────────────────────
describe('createDelegationAction', () => {
  const ID = 'ACTION-99F36D6FBAE2';
  const input = () => ({
    fromMemberId: MEMBER.parent, toMemberId: MEMBER.adult, domains: ['calendar', 'chores', 'not-a-domain', 'all'],
    reason: 'Away at a conference', expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });

  it.each(MANAGERS)(`${ID} the %s delegates between two members of their own household, known domains only`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await createDelegationAction(input())).toEqual({ ok: true });
    const created = db.table('trust_delegations').filter((row) => row.id !== DELEGATION_A && row.id !== DELEGATION_B);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      family_id: FAMILY_A, from_member_id: MEMBER.parent, to_member_id: MEMBER.adult,
      domains: ['calendar', 'chores'], reason: 'Away at a conference', created_by: USER[role],
    });
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'delegation_changed', actor_id: MEMBER[role] }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and no delegation is written`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await createDelegationAction({ ...input(), fromMemberId: MEMBER.parent, toMemberId: MEMBER[role] }))
      .toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['to', { toMemberId: B_TEEN }],
    ['from', { fromMemberId: B_PARENT }],
  ])(`${ID} a parent naming a household B member as the %s end is refused and neither household changes`, async (_end, over) => {
    signInAs('parent');
    const before = snapshot();
    expect(await createDelegationAction({ ...input(), ...over })).toEqual({ ok: false, error: 'Delegate to a different member.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── createSharingPresetAction ───────────────────────────────────────────────
describe('createSharingPresetAction', () => {
  const ID = 'ACTION-A24B5453EA57';

  it.each(MANAGERS)(`${ID} the %s applies a preset: the server's domains, a future expiry, in their own household`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await createSharingPresetAction({ presetKey: 'babysitter_tonight', fromMemberId: MEMBER.parent, toMemberId: MEMBER.caregiver }))
      .toEqual({ ok: true });
    const created = db.table('trust_delegations').filter((row) => row.id !== DELEGATION_A && row.id !== DELEGATION_B);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      family_id: FAMILY_A, from_member_id: MEMBER.parent, to_member_id: MEMBER.caregiver,
      domains: ['calendar', 'chores', 'meal_planning'], created_by: USER[role],
    });
    expect(Date.parse(String(created[0].expires_at))).toBeGreaterThan(Date.now());
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and no delegation is written`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await createSharingPresetAction({ presetKey: 'babysitter_tonight', fromMemberId: MEMBER.parent, toMemberId: MEMBER[role] }))
      .toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent sharing with a household B member is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await createSharingPresetAction({ presetKey: 'babysitter_tonight', fromMemberId: MEMBER.parent, toMemberId: B_TEEN }))
      .toEqual({ ok: false, error: 'Delegate to a different member.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── revokeDelegationAction ──────────────────────────────────────────────────
describe('revokeDelegationAction', () => {
  const ID = 'ACTION-1318E1F05B65';

  it.each(MANAGERS)(`${ID} the %s revokes a delegation of their own household and records it`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await revokeDelegationAction({ id: DELEGATION_A })).toEqual({ ok: true });
    expect(byId('trust_delegations', DELEGATION_A)?.revoked_at).toEqual(expect.any(String));
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'delegation_changed', actor_id: MEMBER[role], reason: 'Delegation revoked' }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and the delegation stays live`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await revokeDelegationAction({ id: DELEGATION_A })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent revoking household B's delegation is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await revokeDelegationAction({ id: DELEGATION_B })).toEqual({ ok: false, error: 'Could not revoke that delegation.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── decideApprovalAction ────────────────────────────────────────────────────
describe('decideApprovalAction', () => {
  const ID = 'ACTION-72DB6B2CE780';

  it.each(MANAGERS)(`${ID} the %s declines a pending request of their own household`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await decideApprovalAction({ id: APPROVAL_A, decision: 'rejected', note: 'Not this week' })).toEqual({ ok: true });
    expect(byId('approval_requests', APPROVAL_A)).toMatchObject({
      status: 'rejected', decided_by: MEMBER[role], review_note: 'Not this week',
      approvals: [expect.objectContaining({ member_id: MEMBER[role], decision: 'rejected', role })],
    });
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused, approving or declining, and the request stays pending`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await decideApprovalAction({ id: APPROVAL_A, decision: 'approved' })).toEqual({ ok: false, error: NOT_AN_APPROVER });
    expect(await decideApprovalAction({ id: APPROVAL_A, decision: 'rejected' })).toEqual({ ok: false, error: NOT_AN_APPROVER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent deciding household B's request finds nothing and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await decideApprovalAction({ id: APPROVAL_B, decision: 'rejected' }))
      .toEqual({ ok: false, error: 'That approval could not be found.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── activateEmergencyAction ─────────────────────────────────────────────────
describe('activateEmergencyAction', () => {
  const ID = 'ACTION-E665CDB33E65';

  it.each(MANAGERS)(`${ID} the %s turns emergency mode on for the named areas and the ledger says who`, async (role) => {
    signInAs(role);
    endHouseholdAEmergency();
    const before = householdB();
    expect(await activateEmergencyAction({ kind: 'medical', reason: 'Fall at the park', elevatedDomains: ['medical', 'not-a-domain'] }))
      .toEqual({ ok: true });
    expect(familyRows('emergency_sessions', FAMILY_A)).toEqual([
      expect.objectContaining({ kind: 'medical', activated_by: MEMBER[role], elevated_domains: ['medical'], reason: 'Fall at the park' }),
    ]);
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'emergency_override', actor_id: MEMBER[role] }),
    ]);
    // Household B's own live emergency neither blocked this nor was touched by it.
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and no emergency starts`, async (role) => {
    signInAs(role);
    endHouseholdAEmergency();
    const before = snapshot();
    expect(await activateEmergencyAction({ kind: 'medical', elevatedDomains: ['medical'] })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });
});

// ─── endEmergencyAction ──────────────────────────────────────────────────────
describe('endEmergencyAction', () => {
  const ID = 'ACTION-EBAF0F9342CC';

  it.each(MANAGERS)(`${ID} the %s ends their own household's emergency and the ledger says who`, async (role) => {
    signInAs(role);
    const before = householdB();
    expect(await endEmergencyAction({ id: EMERGENCY_A })).toEqual({ ok: true });
    expect(byId('emergency_sessions', EMERGENCY_A)).toMatchObject({ ended_by: MEMBER[role], ended_at: expect.any(String) });
    expect(familyRows('trust_audit_logs', FAMILY_A)).toEqual([
      expect.objectContaining({ decision: 'emergency_ended', actor_id: MEMBER[role] }),
    ]);
    expect(householdB()).toEqual(before);
  });

  it.each(NON_MANAGERS)(`${ID} the %s is refused and the emergency stays on`, async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await endEmergencyAction({ id: EMERGENCY_A })).toEqual({ ok: false, error: NOT_A_TRUST_MANAGER });
    expect(snapshot()).toEqual(before);
  });

  it(`${ID} a parent ending household B's emergency is refused and neither household changes`, async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await endEmergencyAction({ id: EMERGENCY_B })).toEqual({ ok: false, error: 'Could not end emergency mode.' });
    expect(snapshot()).toEqual(before);
  });
});

// ─── signed out ──────────────────────────────────────────────────────────────
describe('a signed-out caller is sent to sign in by every trust action', () => {
  const later = () => new Date(Date.now() + 86_400_000).toISOString();
  it.each([
    ['ACTION-B107F1871DA9', () => savePolicyAction({ name: 'X', domain: 'calendar', capability: 'create', subjectKind: 'ai', effect: 'allow' })],
    ['ACTION-41B123BCB323', () => togglePolicyAction({ id: POLICY_A, enabled: false })],
    ['ACTION-B5CAAFBB69C4', () => deletePolicyAction({ id: POLICY_A })],
    ['ACTION-604D3EBDBFDA', () => acceptPolicySuggestionAction({ suggestionId: SUGGESTION_A })],
    ['ACTION-2BF1B4138494', () => setPermissionGrantAction({ memberId: MEMBER.teen, domain: 'calendar', capability: 'edit', effect: 'allow' })],
    ['ACTION-99F36D6FBAE2', () => createDelegationAction({ fromMemberId: MEMBER.parent, toMemberId: MEMBER.adult, domains: ['calendar'], expiresAt: later() })],
    ['ACTION-A24B5453EA57', () => createSharingPresetAction({ presetKey: 'babysitter_tonight', fromMemberId: MEMBER.parent, toMemberId: MEMBER.caregiver })],
    ['ACTION-1318E1F05B65', () => revokeDelegationAction({ id: DELEGATION_A })],
    ['ACTION-72DB6B2CE780', () => decideApprovalAction({ id: APPROVAL_A, decision: 'rejected' })],
    ['ACTION-E665CDB33E65', () => activateEmergencyAction({ kind: 'medical', elevatedDomains: ['medical'] })],
    ['ACTION-EBAF0F9342CC', () => endEmergencyAction({ id: EMERGENCY_A })],
  ] as const)('%s a signed-out caller is redirected and nothing is written', async (_id, call) => {
    harness.signedOut = true;
    const before = snapshot();
    await expect(call()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});
