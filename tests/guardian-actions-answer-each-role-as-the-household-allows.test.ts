// Call-level role tests for every server action in app/(app)/guardian/actions.ts
// (Register B, group 7).
//
// THE POLICY, from the sources rather than from the actions:
// - Guardian is a child's call and message SAFETY screening. The file's own
//   header says only a family manager (parent or adult, `isManager` in
//   lib/constants/roles.ts) may change it, and the database agrees:
//   guardian_contacts, guardian_member_profiles and guardian_suggestions write
//   only under `can_manage_family` since 0345, guardian_routing_rules since
//   0215, and guardian_escalations is SELECT-only for members (01370), so the
//   acknowledge goes through the service role behind the manager check.
// - A guest is sent away from /guardian altogether (GUEST_WITHHELD_PREFIXES in
//   lib/auth/guest-scope.ts); a caregiver, teen or child is not a manager.
// - Every id is one household's. A member, contact, rule, escalation or
//   suggestion of another family is "not found" and changes nothing.
//
// WHAT IS DRIVEN: the real exported actions, against the repository's
// real-table fake of PostgREST (tests/helpers/in-memory-supabase.ts). The fake
// has no RLS, so a gate the action does not apply is a write that lands here:
// each refused case asserts the action's refusal AND that no table changed.
// Only the request seams are stubbed: the signed-in context, the translator
// (identity, so a refusal is asserted by its catalogue key) and revalidatePath.
//
// reviewSuggestionAction has no role check of its own: it hands the decision
// to `guardian_review_suggestion` (0198, SECURITY DEFINER), whose
// `can_manage_family` test is the gate. The fake answers that RPC with the
// reasons 0198 returns, so these cases pin what the action does with each
// answer (says it, writes nothing itself, revalidates only on success); the
// SQL gate itself is not something a unit test can pin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  revalidatePath: vi.fn(),
  db: null as unknown,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => mocks.db,
  createServiceClient: () => mocks.db,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const {
  acknowledgeEscalationAction,
  assignGuardianPhoneAction,
  createRuleAction,
  deleteContactAction,
  deleteRuleAction,
  generateGuardianSuggestionsAction,
  reviewSuggestionAction,
  toggleRuleAction,
  updateContactTrustAction,
  updateContextAction,
  upsertContactAction,
  upsertMemberProfileAction,
} = await import('@/app/(app)/guardian/actions');

// ── Two households ──────────────────────────────────────────────────────────
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const CHILD_A = 'a1000000-0000-4000-8000-000000000001';
const CHILD_B = 'b1000000-0000-4000-8000-000000000001';
const CONTACT_A = 'a2000000-0000-4000-8000-000000000001';
const CONTACT_B = 'b2000000-0000-4000-8000-000000000001';
const RULE_A = 'a3000000-0000-4000-8000-000000000001';
const RULE_B = 'b3000000-0000-4000-8000-000000000001';
const ESC_A = 'a4000000-0000-4000-8000-000000000001';
const ESC_B = 'b4000000-0000-4000-8000-000000000001';
const SUG_A = 'a5000000-0000-4000-8000-000000000001';
const SUG_B = 'b5000000-0000-4000-8000-000000000001';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
const MANAGERS: Role[] = ['parent', 'adult'];
const NON_MANAGERS: Role[] = ['teen', 'child', 'caregiver', 'guest'];
const MEMBER_OF: Record<Role, string> = {
  parent: 'a6000000-0000-4000-8000-000000000001',
  adult: 'a6000000-0000-4000-8000-000000000002',
  teen: 'a6000000-0000-4000-8000-000000000003',
  child: 'a6000000-0000-4000-8000-000000000004',
  caregiver: 'a6000000-0000-4000-8000-000000000005',
  guest: 'a6000000-0000-4000-8000-000000000006',
};
const userOf = (role: Role) => `a7000000-0000-4000-8000-00000000000${Object.keys(MEMBER_OF).indexOf(role) + 1}`;

