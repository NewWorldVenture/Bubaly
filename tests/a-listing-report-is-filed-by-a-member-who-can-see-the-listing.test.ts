// Call-level role tests for reportListingAction
// (app/(app)/marketplace/report/actions.ts), Register B row ACTION-228F3E7BE775.
//
// THE POLICY, from the sources rather than from the action:
//   - A guest views the household and does not act on the marketplace: the
//     item page offers the Report button only when `role !== 'guest'`
//     (app/(app)/marketplace/item/[id]/page.tsx:75 and :397), and the action's
//     own comment says filing a report in the household's name is not a
//     guest's (app/(app)/marketplace/report/actions.ts:28).
//   - Every other member may report any listing that is not their own
//     (lib/marketplace/reports.ts canReport; the Report button on item/[id]).
//   - The live insert policy is 0358's: a member of the row's family, filing in
//     their OWN member id, open and unresolved
//     (supabase/migrations/0358_a_marketplace_report_is_filed_open_by_its_reporter.sql:21-31).
//   - The marketplace is between families: a listing household B shared into
//     the circle is reportable by household A, and the report is A's row. A B
//     listing that is NOT shared is not in A's answer after 0483 (RLS on
//     marketplace_listings), so it is "no longer exists" and nothing is filed.
//
// The table read is modelled the way 0483's RLS answers it: the caller's own
// family's listings from `marketplace_listings`, other families' only through
// the circle view. Everything else is the real action on the in-memory fake.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  createServiceClient: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer, createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('server-only', () => ({}));

const { reportListingAction } = await import('@/app/(app)/marketplace/report/actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const A_SIBLING = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const B_SELLER = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const A_LISTING = 'aaaaaaaa-0000-4000-8000-00000000011a';
const B_SHARED = 'bbbbbbbb-0000-4000-8000-00000000011b';
const B_PRIVATE = 'bbbbbbbb-0000-4000-8000-00000000011c';

const MEMBER_IDS: Record<string, string> = {
  parent: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  adult: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  teen: 'aaaaaaaa-0000-4000-8000-0000000000a3',
  child: 'aaaaaaaa-0000-4000-8000-0000000000a4',
  kid: 'aaaaaaaa-0000-4000-8000-0000000000a5',
  caregiver: 'aaaaaaaa-0000-4000-8000-0000000000a6',
  guest: 'aaaaaaaa-0000-4000-8000-0000000000a7',
};
type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

let db: InMemorySupabase;

function signInAs(role: Role, kid = false) {
  const id = MEMBER_IDS[kid ? 'kid' : role];
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}${kid ? '-kid' : ''}`, email: kid ? `${role}@kids.bubaly.app` : `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id, family_id: FAMILY_A } },
  });
  return id;
}

/**
 * The caller's request-bound client, as 0483's RLS answers it: the listings
 * table returns only household A's rows; other families' are read through the
 * circle view. Every other table is the in-memory fake untouched.
 */
function asHouseholdA() {
  return {
    from(name: string) {
      const builder = db.from(name);
      if (name !== 'marketplace_listings') return builder;
      const select = builder.select.bind(builder);
      return Object.assign(builder, {
        select: (...args: Parameters<typeof select>) => select(...args).eq('family_id', FAMILY_A),
      });
    },
  };
}

const listing = (id: string, familyId: string, memberId: string) => ({
  id, family_id: familyId, member_id: memberId, title: `Listing ${id.slice(-3)}`, status: 'available',
});

const everything = () => structuredClone({
  reports: db.table('marketplace_reports'),
  notifications: db.table('admin_notifications'),
  listings: db.table('marketplace_listings'),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    // 0193's partial unique index: one OPEN report per member per listing.
    uniques: { marketplace_reports: [['listing_id', 'reporter_member']] },
    defaults: { marketplace_reports: { status: 'open', resolution: null, reviewed_by: null, reviewed_at: null } },
  });
  mocks.createServer.mockImplementation(async () => asHouseholdA());
  mocks.createServiceClient.mockImplementation(() => db);
  db.seed('marketplace_listings', [
    listing(A_LISTING, FAMILY_A, A_SIBLING),
    listing(B_SHARED, FAMILY_B, B_SELLER),
    listing(B_PRIVATE, FAMILY_B, B_SELLER),
  ]);
  // The circle view exposes B's shared listing to A, without member_id.
  db.seed('marketplace_circle_listings', [{ id: B_SHARED, family_id: FAMILY_B, family_name: 'B', title: 'Listing 11b', status: 'available' }]);
});

const REPORTERS: { label: string; role: Role; kid: boolean }[] = [
  { label: 'parent', role: 'parent', kid: false },
  { label: 'adult', role: 'adult', kid: false },
  { label: 'teen', role: 'teen', kid: false },
  { label: 'child', role: 'child', kid: false },
  { label: 'child on a kid login', role: 'child', kid: true },
  { label: 'caregiver', role: 'caregiver', kid: false },
];

