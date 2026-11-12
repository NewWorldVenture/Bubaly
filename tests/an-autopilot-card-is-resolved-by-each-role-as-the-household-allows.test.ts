// Call-level role tests for `resolveAutopilotSuggestionAction`
// (app/(app)/dashboard/autopilot/actions.ts), Register B ACTION-65B7A9DF3AFD.
//
// THE POLICY, from the sources the audit names:
//   - Family Autopilot is a Plus feature (lib/constants/feature-catalog.ts:46);
//     the action re-checks the tier before it writes, and a super admin
//     previews past it as the page does.
//   - A card is resolved only by someone it is shown to
//     (lib/autopilot/audience.ts suggestionVisibleTo, applied by
//     lib/services/autopilot/index.ts:58-60): an insurance card by a manager or
//     the member the policy names, a money card by anyone but a guest,
//     anything else by every member. The live policies say the same:
//     supabase/migrations/0486_an_autopilot_card_is_read_by_its_audience.sql:262-300.
//   - The session's family and member must still be the ones the page was
//     drawn for (expectedFamilyId / expectedUserId, the membership re-read).
//
// Dismissal is driven for every role. "Add reminder" writes a family reminder,
// which belongs to another agent's area; it shares every gate tested here up to
// the reminder write and is not driven.
//
// NOT PINNED: a guest dismissing an everyone-card. The module offers the button
// and 0085/0486 allow the update, while lib/trust/engine.ts:113-114 and 0464's
// header say a guest does not write. That is the owner's call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  signedOut: false,
  superAdmin: false,
  revalidate: [] as string[],
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => {
    if (h.signedOut) throw new Error('NEXT_REDIRECT:/login');
    return h.ctx;
  },
  isSuperAdmin: async () => h.superAdmin,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { h.revalidate.push(path); } }));

const { resolveAutopilotSuggestionAction } = await import('@/app/(app)/dashboard/autopilot/actions');

const ID = 'ACTION-65B7A9DF3AFD';
const A = '0a000000-0000-4000-8000-00000000000a';
const B = '0b000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const memberOf = (role: Role) => `${String(ROLES.indexOf(role) + 1).padStart(8, '0')}-0000-4000-8000-0000000000a1`;
const userOf = (role: Role) => `${String(ROLES.indexOf(role) + 1).padStart(8, '0')}-0000-4000-8000-0000000000a2`;
const B_USER = '00000009-0000-4000-8000-0000000000b2';

const AT = '2026-11-01T10:00:00.000Z';
const EVERYONE = 'c1000000-0000-4000-8000-000000000001';
const FINANCE = 'c2000000-0000-4000-8000-000000000001';
const INSURANCE = 'c3000000-0000-4000-8000-000000000001';
const THEIRS = 'c4000000-0000-4000-8000-000000000001';

let db: InMemorySupabase;

function signInAs(role: Role) {
  h.signedOut = false;
  h.ctx = {
    user: { id: userOf(role), email: `${role}@example.com` },
    memberships: [],
    active: { familyId: A, role, member: { id: memberOf(role) }, family: { id: A, timezone: 'UTC' } },
  };
}

const dismiss = (role: Role, suggestionId: string, extra: Record<string, unknown> = {}) =>
  resolveAutopilotSuggestionAction({
    suggestionId, updatedAt: AT, action: 'dismiss', expectedFamilyId: A, expectedUserId: userOf(role), ...extra,
  } as Parameters<typeof resolveAutopilotSuggestionAction>[0]);

const card = (id: string, family: string, fields: Record<string, unknown>) => ({
  id, family_id: family, kind: 'document', action_type: 'create_reminder', status: 'open', title: 'A card', detail: null,
  payload: {}, source_kind: null, source_id: null, member_id: null, urgency: 1, dedupe_key: `k-${id}`,
  expires_at: null, resolved_at: null, resolved_by: null, updated_at: AT, ...fields,
});

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.revalidate = [];
  h.superAdmin = false;
  h.signedOut = false;
  db.seed('families', [
    { id: A, name: 'Household A', timezone: 'UTC', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
    { id: B, name: 'Household B', timezone: 'UTC', trial_ends_at: '2020-01-01T00:00:00.000Z', closed_at: null },
  ]);
  db.seed('subscriptions', [
    { family_id: A, plan: 'plus', status: 'active', current_period_end: null },
    { family_id: B, plan: 'plus', status: 'active', current_period_end: null },
  ]);
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: memberOf(role), family_id: A, user_id: userOf(role), role, is_active: true })),
    { id: '00000009-0000-4000-8000-0000000000b1', family_id: B, user_id: B_USER, role: 'parent', is_active: true },
  ]);
  db.seed('user_preferences', ROLES.map((role) => ({ user_id: userOf(role), active_family_id: A })));
  db.seed('autopilot_suggestions', [
    card(EVERYONE, A, {}),
    card(FINANCE, A, { kind: 'finance', title: 'A charge tomorrow' }),
    card(INSURANCE, A, { kind: 'insurance', title: 'Policy renews', member_id: memberOf('teen') }),
    card(THEIRS, B, {}),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const cardRow = (id: string) => db.table('autopilot_suggestions').find((r) => r.id === id);
const cards = () => structuredClone(db.table('autopilot_suggestions'));

function expectDismissedBy(id: string, role: Role) {
  expect(cardRow(id)).toMatchObject({ status: 'dismissed', resolved_by: userOf(role), resolved_at: expect.any(String) });
}

describe('dismissing a card every member is shown', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'] as const)(`${ID} lets a %s dismiss it, stamping who did`, async (role) => {
    signInAs(role);
    expect(await dismiss(role, EVERYONE)).toEqual({ ok: true, status: 'dismissed' });
    expectDismissedBy(EVERYONE, role);
    expect(cardRow(FINANCE)?.status).toBe('open');
    expect(h.revalidate).toContain('/dashboard/autopilot');
  });
});

