// Call-level role tests for the Contact Center's four writes
// (app/(app)/dashboard/contact-center/actions.ts):
//   assignEmailAction       ACTION-94F23566076E
//   provisionNumberAction   ACTION-FD08ADD85C8A
//   setMessageStatusAction  ACTION-183CAA85923F
//   updateConciergeAction   ACTION-E698D59FDBA3
//
// THE POLICY, from the sources:
//  - family_contact_channels and family_inbox_messages carry a SELECT policy
//    only (supabase/migrations/0214_family_contact_center.sql:72-79); every
//    write is the service role's, so the action is the whole boundary.
//  - The channel's identity (address, number, concierge) is a parent's: the
//    action's own guard comment, `isAdmin` = parent (lib/constants/roles.ts),
//    and the page hands `canManage` only to `role === 'parent'`
//    (app/(app)/dashboard/contact-center/page.tsx:65).
//  - Filing a message is a manager's (parent or adult): the action's comment,
//    `isManager`, and `canFile={isManager(role)}` on the same page (:66).
//  - All four are Family+ (level 2): navigation's minLevel 2 for the page
//    (lib/constants/navigation.ts:95) and the action's level check.
//  - A guest is sent away from the page altogether (lib/auth/guest-scope.ts).
//
// The plan is resolved by the REAL resolveFamilyPlanLevel against seeded
// `subscriptions` and `families` rows, not stubbed, so the plan gate is the one
// production runs.
//
// provisionNumberAction: Twilio is not configured in the test environment
// (lib/guardian/twilio.ts `isTwilioConfigured`), so the reachable success is the
// "request recorded as pending" branch and the "already has a number" branch.
// Searching for and buying a number calls Twilio, which the repository has no
// stub for; every gate before that call is tested here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  db: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => mocks.db,
  createServiceClient: () => mocks.db,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params) };
});

const { assignEmailAction, provisionNumberAction, setMessageStatusAction, updateConciergeAction } =
  await import('@/app/(app)/dashboard/contact-center/actions');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const ONLY_ADMIN = t('actions.onlyAFamilyAdminCan');
const PLAN_REQUIRED = t('actions.theFamilyContactCenterIs');
const ONLY_MANAGER_FILES = t('actions.onlyAParentOrAdultCanFileAMessage');
const COULD_NOT_UPDATE_MESSAGE = t('actions.couldNotUpdateTheMessage');
const ADDRESS_TAKEN = t('actions.thatAddressIsAlreadyTaken');

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const A_MESSAGE = 'a1111111-1111-4111-8111-111111111111';
const B_MESSAGE = 'b2222222-2222-4222-8222-222222222222';

type Caller = { role: string; email: string };
const PARENT: Caller = { role: 'parent', email: 'parent@example.com' };
const ADULT: Caller = { role: 'adult', email: 'adult@example.com' };
const TEEN: Caller = { role: 'teen', email: 'teen@example.com' };
const CHILD: Caller = { role: 'child', email: 'child@example.com' };
const KID_LOGIN: Caller = { role: 'child', email: `child.sam@${CHILD_LOGIN_EMAIL_DOMAIN}` };
const CAREGIVER: Caller = { role: 'caregiver', email: 'caregiver@example.com' };
const GUEST: Caller = { role: 'guest', email: 'guest@example.com' };

const NOT_A_PARENT = [ADULT, TEEN, CHILD, KID_LOGIN, CAREGIVER, GUEST];
const NOT_A_MANAGER = [TEEN, CHILD, KID_LOGIN, CAREGIVER, GUEST];
const label = (c: Caller) => (c === KID_LOGIN ? 'kid login' : c.role);

let db: InMemorySupabase;