const FORBIDDEN = { ok: false, error: 'actions.onlyAParentOrGuardian' };
const MEMBER_NOT_FOUND = { ok: false, error: 'actions.familyMemberNotFound' };
const CONTACT_NOT_FOUND = { ok: false, error: 'actions.contactNotFound' };

let db: InMemorySupabase;
let caller: { role: Role; userId: string } | null = null;

function signInAs(role: Role) {
  caller = { role, userId: userOf(role) };
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userOf(role), email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id: MEMBER_OF[role], family_id: FAMILY_A } },
  });
}

const TABLES = [
  'guardian_contacts', 'guardian_member_profiles', 'guardian_routing_rules', 'guardian_escalations',
  'guardian_suggestions', 'guardian_audit_log', 'family_members', 'app_settings',
] as const;
/** Every table a Guardian action could touch, to show a refusal touched none of it. */
const everything = () => structuredClone(Object.fromEntries(TABLES.map((t) => [t, db.table(t)])));
const row = (table: string, id: string): Row | undefined => db.table(table).find((r) => r.id === id);
const familyRows = (table: string, family: string) => structuredClone(db.table(table).filter((r) => r.family_id === family));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * 0198's answers, by the tests it makes in its own order: unauthenticated,
 * invalid decision, not found, `can_manage_family` (parent or adult of the
 * suggestion's family), already reviewed. A dismissal changes only the
 * suggestion's status, which is all these cases decide.
 */
function guardianReviewSuggestion(args: Record<string, unknown>, store: InMemorySupabase) {
  if (!caller) return { ok: false, reason: 'unauthenticated' };
  if (args.p_decision !== 'approved' && args.p_decision !== 'dismissed') return { ok: false, reason: 'invalid_decision' };
  const suggestion = store.table('guardian_suggestions').find((r) => r.id === args.p_suggestion_id);
  if (!suggestion) return { ok: false, reason: 'not_found' };
  const managesIt = suggestion.family_id === FAMILY_A && (caller.role === 'parent' || caller.role === 'adult');
  if (!managesIt) return { ok: false, reason: 'forbidden' };
  if (suggestion.status !== 'pending') return { ok: false, reason: 'already_reviewed' };
  Object.assign(suggestion, { status: args.p_decision, reviewed_by: caller.userId, review_note: args.p_note });
  return { ok: true, status: args.p_decision };
}

beforeEach(() => {
  vi.clearAllMocks();
  caller = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { app_settings: [['key']], guardian_member_profiles: [['family_id', 'member_id']] },
    rpc: { guardian_review_suggestion: guardianReviewSuggestion },
  });
  mocks.db = db;
  db.seed('families', [{ id: FAMILY_A, timezone: 'UTC' }, { id: FAMILY_B, timezone: 'UTC' }]);
  db.seed('family_members', [
    ...(Object.keys(MEMBER_OF) as Role[]).map((role) => ({ id: MEMBER_OF[role], family_id: FAMILY_A, role, is_active: true, user_id: userOf(role) })),
    { id: CHILD_A, family_id: FAMILY_A, role: 'child', is_active: true, display_name: 'Mia' },
    { id: CHILD_B, family_id: FAMILY_B, role: 'child', is_active: true, display_name: 'Theo' },
  ]);
  db.seed('guardian_contacts', [
    { id: CONTACT_A, family_id: FAMILY_A, name: 'Coach Lee', phone: '+15555550101', trust_level: 'known_contact', trust_override: false, member_id: null },
    { id: CONTACT_B, family_id: FAMILY_B, name: 'Aunt Ro', phone: '+15555550102', trust_level: 'close_family', trust_override: false, member_id: null },
  ]);
  db.seed('guardian_member_profiles', [
    { id: 'a8000000-0000-4000-8000-000000000001', family_id: FAMILY_A, member_id: CHILD_A, current_context: 'normal', guardian_phone: null, ai_persona_name: 'Guardian', default_mode_unknown: 'ai_handle_first' },
    { id: 'b8000000-0000-4000-8000-000000000001', family_id: FAMILY_B, member_id: CHILD_B, current_context: 'normal', guardian_phone: '+15555550199', ai_persona_name: 'Guardian', default_mode_unknown: 'ai_handle_first' },
  ]);
  db.seed('guardian_routing_rules', [
    { id: RULE_A, family_id: FAMILY_A, name: 'School hours', is_active: true, action_routing_mode: 'voicemail_first' },
    { id: RULE_B, family_id: FAMILY_B, name: 'Bedtime', is_active: true, action_routing_mode: 'silent_handling' },
  ]);
  db.seed('guardian_escalations', [
    { id: ESC_A, family_id: FAMILY_A, acknowledged_by: null, acknowledged_at: null },
    { id: ESC_B, family_id: FAMILY_B, acknowledged_by: null, acknowledged_at: null },
  ]);
  db.seed('guardian_suggestions', [
    { id: SUG_A, family_id: FAMILY_A, suggestion_type: 'update_trust', status: 'pending', evidence: {}, created_at: daysAgo(1) },
    { id: SUG_B, family_id: FAMILY_B, suggestion_type: 'update_trust', status: 'pending', evidence: {}, created_at: daysAgo(1) },
  ]);
  // Two scam hits from one number in each household: the learning run's
  // "block this number?" pattern (REPEAT_SCAM_THRESHOLD = 2).
  db.seed('guardian_communications', [FAMILY_A, FAMILY_B].flatMap((family) => [1, 2].map((n) => ({
    family_id: family, from_number: '+15555550666', contact_id: null, scam_detected: true,
    trust_level_at_time: 'unknown', started_at: daysAgo(n),
  }))));
});
afterEach(() => vi.restoreAllMocks());

