import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

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

const { loadPushCampaignAudience } = await import('@/lib/marketing/push-audience');
const { getMarketingCustomersWithError } = await import('@/lib/marketing/customers');
const { resolveRecipients } = await import('@/lib/marketing/send');
type DB = SupabaseClient<Database>;

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
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