function signedInAs(caller: Caller) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${caller.role}`, email: caller.email },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role: caller.role, member: { id: `member-${caller.role}` } },
  });
}

function signedOut() {
  mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT /login'));
}

/** Household A on `plan`; household B always on Family+. */
function seed(plan: 'plus' | 'basic' = 'plus') {
  db.seed('families', [
    { id: FAMILY_A, trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [
    { id: 'sub-a', family_id: FAMILY_A, plan, status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
    { id: 'sub-b', family_id: FAMILY_B, plan: 'plus', status: 'active', current_period_end: '2099-01-01T00:00:00Z' },
  ]);
  db.seed('family_contact_channels', [
    { family_id: FAMILY_A, email_local: null, phone_number: null, phone_number_sid: null, provisioning_status: 'none', ai_concierge_enabled: false, ai_greeting: null, forward_to_phone: null },
    { family_id: FAMILY_B, email_local: 'bravo-family', phone_number: '+14155550199', phone_number_sid: 'PN-b', provisioning_status: 'active', ai_concierge_enabled: true, ai_greeting: 'Hello from B', forward_to_phone: '+14155550100' },
  ]);
  db.seed('family_inbox_messages', [
    { id: A_MESSAGE, family_id: FAMILY_A, status: 'new', subject: 'Dentist reminder' },
    { id: B_MESSAGE, family_id: FAMILY_B, status: 'new', subject: 'School trip' },
  ]);
}

/**
 * uq_contact_channels_email_local (0214:31) as Postgres enforces it on an
 * UPDATE: a local-part another family's row already holds answers 23505 and
 * changes nothing. The in-memory fake checks uniques on insert only, so this
 * client models the index for the one write that can hit it.
 */
function withTheEmailIndex(): unknown {
  const clash = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_contact_channels_email_local"', details: null, hint: null } };
  const refused: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(clash);
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(clash);
      return () => refused;
    },
  });
  return {
    from(name: string) {
      const builder = db.from(name);
      if (name !== 'family_contact_channels') return builder;
      const update = builder.update.bind(builder);
      return Object.assign(builder, {
        update: (patch: Record<string, unknown>) => {
          const taken = typeof patch.email_local === 'string'
            && db.table(name).some((r) => r.email_local === patch.email_local);
          return taken ? refused : update(patch);
        },
      });
    },
  };
}

const channel = (familyId: string) => db.table('family_contact_channels').find((r) => r.family_id === familyId);
const message = (id: string) => db.table('family_inbox_messages').find((r) => r.id === id);
const writable = () => structuredClone({
  channels: db.table('family_contact_channels'),
  messages: db.table('family_inbox_messages'),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: { family_contact_channels: [['family_id'], ['email_local']] },
  });
  mocks.db = db;
});
afterEach(() => vi.restoreAllMocks());

describe('assignEmailAction is a parent\'s, on Family+', () => {
  it('ACTION-94F23566076E a parent claims the address, and only household A\'s channel holds it', async () => {
    seed();
    signedInAs(PARENT);
    const b = structuredClone(channel(FAMILY_B));

    await expect(assignEmailAction('Rivera-Family')).resolves.toEqual({ ok: true, local: 'rivera-family' });

    expect(channel(FAMILY_A)?.email_local).toBe('rivera-family');
    expect(channel(FAMILY_B)).toEqual(b);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/contact-center');
  });

  it.each(NOT_A_PARENT.map((c) => [label(c), c] as const))('ACTION-94F23566076E a %s is refused and nothing is written', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const before = writable();
    await expect(assignEmailAction('rivera-family')).resolves.toEqual({ ok: false, error: ONLY_ADMIN });
    expect(writable()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-94F23566076E a parent on Family Basic is refused and nothing is written', async () => {
    seed('basic');
    signedInAs(PARENT);
    const before = writable();
    await expect(assignEmailAction('rivera-family')).resolves.toEqual({ ok: false, error: PLAN_REQUIRED });
    expect(writable()).toEqual(before);
  });

  it('ACTION-94F23566076E a signed-out caller is sent to sign in and nothing is written', async () => {
    seed();
    signedOut();
    const before = writable();
    await expect(assignEmailAction('rivera-family')).rejects.toThrow('NEXT_REDIRECT');
    expect(writable()).toEqual(before);
  });

  it('ACTION-94F23566076E household B\'s address cannot be taken: refused as taken, and B keeps it', async () => {
    seed();
    mocks.db = withTheEmailIndex();
    signedInAs(PARENT);
    const before = writable();
    await expect(assignEmailAction('bravo-family')).resolves.toEqual({ ok: false, error: ADDRESS_TAKEN });
    expect(writable()).toEqual(before);
  });
});

describe('provisionNumberAction is a parent\'s, on Family+', () => {
  it('ACTION-FD08ADD85C8A a parent\'s request is recorded as pending on household A\'s channel only (Twilio unconfigured)', async () => {
    seed();
    signedInAs(PARENT);
    const b = structuredClone(channel(FAMILY_B));

    await expect(provisionNumberAction('415')).resolves.toEqual({ ok: true, pending: true });

    expect(channel(FAMILY_A)).toMatchObject({ provisioning_status: 'pending', phone_number: null });
    expect(channel(FAMILY_B), 'household B\'s number is not read into A or changed').toEqual(b);
  });

  it('ACTION-FD08ADD85C8A a parent whose family already has a number is answered with it, and nothing is bought or written', async () => {
    seed();
    db.replace('family_contact_channels', db.table('family_contact_channels').map((r) =>
      (r.family_id === FAMILY_A ? { ...r, phone_number: '+14155550123', provisioning_status: 'active' } : r)));
    signedInAs(PARENT);
    const before = writable();
    await expect(provisionNumberAction()).resolves.toEqual({ ok: true, phoneNumber: '+14155550123' });
    expect(writable()).toEqual(before);
  });

  it.each(NOT_A_PARENT.map((c) => [label(c), c] as const))('ACTION-FD08ADD85C8A a %s is refused and nothing is written', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const before = writable();
    await expect(provisionNumberAction('415')).resolves.toEqual({ ok: false, error: ONLY_ADMIN });
    expect(writable()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-FD08ADD85C8A a parent on Family Basic is refused and nothing is written', async () => {
    seed('basic');
    signedInAs(PARENT);
    const before = writable();
    await expect(provisionNumberAction('415')).resolves.toEqual({ ok: false, error: PLAN_REQUIRED });
    expect(writable()).toEqual(before);
  });

  it('ACTION-FD08ADD85C8A a signed-out caller is sent to sign in and nothing is written', async () => {
    seed();
    signedOut();
    const before = writable();
    await expect(provisionNumberAction('415')).rejects.toThrow('NEXT_REDIRECT');
    expect(writable()).toEqual(before);
  });
});

describe('updateConciergeAction is a parent\'s, on Family+', () => {
  const input = { enabled: true, greeting: '  Hi, you reached the Riveras.  ', forwardTo: '+1 (415) 555-0123' };

  it('ACTION-E698D59FDBA3 a parent sets the concierge on household A\'s channel only', async () => {
    seed();
    signedInAs(PARENT);
    const b = structuredClone(channel(FAMILY_B));

    await expect(updateConciergeAction(input)).resolves.toEqual({ ok: true });

    expect(channel(FAMILY_A)).toMatchObject({ ai_concierge_enabled: true, ai_greeting: 'Hi, you reached the Riveras.', forward_to_phone: '+14155550123' });
    expect(channel(FAMILY_B)).toEqual(b);
  });

  it.each(NOT_A_PARENT.map((c) => [label(c), c] as const))('ACTION-E698D59FDBA3 a %s is refused and nothing is written', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const before = writable();
    await expect(updateConciergeAction(input)).resolves.toEqual({ ok: false, error: ONLY_ADMIN });
    expect(writable()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-E698D59FDBA3 a parent on Family Basic is refused and nothing is written', async () => {
    seed('basic');
    signedInAs(PARENT);
    const before = writable();
    await expect(updateConciergeAction(input)).resolves.toEqual({ ok: false, error: PLAN_REQUIRED });
    expect(writable()).toEqual(before);
  });

  it('ACTION-E698D59FDBA3 a signed-out caller is sent to sign in and nothing is written', async () => {
    seed();
    signedOut();
    const before = writable();
    await expect(updateConciergeAction(input)).rejects.toThrow('NEXT_REDIRECT');
    expect(writable()).toEqual(before);
  });
});

describe('setMessageStatusAction is a manager\'s, on Family+', () => {
  it.each([PARENT, ADULT].map((c) => [label(c), c] as const))('ACTION-183CAA85923F a %s archives household A\'s message, and only that row changes', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const b = structuredClone(message(B_MESSAGE));

    await expect(setMessageStatusAction(A_MESSAGE, 'archived')).resolves.toEqual({ ok: true });

    expect(message(A_MESSAGE)?.status).toBe('archived');
    expect(message(B_MESSAGE)).toEqual(b);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/contact-center');
  });

  it.each(NOT_A_MANAGER.map((c) => [label(c), c] as const))('ACTION-183CAA85923F a %s is refused and nothing is written', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const before = writable();
    await expect(setMessageStatusAction(A_MESSAGE, 'archived')).resolves.toEqual({ ok: false, error: ONLY_MANAGER_FILES });
    expect(writable()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-183CAA85923F a parent on Family Basic is refused and nothing is written', async () => {
    seed('basic');
    signedInAs(PARENT);
    const before = writable();
    await expect(setMessageStatusAction(A_MESSAGE, 'read')).resolves.toEqual({ ok: false, error: PLAN_REQUIRED });
    expect(writable()).toEqual(before);
  });

  it('ACTION-183CAA85923F a signed-out caller is sent to sign in and nothing is written', async () => {
    seed();
    signedOut();
    const before = writable();
    await expect(setMessageStatusAction(A_MESSAGE, 'read')).rejects.toThrow('NEXT_REDIRECT');
    expect(writable()).toEqual(before);
  });

  it.each([PARENT, ADULT].map((c) => [label(c), c] as const))('ACTION-183CAA85923F a %s naming household B\'s message is refused, and neither household changes', async (_name, caller) => {
    seed();
    signedInAs(caller);
    const before = writable();
    await expect(setMessageStatusAction(B_MESSAGE, 'archived')).resolves.toEqual({ ok: false, error: COULD_NOT_UPDATE_MESSAGE });
    expect(writable()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