/** The refusal every non-manager gets, with nothing written and nothing revalidated. */
async function expectRefusedAndUntouched(call: () => Promise<unknown>, expected: unknown = FORBIDDEN) {
  const before = everything();
  expect(await call()).toEqual(expected);
  expect(everything()).toEqual(before);
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

const auditActions = () => db.table('guardian_audit_log').map((r) => r.action);

// ── Contacts ────────────────────────────────────────────────────────────────

describe('upsertContactAction', () => {
  it.each(MANAGERS)('ACTION-6C89778FB2C2 a %s adds a contact to their own household, audited', async (role) => {
    signInAs(role);
    const before = familyRows('guardian_contacts', FAMILY_B);
    const result = await upsertContactAction({ name: '  Grandma Jo ', phone: ' +15555550111 ', trust_level: 'close_family', member_id: CHILD_A });
    expect(result.ok).toBe(true);
    const id = (result as { data: { id: string } }).data.id;
    expect(row('guardian_contacts', id)).toMatchObject({
      family_id: FAMILY_A, name: 'Grandma Jo', phone: '+15555550111', email: null, trust_level: 'close_family',
      trust_override: true, member_id: CHILD_A, created_by: userOf(role),
    });
    expect(db.table('guardian_contacts')).toHaveLength(3);
    expect(familyRows('guardian_contacts', FAMILY_B)).toEqual(before);
    expect(auditActions()).toEqual(['contact.created']);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/guardian/contacts');
  });

  it.each(MANAGERS)('ACTION-6C89778FB2C2 a %s edits their own contact without rewriting who added it', async (role) => {
    signInAs(role);
    const result = await upsertContactAction({ id: CONTACT_A, name: 'Coach Lee', trust_level: 'trusted_friend' });
    expect(result).toEqual({ ok: true, data: { id: CONTACT_A } });
    expect(row('guardian_contacts', CONTACT_A)).toMatchObject({ family_id: FAMILY_A, trust_level: 'trusted_friend', trust_override: true, phone: null });
    expect(row('guardian_contacts', CONTACT_A)?.created_by).toBeUndefined();
    expect(auditActions()).toEqual(['contact.updated']);
  });

  it.each(NON_MANAGERS)('ACTION-6C89778FB2C2 a %s is refused and no contact is written', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => upsertContactAction({ name: 'Stranger', trust_level: 'immediate_family' }));
    await expectRefusedAndUntouched(() => upsertContactAction({ id: CONTACT_A, name: 'Coach Lee', trust_level: 'immediate_family' }));
  });

  it('ACTION-6C89778FB2C2 another family\'s contact id or member id is not this household\'s', async () => {
    signInAs('parent');
    const before = everything();
    const edited = await upsertContactAction({ id: CONTACT_B, name: 'Hijacked', trust_level: 'blocked' });
    expect(edited.ok).toBe(false);
    expect(everything().guardian_contacts).toEqual(before.guardian_contacts);
    await expectRefusedAndUntouched(() => upsertContactAction({ name: 'Theo line', trust_level: 'known_contact', member_id: CHILD_B }), MEMBER_NOT_FOUND);
  });
});

