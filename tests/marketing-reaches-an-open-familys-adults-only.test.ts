import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// admin-writers N1-S1. Two audiences reached people they should not have:
//
//  - Marketing push was built from enabled devices, minus minors and anyone
//    without marketing-push consent, and never looked at families.closed_at.
//    Closing an account leaves its devices enabled, so the members of a family
//    that closed kept getting campaign pushes, while the email campaign and
//    the automation runner already leave closed families out.
//  - The customer view's "owner" — the address every campaign and automation
//    mail goes to — was the first parent with an account, else ANY member with
//    one, inactive rows included. A family with no parent login mailed its
//    teen, or a guest it had removed.
//
// The real audience helper, customer view and campaign resolver against the
// in-memory database.

vi.mock('@/lib/email', () => ({ FROM_EMAIL: 'Bubaly <hello@bubaly.test>', emailEnabled: () => true, APP_URL: 'https://bubaly.test' }));
// The app's own member removal (R3-AW-REMOVED-MINOR-PUSH), run by a parent of
// fam-open against the same database.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-parent' },
    memberships: [{ familyId: 'fam-open', role: 'parent' }],
    active: { familyId: 'fam-open', role: 'parent', member: { id: 'm-u-parent-fam-open' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
process.env.CHILD_LOGIN_SECRET = 'test-secret-for-derivation';

const { loadPushCampaignAudience } = await import('@/lib/marketing/push-audience');
const { getMarketingCustomersWithError } = await import('@/lib/marketing/customers');
const { resolveRecipients } = await import('@/lib/marketing/send');
const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { REMOVED_MEMBER_PATCH } = await import('@/lib/constants/roles');
type DB = SupabaseClient<Database>;

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  for (const table of ['marketing_suppressions', 'subscriptions', 'marketing_segments']) db.seed(table, []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a marketing push campaign', () => {
  /** An account with a device, a profile and marketing-push consent. */
  function account(user: string) {
    db.seed('push_devices', [{ id: `dev-${user}`, user_id: user, enabled: true }]);
    db.seed('profiles', [{ id: user, email: `${user}@example.com` }]);
    db.seed('user_preferences', [{ user_id: user, notification_prefs: { marketingPush: true } }]);
  }
  const member = (user: string, family: string, role = 'parent', isActive = true) =>
    db.seed('family_members', [{ id: `m-${user}-${family}`, user_id: user, family_id: family, role, is_active: isActive }]);

  beforeEach(() => {
    db.seed('families', [
      { id: 'fam-open', name: 'Open', created_at: '2026-01-01T00:00:00Z', closed_at: null },
      { id: 'fam-closed', name: 'Closed', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-09-01T00:00:00Z' },
      { id: 'fam-closed-2', name: 'Closed too', created_at: '2026-01-01T00:00:00Z', closed_at: '2026-09-02T00:00:00Z' },
    ]);
  });

  it('does not reach an account whose only families closed', async () => {
    account('u-closed');
    member('u-closed', 'fam-closed');
    account('u-closed-twice');
    member('u-closed-twice', 'fam-closed');
    member('u-closed-twice', 'fam-closed-2', 'adult');
    expect(await loadPushCampaignAudience(db as unknown as DB), 'a closed family\'s members were still pushed to').toEqual([]);
  });

  // R2-AW-2. Removing a member deactivates the row (REMOVED_MEMBER_PATCH) and
  // keeps it, so an inactive guest row in an open family kept an account whose
  // own family closed in the push audience; the email side counts only active
  // members.
  it('does not reach an account whose own family closed through a family it was removed from', async () => {
    account('u-1');
    member('u-1', 'fam-closed');
    member('u-1', 'fam-open', 'guest', false);
    expect(await loadPushCampaignAudience(db as unknown as DB), 'an old, inactive row in an open family kept a closed family\'s parent in').toEqual([]);
  });

  it('a removed account with no family left is an account without a family, and a removed teen row still keeps a minor out (controls)', async () => {
    // Removed from an open family and in no other: no family, as before.
    account('u-removed');
    member('u-removed', 'fam-open', 'guest', false);
    // Active in an open family, with an old row in a closed one: still in.
    account('u-moved');
    member('u-moved', 'fam-closed', 'parent', false);
    member('u-moved', 'fam-open', 'adult');
    // An inactive teen row is still a teen's.
    account('u-kid');
    member('u-kid', 'fam-open', 'parent');
    member('u-kid', 'fam-closed', 'teen', false);
    expect((await loadPushCampaignAudience(db as unknown as DB)).sort()).toEqual(['u-moved', 'u-removed']);
  });

  it('still reaches an account with an open family, one without any family, and never a minor (controls)', async () => {
    account('u-open');
    member('u-open', 'fam-open');
    account('u-both');
    member('u-both', 'fam-closed');
    member('u-both', 'fam-open', 'adult');
    account('u-none');
    account('u-teen');
    member('u-teen', 'fam-open', 'teen');
    expect((await loadPushCampaignAudience(db as unknown as DB)).sort()).toEqual(['u-both', 'u-none', 'u-open']);
  });

  // R3-AW-REMOVED-MINOR-PUSH. Every removal in the app writes
  // REMOVED_MEMBER_PATCH ({ is_active: false, role: 'guest' }), so the teen
  // role the minors check read was gone, and the controls above seeded an
  // inactive `teen` row the app's removal never leaves. These remove the
  // member through the real removal action, so the row is the one it writes.
  describe('a minor removed through the app', () => {
    beforeEach(() => {
      Object.assign(db.auth, {
        admin: {
          getUserById: async (id: string) => ({ data: { user: { id, email: `${id}@example.com`, user_metadata: {}, app_metadata: {} } }, error: null }),
          updateUserById: async (id: string) => ({ data: { user: { id } }, error: null }),
        },
      });
      member('u-parent', 'fam-open');
    });
    afterEach(() => vi.useRealTimers());
    const audience = async () => (await loadPushCampaignAudience(db as unknown as DB)).sort();
    async function remove(user: string, loginRevocation = 'none') {
      expect(await removeFamilyMemberAction({ memberId: `m-${user}-fam-open` })).toMatchObject({ ok: true, loginRevocation });
      expect(db.table('family_members').find((row) => row.id === `m-${user}-fam-open`)).toMatchObject(REMOVED_MEMBER_PATCH);
    }
    const memberBorn = (user: string, role: string, birthday: string | null) =>
      db.seed('family_members', [{ id: `m-${user}-fam-open`, user_id: user, family_id: 'fam-open', role, is_active: true, birthday }]);

    it('a teen whose family recorded their birthday is not pushed to once removed', async () => {
      account('u-teen');
      memberBorn('u-teen', 'teen', '2011-05-01');
      expect(await audience()).toEqual([]);
      await remove('u-teen');
      expect(await audience(), 'a teen removed through the app was pushed to').toEqual([]);
    });

    it('a child who signs in with a kid login is not pushed to once removed, with no birthday on record', async () => {
      db.seed('push_devices', [{ id: 'dev-u-kid', user_id: 'u-kid', enabled: true }]);
      db.seed('profiles', [{ id: 'u-kid', email: 'child.emma@kids.bubaly.app' }]);
      db.seed('user_preferences', [{ user_id: 'u-kid', notification_prefs: { marketingPush: true } }]);
      memberBorn('u-kid', 'child', null);
      db.seed('child_logins', [{ id: 'cl-kid', family_id: 'fam-open', member_id: 'm-u-kid-fam-open', user_id: 'u-kid', username: 'emma' }]);
      await remove('u-kid', 'revoked');
      expect(await audience(), 'a removed kid login was pushed to').toEqual([]);
    });

    it('controls: an adult removed through the app is an account without a family, and an adult\'s recorded birthday keeps no one out', async () => {
      account('u-removed-adult');
      memberBorn('u-removed-adult', 'adult', '1990-01-01');
      await remove('u-removed-adult');
      account('u-grown');
      memberBorn('u-grown', 'adult', '1988-06-30');
      expect(await audience()).toEqual(['u-grown', 'u-removed-adult']);
    });

    // R4-AW-REMOVED-TEEN-OWN-ADDRESS. A teen who signs in with their own
    // address, with no birthday on record, kept nothing that said so once
    // removed: the row is a guest's. The invite they joined by still does
    // (accept_invite keeps its role and who accepted it).
    const joinedBy = (user: string, role: string, family = 'fam-open', n = 1) =>
      db.seed('invites', [{ id: `inv-${user}-${family}-${n}`, family_id: family, email: `${user}@example.com`, role, status: 'accepted', accepted_by: user }]);

    it('a teen who joined by a teen invite with their own address, no birthday on record, is not pushed to once removed', async () => {
      account('u-teen-own');
      memberBorn('u-teen-own', 'teen', null);
      joinedBy('u-teen-own', 'teen');
      expect(await audience()).toEqual([]);
      await remove('u-teen-own');
      expect(await audience(), 'a removed teen with their own address was pushed to').toEqual([]);
    });

    it('a removed teen brought back by a second teen invite is still not pushed to, though accept_invite reactivated the row as a guest', async () => {
      account('u-back');
      memberBorn('u-back', 'teen', null);
      joinedBy('u-back', 'teen');
      await remove('u-back');
      // What accept_invite (0136) does with a second invite: `on conflict ... set is_active = true`, the role left as removal wrote it.
      Object.assign(db.table('family_members').find((row) => row.id === 'm-u-back-fam-open')!, { is_active: true });
      joinedBy('u-back', 'teen', 'fam-open', 2);
      expect(await audience(), 'a teen back in the family as a guest was pushed to').toEqual([]);
    });

    it('a teen invite in one family is not undone by a family of their own', async () => {
      account('u-own-family');
      memberBorn('u-own-family', 'teen', null);
      joinedBy('u-own-family', 'teen');
      await remove('u-own-family');
      member('u-own-family', 'fam-other');
      db.seed('families', [{ id: 'fam-other', name: 'Their own', created_at: '2026-01-01T00:00:00Z', closed_at: null }]);
      expect(await audience()).toEqual([]);
    });

    it('controls: a teen the family made an adult, one whose 18th birthday is on record, and an adult who joined by an adult invite are still reached', async () => {
      account('u-made-adult');
      memberBorn('u-made-adult', 'adult', null);
      joinedBy('u-made-adult', 'teen');
      account('u-turned-18');
      memberBorn('u-turned-18', 'teen', '2007-03-01');
      joinedBy('u-turned-18', 'teen');
      await remove('u-turned-18');
      account('u-invited-adult');
      memberBorn('u-invited-adult', 'adult', null);
      joinedBy('u-invited-adult', 'adult');
      await remove('u-invited-adult');
      expect(await audience()).toEqual(['u-invited-adult', 'u-made-adult', 'u-turned-18']);
    });

    it('an accepted-invite read that fails sends nothing, and is not made when no one is left to decide', async () => {
      const faulty = withFaults(db, (table) => (table === 'invites' ? { message: 'invites unavailable' } : null));
      // A device whose owner never consented: nothing for the invites to decide.
      db.seed('push_devices', [{ id: 'dev-u-quiet', user_id: 'u-quiet', enabled: true }]);
      db.seed('profiles', [{ id: 'u-quiet', email: 'u-quiet@example.com' }]);
      expect(await loadPushCampaignAudience(faulty as unknown as DB)).toEqual([]);
      account('u-adult');
      memberBorn('u-adult', 'adult', null);
      await expect(loadPushCampaignAudience(faulty as unknown as DB)).rejects.toThrow('Could not completely load marketing push accepted invites. No campaign push was sent.');
    });

    it('counts a member as grown up only once their 18th birthday has come in every zone', async () => {
      // 06:00 UTC on 26 October: the 26th in Greenwich, still the 25th at UTC-12.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));
      account('u-eighteen-today');
      memberBorn('u-eighteen-today', 'adult', '2008-10-26');
      account('u-eighteen-yesterday');
      memberBorn('u-eighteen-yesterday', 'adult', '2008-10-25');
      expect(await audience()).toEqual(['u-eighteen-yesterday']);
    });
  });
});

describe('the owner a family\'s marketing mail goes to', () => {
  function family(id: string, members: { user: string; role: string; active?: boolean; email: string }[]) {
    db.seed('families', [{ id, name: id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null }]);
    for (const m of members) {
      db.seed('family_members', [{ id: `m-${m.user}`, family_id: id, user_id: m.user, role: m.role, is_active: m.active ?? true }]);
      db.seed('profiles', [{ id: m.user, email: m.email }]);
    }
  }
  const owners = async () => {
    const { customers, error } = await getMarketingCustomersWithError(db as unknown as DB);
    expect(error).toBeNull();
    return Object.fromEntries(customers.map((c) => [c.familyId, c.ownerEmail]));
  };

  it('is never a teen, a caregiver, a guest or a member the family removed', async () => {
    family('fam-teen', [{ user: 'u-teen', role: 'teen', email: 'teen@example.com' }]);
    family('fam-help', [{ user: 'u-carer', role: 'caregiver', email: 'carer@example.com' }, { user: 'u-guest', role: 'guest', email: 'guest@example.com' }]);
    family('fam-removed', [{ user: 'u-gone', role: 'parent', active: false, email: 'gone@example.com' }]);
    expect(await owners()).toEqual({ 'fam-teen': null, 'fam-help': null, 'fam-removed': null });
    expect(await resolveRecipients(db as unknown as DB, { segment_id: null }), 'a non-parent was in the campaign audience').toEqual([]);
  });

  it('is an active parent, else an active adult (controls)', async () => {
    family('fam-parent', [
      { user: 'a-adult', role: 'adult', email: 'adult@example.com' },
      { user: 'b-parent', role: 'parent', email: 'parent@example.com' },
      { user: 'c-teen', role: 'teen', email: 'kid@example.com' },
    ]);
    family('fam-adult', [
      { user: 'd-parent-removed', role: 'parent', active: false, email: 'removed@example.com' },
      { user: 'e-adult', role: 'adult', email: 'second@example.com' },
    ]);
    expect(await owners()).toEqual({ 'fam-parent': 'parent@example.com', 'fam-adult': 'second@example.com' });
    expect((await resolveRecipients(db as unknown as DB, { segment_id: null })).sort()).toEqual(['parent@example.com', 'second@example.com']);
  });
});