describe('a money card', () => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'] as const)(`${ID} lets a %s dismiss it`, async (role) => {
    signInAs(role);
    expect(await dismiss(role, FINANCE)).toEqual({ ok: true, status: 'dismissed' });
    expectDismissedBy(FINANCE, role);
  });

  it(`${ID} answers a guest as if the card did not exist, and changes nothing`, async () => {
    signInAs('guest');
    const before = cards();
    expect(await dismiss('guest', FINANCE)).toEqual({ ok: false, code: 'notFound' });
    expect(cards()).toEqual(before);
    expect(h.revalidate).toEqual([]);
  });
});

describe("an insurance card naming the teen's policy", () => {
  it.each(['parent', 'adult', 'teen'] as const)(`${ID} lets a %s (a manager or the named member) dismiss it`, async (role) => {
    signInAs(role);
    expect(await dismiss(role, INSURANCE)).toEqual({ ok: true, status: 'dismissed' });
    expectDismissedBy(INSURANCE, role);
  });

  it.each(['child', 'caregiver', 'guest'] as const)(`${ID} answers a %s as if the card did not exist, and changes nothing`, async (role) => {
    signInAs(role);
    const before = cards();
    expect(await dismiss(role, INSURANCE)).toEqual({ ok: false, code: 'notFound' });
    expect(cards()).toEqual(before);
  });
});

describe('another household', () => {
  it(`${ID} answers household B's card id as not found, and neither household changes`, async () => {
    signInAs('parent');
    const before = cards();
    expect(await dismiss('parent', THEIRS)).toEqual({ ok: false, code: 'notFound' });
    expect(cards()).toEqual(before);
  });

  it(`${ID} refuses a request drawn for household B's page, and changes nothing`, async () => {
    signInAs('parent');
    const before = cards();
    expect(await dismiss('parent', EVERYONE, { expectedFamilyId: B })).toEqual({ ok: false, code: 'contextChanged' });
    expect(cards()).toEqual(before);
  });

  it(`${ID} refuses a request drawn for another user's page, and changes nothing`, async () => {
    signInAs('parent');
    const before = cards();
    expect(await dismiss('parent', EVERYONE, { expectedUserId: B_USER })).toEqual({ ok: false, code: 'contextChanged' });
    expect(cards()).toEqual(before);
  });
});

describe('the session the page was drawn for', () => {
  it(`${ID} refuses when the member's role has changed since the page was drawn`, async () => {
    signInAs('parent');
    db.table('family_members').find((m) => m.id === memberOf('parent'))!.role = 'guest';
    const before = cards();
    expect(await dismiss('parent', EVERYONE)).toEqual({ ok: false, code: 'contextChanged' });
    expect(cards()).toEqual(before);
  });

  it(`${ID} refuses when the member has been removed`, async () => {
    signInAs('adult');
    db.table('family_members').find((m) => m.id === memberOf('adult'))!.is_active = false;
    const before = cards();
    expect(await dismiss('adult', EVERYONE)).toEqual({ ok: false, code: 'contextChanged' });
    expect(cards()).toEqual(before);
  });

  it(`${ID} sends a signed-out caller away before anything is read or written`, async () => {
    h.signedOut = true;
    const before = cards();
    await expect(dismiss('parent', EVERYONE)).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(cards()).toEqual(before);
  });
});

describe('the Plus plan', () => {
  beforeEach(() => {
    db.replace('subscriptions', db.table('subscriptions').filter((s) => s.family_id !== A));
  });

  it.each(['parent', 'teen'] as const)(`${ID} refuses a %s of a family without Plus, and changes nothing`, async (role) => {
    signInAs(role);
    const before = cards();
    expect(await dismiss(role, EVERYONE)).toEqual({ ok: false, code: 'accessDenied' });
    expect(cards()).toEqual(before);
  });

  it(`${ID} lets a super admin past the plan, as the page does`, async () => {
    h.superAdmin = true;
    signInAs('parent');
    expect(await dismiss('parent', EVERYONE)).toEqual({ ok: true, status: 'dismissed' });
    expectDismissedBy(EVERYONE, 'parent');
  });

  it(`${ID} refuses when the tier is turned off for everyone`, async () => {
    db.seed('subscriptions', [{ family_id: A, plan: 'plus', status: 'active', current_period_end: null }]);
    db.seed('app_settings', [{ key: 'feature_tiers', value: { autopilot: 'off' } }]);
    signInAs('parent');
    const before = cards();
    expect(await dismiss('parent', EVERYONE)).toEqual({ ok: false, code: 'accessDenied' });
    expect(cards()).toEqual(before);
  });
});