describe('deleteContactAction', () => {
  it.each(MANAGERS)('ACTION-BBEFE0F2FAC3 a %s deletes their own contact and only that one', async (role) => {
    signInAs(role);
    expect(await deleteContactAction(CONTACT_A)).toEqual({ ok: true });
    expect(db.table('guardian_contacts').map((r) => r.id)).toEqual([CONTACT_B]);
  });

  it.each(NON_MANAGERS)('ACTION-BBEFE0F2FAC3 a %s is refused and the contact stays', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => deleteContactAction(CONTACT_A));
  });

  it("ACTION-BBEFE0F2FAC3 another family's contact is not deleted, and the action says so", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => deleteContactAction(CONTACT_B), { ok: false, error: 'guardian.couldNotDeleteTheGuardianContact' });
  });
});

describe('updateContactTrustAction', () => {
  it.each(MANAGERS)('ACTION-FF65228D56B4 a %s changes their own contact\'s trust, audited', async (role) => {
    signInAs(role);
    expect(await updateContactTrustAction(CONTACT_A, 'blocked')).toEqual({ ok: true });
    expect(row('guardian_contacts', CONTACT_A)).toMatchObject({ trust_level: 'blocked', trust_override: true });
    expect(row('guardian_contacts', CONTACT_B)).toMatchObject({ trust_level: 'close_family', trust_override: false });
    expect(db.table('guardian_audit_log')).toEqual([expect.objectContaining({ family_id: FAMILY_A, action: 'contact.trust_updated', entity_id: CONTACT_A, actor_user_id: userOf(role) })]);
  });

  it.each(NON_MANAGERS)('ACTION-FF65228D56B4 a %s is refused and trust is unchanged', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => updateContactTrustAction(CONTACT_A, 'immediate_family'));
  });

  it("ACTION-FF65228D56B4 another family's contact keeps its trust and no change is audited", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => updateContactTrustAction(CONTACT_B, 'blocked'), { ok: false, error: 'guardian.couldNotUpdateContactTrust' });
  });
});

// ── Member profile ──────────────────────────────────────────────────────────

describe('upsertMemberProfileAction', () => {
  it.each(MANAGERS)("ACTION-6F9F5392DFCA a %s saves their own child's routing profile", async (role) => {
    signInAs(role);
    expect(await upsertMemberProfileAction({ member_id: CHILD_A, ai_persona_name: 'Sky', default_mode_unknown: 'voicemail_first' })).toEqual({ ok: true });
    const profiles = db.table('guardian_member_profiles').filter((r) => r.member_id === CHILD_A);
    expect(profiles).toEqual([expect.objectContaining({ family_id: FAMILY_A, ai_persona_name: 'Sky', default_mode_unknown: 'voicemail_first', current_context: 'normal' })]);
    expect(familyRows('guardian_member_profiles', FAMILY_B)).toEqual([expect.objectContaining({ ai_persona_name: 'Guardian', default_mode_unknown: 'ai_handle_first' })]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/guardian/settings');
  });

  it.each(NON_MANAGERS)('ACTION-6F9F5392DFCA a %s is refused and the profile is unchanged', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => upsertMemberProfileAction({ member_id: CHILD_A, default_mode_unknown: 'immediate_ring' }));
  });

  it("ACTION-6F9F5392DFCA another family's member is not attached to this household's Guardian", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => upsertMemberProfileAction({ member_id: CHILD_B, ai_persona_name: 'Sky' }), MEMBER_NOT_FOUND);
  });
});