describe('ACTION-228F3E7BE775 reportListingAction', () => {
  it.each(REPORTERS)('ACTION-228F3E7BE775 a $label files an open report in their own name on a household listing', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    const result = await reportListingAction({ listingId: A_LISTING, reason: 'scam', details: '  Asked for a wire transfer.  ' });

    expect(result).toEqual({ ok: true });
    expect(db.table('marketplace_reports')).toHaveLength(1);
    expect(db.table('marketplace_reports')[0]).toMatchObject({
      family_id: FAMILY_A, listing_id: A_LISTING, reporter_member: me, reason: 'scam',
      details: 'Asked for a wire transfer.', status: 'open', resolution: null, reviewed_by: null, reviewed_at: null,
    });
    expect(db.table('admin_notifications')).toHaveLength(1);
    expect(db.table('admin_notifications')[0]).toMatchObject({
      kind: 'marketplace_report', related_type: 'marketplace_report', url: '/admin/marketplace/reports?status=needs_action',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/marketplace/item/${A_LISTING}`);
  });

  it.each(REPORTERS)('ACTION-228F3E7BE775 a $label reports a listing household B shared into the circle, as household A’s report', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    const listingsBefore = structuredClone(db.table('marketplace_listings'));

    expect(await reportListingAction({ listingId: B_SHARED, reason: 'prohibited' })).toEqual({ ok: true });

    expect(db.table('marketplace_reports')).toEqual([
      expect.objectContaining({ family_id: FAMILY_A, listing_id: B_SHARED, reporter_member: me, reason: 'prohibited', details: null }),
    ]);
    expect(db.table('marketplace_reports').filter((r) => r.family_id === FAMILY_B)).toEqual([]);
    expect(db.table('marketplace_listings')).toEqual(listingsBefore);
  });

  it('ACTION-228F3E7BE775 a guest is refused before anything is read, and nothing is filed', async () => {
    signInAs('guest');
    const before = everything();

    expect(await reportListingAction({ listingId: A_LISTING, reason: 'scam' })).toEqual({ ok: false, error: 'actionRefusal.notAllowed' });

    expect(everything()).toEqual(before);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-228F3E7BE775 a guest is refused on household B’s shared listing too', async () => {
    signInAs('guest');
    const before = everything();
    expect(await reportListingAction({ listingId: B_SHARED, reason: 'scam' })).toEqual({ ok: false, error: 'actionRefusal.notAllowed' });
    expect(everything()).toEqual(before);
  });

  it.each(REPORTERS)('ACTION-228F3E7BE775 a $label cannot report a household B listing that A cannot see', async ({ role, kid }) => {
    signInAs(role, kid);
    const before = everything();

    expect(await reportListingAction({ listingId: B_PRIVATE, reason: 'spam' }))
      .toEqual({ ok: false, error: 'actions.thatListingNoLongerExists' });

    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-228F3E7BE775 a member cannot report their own listing', async () => {
    const me = signInAs('teen');
    db.seed('marketplace_listings', [listing('aaaaaaaa-0000-4000-8000-00000000011d', FAMILY_A, me)]);
    const before = everything();

    expect(await reportListingAction({ listingId: 'aaaaaaaa-0000-4000-8000-00000000011d', reason: 'spam' }))
      .toEqual({ ok: false, error: 'actions.youCanTReportYour' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-228F3E7BE775 a second open report on the same listing is answered, not stacked', async () => {
    signInAs('adult');
    expect(await reportListingAction({ listingId: A_LISTING, reason: 'spam' })).toEqual({ ok: true });
    const before = everything();

    expect(await reportListingAction({ listingId: A_LISTING, reason: 'scam' })).toEqual({ ok: false, error: 'actions.youVeAlreadyReportedThis' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-228F3E7BE775 refuses a reason the dialog never offers', async () => {
    signInAs('parent');
    const before = everything();
    expect(await reportListingAction({ listingId: A_LISTING, reason: 'i-just-dislike-it' })).toEqual({ ok: false, error: 'actions.pickAReason' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-228F3E7BE775 a refused insert is reported, with no admin notification and no revalidation', async () => {
    signInAs('parent');
    mocks.createServer.mockImplementation(async () => {
      const client = asHouseholdA();
      return {
        from(name: string) {
          const builder = client.from(name);
          if (name !== 'marketplace_reports') return builder;
          return Object.assign(builder, {
            insert: () => Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }),
          });
        },
      };
    });
    const result = await reportListingAction({ listingId: A_LISTING, reason: 'spam' });
    expect(result.ok).toBe(false);
    expect(db.table('marketplace_reports')).toEqual([]);
    expect(db.table('admin_notifications')).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
