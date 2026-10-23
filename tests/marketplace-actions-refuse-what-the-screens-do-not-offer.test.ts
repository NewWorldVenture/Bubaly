import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * The marketplace's server actions refuse what its screens no longer offer, so
 * a direct call is answered the same way the screen is.
 *
 *  - N4. Leaving a circle the family FOUNDED dissolves it for every household
 *    (marketplace_leave_circle deletes it, cascading every other family's
 *    membership and shares). It took no role check, unlike create, join and
 *    share; now a child, teen, caregiver or guest of the founding family is
 *    refused, and leaving a circle another family founded stays open.
 *  - N8. "I'm interested" on an auction flipped it to 'pending' (0154's
 *    trigger), which every bid, Buy-It-Now and the close then refuse.
 *  - N12. A guest views the household. Opening a storefront, reaching out
 *    about a listing and rating an exchange act in its name; the home page
 *    does not show a guest the one-sentence composer either.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', memberId: 'm-self', rpcCalls: [] as string[] }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'fam-1', role: harness.role, member: { id: harness.memberId, family_id: 'fam-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
});

const { leaveCircleAction } = await import('@/app/(app)/marketplace/community/actions');
const { makeOfferAction, upsertStoreAction, leaveReviewAction } = await import('@/app/(app)/marketplace/actions');
const { default: MarketplaceHomePage } = await import('@/app/(app)/marketplace/page');
const { QuickPost } = await import('@/components/marketplace/quick-post');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

let db: InMemorySupabase;
beforeEach(() => {
  harness.role = 'parent';
  harness.memberId = 'm-self';
  harness.rpcCalls = [];
  db = createInMemorySupabase({
    rpc: { marketplace_leave_circle: () => { harness.rpcCalls.push('marketplace_leave_circle'); return null; } },
    uniques: { marketplace_offers: [['listing_id', 'member_id']] },
  });
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('dissolving a circle is a parent\'s or an adult\'s (N4)', () => {
  const seedCircle = (role: 'owner' | 'member') => db.seed('marketplace_circle_members', [
    { circle_id: 'circle-1', family_id: 'fam-1', family_name: 'Us', role },
    { circle_id: 'circle-1', family_id: 'fam-2', family_name: 'The Riveras', role: role === 'owner' ? 'member' : 'owner' },
  ]);

  it.each(['child', 'teen', 'caregiver', 'guest'])('refuses a %s of the founding family, and never reaches the RPC', async (role) => {
    seedCircle('owner');
    harness.role = role;
    expect(await leaveCircleAction('circle-1')).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan16') });
    expect(harness.rpcCalls).toEqual([]);
  });

  it('lets a parent or adult of the founding family dissolve it', async () => {
    seedCircle('owner');
    for (const role of ['parent', 'adult']) {
      harness.role = role;
      expect(await leaveCircleAction('circle-1')).toEqual({ ok: true });
    }
    expect(harness.rpcCalls).toEqual(['marketplace_leave_circle', 'marketplace_leave_circle']);
  });

  it('still lets a teen step their family back from a circle another family founded', async () => {
    seedCircle('member');
    harness.role = 'teen';
    expect(await leaveCircleAction('circle-1')).toEqual({ ok: true });
    expect(harness.rpcCalls).toEqual(['marketplace_leave_circle']);
  });

  it('refuses rather than guesses when the family\'s role in the circle cannot be read', async () => {
    seedCircle('owner');
    harness.role = 'teen';
    const realFrom = db.from.bind(db);
    (db as unknown as { from: (table: string) => object }).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_circle_members') return builder;
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === 'maybeSingle') return async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (...args: unknown[]) => { (value as (...a: unknown[]) => unknown).apply(target, args); return new Proxy(target, this); } : value;
        },
      });
    };
    const res = await leaveCircleAction('circle-1');
    expect(res.ok).toBe(false);
    expect(harness.rpcCalls).toEqual([]);
  });
});

describe('an auction takes bids, not interest (N8)', () => {
  const seedListing = (saleFormat: string) => db.seed('marketplace_listings', [{
    id: 'listing-1', family_id: 'fam-1', member_id: 'm-sibling', kind: 'sell', status: 'available', sale_format: saleFormat,
  }]);

  it('refuses interest in the family\'s own live auction, and leaves it available', async () => {
    seedListing('auction');
    expect(await makeOfferAction('listing-1')).toEqual({ ok: false, error: t('marketplace.anAuctionTakesBidsNotInterest') });
    expect(db.table('marketplace_offers')).toEqual([]);
    expect(db.table('marketplace_listings')[0].status).toBe('available');
  });

  it('still sends interest on a fixed-price sale', async () => {
    seedListing('fixed');
    expect(await makeOfferAction('listing-1')).toEqual({ ok: true });
    expect(db.table('marketplace_offers')).toMatchObject([{ listing_id: 'listing-1', member_id: 'm-self', kind: 'interest' }]);
  });
});

describe('a guest views the marketplace (N12)', () => {
  beforeEach(() => {
    db.seed('marketplace_listings', [{ id: 'listing-1', family_id: 'fam-1', member_id: 'm-sibling', kind: 'sell', status: 'available', sale_format: 'fixed' }]);
    db.seed('marketplace_orders', [{ id: 'order-1', family_id: 'fam-1', listing_id: 'listing-1', buyer_member: 'm-self', seller_member: 'm-sibling', status: 'completed' }]);
  });

  it('is refused a storefront, interest and a review before anything is read', async () => {
    harness.role = 'guest';
    const refused = { ok: false, error: t('actionRefusal.notAllowed') };
    const before = db.log.length;
    expect(await upsertStoreAction({ name: 'Guest goods' })).toEqual(refused);
    expect(await makeOfferAction('listing-1')).toEqual(refused);
    expect(await leaveReviewAction({ orderId: 'order-1', rating: 5 })).toEqual(refused);
    expect(db.log.length).toBe(before);
    expect(db.table('marketplace_stores')).toEqual([]);
    expect(db.table('marketplace_offers')).toEqual([]);
    expect(db.table('marketplace_reviews')).toEqual([]);
  });

  it('a member who is not a guest still does all three', async () => {
    harness.role = 'teen';
    expect(await upsertStoreAction({ name: 'Teen goods' })).toEqual({ ok: true });
    expect(await makeOfferAction('listing-1')).toEqual({ ok: true });
    expect(await leaveReviewAction({ orderId: 'order-1', rating: 5 })).toEqual({ ok: true });
  });

  /** Every element the page returned, client components included, unrendered. */
  function elements(node: ReactNode): ReactElement[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<{ children?: ReactNode }>(node)) return [];
    return [node, ...elements(node.props.children)];
  }

  it('the home page shows the one-sentence composer to a member, not to a guest', async () => {
    harness.role = 'teen';
    expect(elements(await MarketplaceHomePage()).some((e) => e.type === QuickPost)).toBe(true);
    harness.role = 'guest';
    expect(elements(await MarketplaceHomePage()).some((e) => e.type === QuickPost)).toBe(false);
  });
});