describe('updateContextAction', () => {
  it.each(MANAGERS)("ACTION-763D6D1492D1 a %s sets their own child's context", async (role) => {
    signInAs(role);
    expect(await updateContextAction(CHILD_A, 'sleeping')).toEqual({ ok: true });
    expect(db.table('guardian_member_profiles').map((r) => [r.member_id, r.current_context])).toEqual([[CHILD_A, 'sleeping'], [CHILD_B, 'normal']]);
  });

  it.each(NON_MANAGERS)('ACTION-763D6D1492D1 a %s is refused and the context is unchanged', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => updateContextAction(CHILD_A, 'do_not_disturb'));
  });

  it("ACTION-763D6D1492D1 another family's member keeps their context", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => updateContextAction(CHILD_B, 'sleeping'), { ok: false, error: 'guardian.couldNotUpdateTheGuardianContext' });
  });
});

describe('assignGuardianPhoneAction', () => {
  it.each(MANAGERS)('ACTION-CF3838F9EA45 a %s assigns a Guardian number to their own child, in E.164, audited', async (role) => {
    signInAs(role);
    expect(await assignGuardianPhoneAction({ member_id: CHILD_A, phone: '(555) 555-0142' })).toEqual({ ok: true, data: { phone: '+15555550142' } });
    expect(db.table('guardian_member_profiles').map((r) => [r.member_id, r.guardian_phone])).toEqual([[CHILD_A, '+15555550142'], [CHILD_B, '+15555550199']]);
    expect(auditActions()).toEqual(['profile.guardian_phone_assigned']);
  });

  it.each(NON_MANAGERS)('ACTION-CF3838F9EA45 a %s is refused and no number is assigned', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => assignGuardianPhoneAction({ member_id: CHILD_A, phone: '5555550142' }));
  });

  it("ACTION-CF3838F9EA45 another family's member is not given this household's number", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => assignGuardianPhoneAction({ member_id: CHILD_B, phone: '5555550142' }), MEMBER_NOT_FOUND);
  });
});

// ── Rules ───────────────────────────────────────────────────────────────────

describe('createRuleAction', () => {
  it.each(MANAGERS)('ACTION-6F7B023FEF84 a %s creates a rule in their own household, approved by them, audited', async (role) => {
    signInAs(role);
    const result = await createRuleAction({ name: 'Coach only', member_id: CHILD_A, condition_contact_id: CONTACT_A, action_routing_mode: 'immediate_ring' });
    expect(result.ok).toBe(true);
    const id = (result as { data: { id: string } }).data.id;
    expect(row('guardian_routing_rules', id)).toMatchObject({
      family_id: FAMILY_A, name: 'Coach only', member_id: CHILD_A, condition_contact_id: CONTACT_A, is_active: true,
      action_routing_mode: 'immediate_ring', created_by: userOf(role), approved_by: userOf(role), ai_suggested: false, priority: 100,
    });
    expect(db.table('guardian_routing_rules')).toHaveLength(3);
    expect(auditActions()).toEqual(['rule.created']);
  });

  it.each(NON_MANAGERS)('ACTION-6F7B023FEF84 a %s is refused and no rule is written', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => createRuleAction({ name: 'Let everyone through', action_routing_mode: 'immediate_ring' }));
  });

  it("ACTION-6F7B023FEF84 a rule naming another family's member or contact is refused", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => createRuleAction({ name: 'x', member_id: CHILD_B, action_routing_mode: 'immediate_ring' }), MEMBER_NOT_FOUND);
    await expectRefusedAndUntouched(() => createRuleAction({ name: 'x', condition_contact_id: CONTACT_B, action_routing_mode: 'immediate_ring' }), CONTACT_NOT_FOUND);
  });
});

describe('toggleRuleAction', () => {
  it.each(MANAGERS)('ACTION-80E877267F7C a %s turns their own rule off and on', async (role) => {
    signInAs(role);
    expect(await toggleRuleAction(RULE_A, false)).toEqual({ ok: true });
    expect(db.table('guardian_routing_rules').map((r) => [r.id, r.is_active])).toEqual([[RULE_A, false], [RULE_B, true]]);
    expect(await toggleRuleAction(RULE_A, true)).toEqual({ ok: true });
    expect(row('guardian_routing_rules', RULE_A)?.is_active).toBe(true);
  });

  it.each(NON_MANAGERS)('ACTION-80E877267F7C a %s is refused and the rule stays armed', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => toggleRuleAction(RULE_A, false));
  });

  it("ACTION-80E877267F7C another family's rule stays armed", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => toggleRuleAction(RULE_B, false), { ok: false, error: 'guardian.couldNotUpdateTheGuardianRouting' });
  });
});

describe('deleteRuleAction', () => {
  it.each(MANAGERS)('ACTION-E6F7B4AF6000 a %s deletes their own rule and only that one', async (role) => {
    signInAs(role);
    expect(await deleteRuleAction(RULE_A)).toEqual({ ok: true });
    expect(db.table('guardian_routing_rules').map((r) => r.id)).toEqual([RULE_B]);
  });

  it.each(NON_MANAGERS)('ACTION-E6F7B4AF6000 a %s is refused and the rule stays', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => deleteRuleAction(RULE_A));
  });

  it("ACTION-E6F7B4AF6000 another family's rule is not deleted", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => deleteRuleAction(RULE_B), { ok: false, error: 'guardian.couldNotDeleteTheGuardianRouting' });
  });
});

// ── Suggestions ─────────────────────────────────────────────────────────────

describe('generateGuardianSuggestionsAction', () => {
  it.each(MANAGERS)("ACTION-B50C4C6F0114 a %s scans their own household's history and only theirs", async (role) => {
    signInAs(role);
    const theirs = familyRows('guardian_suggestions', FAMILY_B);
    expect(await generateGuardianSuggestionsAction()).toEqual({ ok: true, data: { created: 1 } });
    const created = db.table('guardian_suggestions').filter((r) => r.id !== SUG_A && r.id !== SUG_B);
    expect(created).toEqual([expect.objectContaining({ family_id: FAMILY_A, suggestion_type: 'flag_scam', proposed_trust_level: 'blocked' })]);
    expect(familyRows('guardian_suggestions', FAMILY_B)).toEqual(theirs);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/guardian');
  });

  it.each(NON_MANAGERS)('ACTION-B50C4C6F0114 a %s is refused before any scan runs', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => generateGuardianSuggestionsAction());
  });
});

describe('reviewSuggestionAction', () => {
  it.each(MANAGERS)('ACTION-A8FDA0AD1999 a %s dismisses their own suggestion through the review function', async (role) => {
    signInAs(role);
    expect(await reviewSuggestionAction(SUG_A, 'dismissed', '  not now ')).toEqual({ ok: true });
    expect(row('guardian_suggestions', SUG_A)).toMatchObject({ status: 'dismissed', reviewed_by: userOf(role), review_note: 'not now' });
    expect(row('guardian_suggestions', SUG_B)?.status).toBe('pending');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/guardian');
  });

  it.each(NON_MANAGERS)("ACTION-A8FDA0AD1999 a %s is told the review function's refusal and the action writes nothing", async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => reviewSuggestionAction(SUG_A, 'approved'), { ok: false, error: 'Only a parent or guardian can review suggestions.' });
  });

  it("ACTION-A8FDA0AD1999 another family's suggestion is refused and stays pending", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => reviewSuggestionAction(SUG_B, 'dismissed'), { ok: false, error: 'Only a parent or guardian can review suggestions.' });
  });
});

// ── Escalations ─────────────────────────────────────────────────────────────

describe('acknowledgeEscalationAction', () => {
  it.each(MANAGERS)('ACTION-BDB3D8713C85 a %s acknowledges their own escalation, audited', async (role) => {
    signInAs(role);
    expect(await acknowledgeEscalationAction(ESC_A)).toEqual({ ok: true });
    expect(row('guardian_escalations', ESC_A)).toMatchObject({ acknowledged_by: userOf(role), acknowledged_at: expect.any(String) });
    expect(row('guardian_escalations', ESC_B)).toMatchObject({ acknowledged_by: null, acknowledged_at: null });
    expect(auditActions()).toEqual(['escalation.acknowledged']);
  });

  it.each(NON_MANAGERS)('ACTION-BDB3D8713C85 a %s is refused and the alert stays up', async (role) => {
    signInAs(role);
    await expectRefusedAndUntouched(() => acknowledgeEscalationAction(ESC_A));
  });

  it("ACTION-BDB3D8713C85 another family's escalation is not acknowledged", async () => {
    signInAs('parent');
    await expectRefusedAndUntouched(() => acknowledgeEscalationAction(ESC_B), { ok: false, error: 'guardian.couldNotAcknowledgeTheGuardianEscalation' });
  });

  it("ACTION-BDB3D8713C85 another family's escalation someone there already acknowledged is still not this household's", async () => {
    Object.assign(row('guardian_escalations', ESC_B) as Row, { acknowledged_by: 'b7000000-0000-4000-8000-000000000001', acknowledged_at: '2026-11-01T08:00:00.000Z' });
    signInAs('parent');
    await expectRefusedAndUntouched(() => acknowledgeEscalationAction(ESC_B), { ok: false, error: 'guardian.couldNotAcknowledgeTheGuardianEscalation' });
  });

  it('ACTION-BDB3D8713C85 an escalation already acknowledged keeps its first acknowledgement', async () => {
    Object.assign(row('guardian_escalations', ESC_A) as Row, { acknowledged_by: userOf('adult'), acknowledged_at: '2026-11-01T08:00:00.000Z' });
    signInAs('parent');
    expect(await acknowledgeEscalationAction(ESC_A)).toEqual({ ok: true });
    expect(row('guardian_escalations', ESC_A)).toMatchObject({ acknowledged_by: userOf('adult'), acknowledged_at: '2026-11-01T08:00:00.000Z' });
    expect(auditActions()).toEqual([]);
  });
});

describe('a signed-out caller', () => {
  it.each([
    ['ACTION-6C89778FB2C2', () => upsertContactAction({ name: 'x', trust_level: 'known_contact' })],
    ['ACTION-BBEFE0F2FAC3', () => deleteContactAction(CONTACT_A)],
    ['ACTION-FF65228D56B4', () => updateContactTrustAction(CONTACT_A, 'blocked')],
    ['ACTION-6F9F5392DFCA', () => upsertMemberProfileAction({ member_id: CHILD_A })],
    ['ACTION-763D6D1492D1', () => updateContextAction(CHILD_A, 'sleeping')],
    ['ACTION-CF3838F9EA45', () => assignGuardianPhoneAction({ member_id: CHILD_A, phone: '5555550142' })],
    ['ACTION-6F7B023FEF84', () => createRuleAction({ name: 'x', action_routing_mode: 'immediate_ring' })],
    ['ACTION-80E877267F7C', () => toggleRuleAction(RULE_A, false)],
    ['ACTION-E6F7B4AF6000', () => deleteRuleAction(RULE_A)],
    ['ACTION-B50C4C6F0114', () => generateGuardianSuggestionsAction()],
    ['ACTION-A8FDA0AD1999', () => reviewSuggestionAction(SUG_A, 'dismissed')],
    ['ACTION-BDB3D8713C85', () => acknowledgeEscalationAction(ESC_A)],
  ] as const)('%s is sent to sign in and nothing is written', async (_id, call) => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    const before = everything();
    await expect(call()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });
});
