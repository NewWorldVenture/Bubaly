import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * Another family's listing is shopped from its page.
 *
 * Since 0483 dropped marketplace_listings_circle_read, another family's
 * listing is readable only through the circle view. The auctions board, the
 * offers inbox and (now) the community feed link to /marketplace/item/<id>,
 * and that page read the TABLE scoped to the viewer's own family, so every
 * cross-family link ended in "not found": no bid, Buy-It-Now, offer, question
 * or report was reachable from the UI. The page now resolves the listing from
 * the table, then the view (or, without the view, the table read the old
 * policy answered), and treats the viewer as a shopper: no seller member, no
 * pickup spot, none of its own family's reads about the listing.
 *
 * The same cause emptied the buyer's side of the offers inbox and made every
 * report on a circle listing answer "that listing no longer exists".
 *
 * Riding along, on the same page: an auction offers no "I'm interested" (an
 * offer flips the listing to 'pending', which freezes it — N8), a guest is not
 * offered interest, a report or a question (N12), and the seller's rating is
 * over every review, not the first 1,000 (N17).
 */
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', memberId: 'm-buyer', familyId: 'fam-buyer' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/admin/notify', () => ({ recordAdminNotification: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: harness.familyId, role: harness.role, member: { id: harness.memberId, family_id: harness.familyId } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  const messages = getMessages('en-US');
  return {
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages }),
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
  };
});
vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({
    familyId: harness.familyId, userId: `user-${harness.memberId}`, members: [],
    selfMember: { id: harness.memberId }, role: harness.role,
  }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({ data: [], loading: false, error: null, stale: false, updatedAt: 0, refresh: async () => undefined }),
}));

const { default: ListingDetailPage } = await import('@/app/(app)/marketplace/item/[id]/page');
const { default: NegotiationsInboxPage } = await import('@/app/(app)/marketplace/negotiations/page');
const { reportListingAction } = await import('@/app/(app)/marketplace/report/actions');
const { AppNotFound } = await import('@/components/app/app-not-found');
const { resetMarketplaceSchemaWarnings } = await import('@/lib/marketplace/schema-compat');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const VIEW = 'marketplace_circle_listings';
const MISSING_VIEW = {
  code: 'PGRST205', message: `Could not find the table 'public.${VIEW}' in the schema cache`, details: null, hint: null,
};

/** A relation that does not exist: every call chains, every read answers the error. */
function missingRelation(error: unknown): object {
  const reply = { data: null, error, count: null, status: 404, statusText: 'Not Found' };
  const builder: object = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(reply).then(ok, bad);
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(reply);
      return () => builder;
    },
  });
  return builder;
}

type Schema = 'after' | 'before';

/**
 * A database on one side of 0483. After it the table answers for the caller's
 * own family only and another family's shared listing is in the view; before
 * it the view is missing and the table answers as the old circle policy did.
 */
function database(schema: Schema, options: { maxRows?: number } = {}): InMemorySupabase {
  const db = createInMemorySupabase({ maxRows: options.maxRows });
  if (schema === 'before') {
    const realFrom = db.from.bind(db);
    (db as unknown as { from: (table: string) => object }).from = (table: string) =>
      (table === VIEW ? missingRelation(MISSING_VIEW) : realFrom(table));
  }
  harness.db = db;
  return db;
}

/** Another family's listing where each schema can read it. */
function seedTheirs(db: InMemorySupabase, schema: Schema, row: Row) {
  const base = { family_id: 'fam-seller', status: 'available', description: null, condition: null, photo_url: null, rent_period: null, created_at: '2026-10-01T00:00:00Z', ...row };
  if (schema === 'after') {
    // The view carries no member_id or location, and names the family.
    const { member_id: _member, location: _location, ...shopper } = base as Row;
    db.seed(VIEW, [{ family_name: 'The Riveras', ...shopper }]);
  } else {
    db.seed('marketplace_listings', [base]);
  }
}

const auction = (over: Row): Row => ({
  title: 'Kids bike', kind: 'sell', category: 'sports', price_cents: 0,
  sale_format: 'auction', starting_bid_cents: 1_000, current_bid_cents: 0, bid_count: 0,
  has_reserve: false, reserve_met: true, buy_now_cents: 15_000, highest_bidder_family_id: null,
  auction_starts_at: '2026-01-01T00:00:00Z', auction_ends_at: '2099-01-01T00:00:00Z', ...over,
});
const sale = (over: Row): Row => ({
  title: 'Oak desk', kind: 'sell', category: 'furniture', price_cents: 12_000,
  sale_format: 'fixed', starting_bid_cents: 0, current_bid_cents: 0, bid_count: 0,
  has_reserve: false, reserve_met: true, buy_now_cents: null, highest_bidder_family_id: null,
  auction_starts_at: null, auction_ends_at: null, ...over,
});

async function page(id: string): Promise<ReactElement> {
  return (await ListingDetailPage({ params: Promise.resolve({ id }) })) as ReactElement;
}
/** The page as the viewer reads it — and a "not found" is not that page. */
async function visit(id: string): Promise<string> {
  const element = await page(id);
  expect(isValidElement(element) && element.type === AppNotFound, `${id} answered "not found"`).toBe(false);
  return renderTranslated(element).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

const INTERESTED = "I'm interested";
const BID_HINT = t('auction.enterYourMaxWeBidThe');
const REPORT = t('reportButton.report');
const MAKE_OFFER = t('negotiation.makeAnOffer');
const ASK = t('listingQuestions.askTheSellerAQuestionIs');

beforeEach(() => {
  harness.role = 'parent';
  harness.memberId = 'm-buyer';
  harness.familyId = 'fam-buyer';
  resetMarketplaceSchemaWarnings();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe("another family's listing page (N1)", () => {
  it.each<Schema>(['after', 'before'])("%s 0483: another family's live auction opens with its bid box, Save and Report", async (schema) => {
    const db = database(schema);
    seedTheirs(db, schema, auction({ id: 'theirs', member_id: 'm-seller', location: '12 Elm St, side gate' }));

    const html = await visit('theirs');

    expect(html).toContain('Kids bike');
    expect(html).toContain(BID_HINT);
    expect(html).toContain(t('auctionPanel.buyItNowForAmount', { amount: '$150' }));
    expect(html).toContain(REPORT);
    expect(html).toContain(t('uiText.saveThisListing'));
    // An auction takes bids; and interest is the in-family flow (0462).
    expect(html).not.toContain(INTERESTED);
    // One family's pickup spot is not shown to another, on either schema.
    expect(html).not.toContain('12 Elm St');
    expect(html).not.toContain(t('marketplaceItem.thisIsYourListing'));
  });

  it.each<Schema>(['after', 'before'])("%s 0483: another family's sale opens with Make an Offer, not this family's interest button", async (schema) => {
    const db = database(schema);
    seedTheirs(db, schema, sale({ id: 'desk', member_id: 'm-seller' }));

    const html = await visit('desk');

    expect(html).toContain('Oak desk');
    expect(html).toContain(MAKE_OFFER);
    expect(html).toContain(ASK);
    expect(html).not.toContain(INTERESTED);
    // No trust score computed from rows this family does not hold.
    expect(html).not.toContain(t('marketplaceItem.noReviewsYet'));
    if (schema === 'after') expect(html).toContain('The Riveras');
  });

  it('a listing no family of the viewer can see is still not found', async () => {
    database('after');
    const element = await page('nowhere');
    expect(isValidElement(element) && element.type === AppNotFound).toBe(true);
  });

  it("the viewer's own family's listing still reads as its own, with its pickup spot", async () => {
    const db = database('after');
    db.seed('marketplace_listings', [{ ...sale({ id: 'mine', member_id: 'm-buyer', location: 'Garage shelf' }), family_id: 'fam-buyer', status: 'available', created_at: '2026-10-01T00:00:00Z' }]);
    const html = await visit('mine');
    expect(html).toContain(t('marketplaceItem.thisIsYourListing'));
    expect(html).toContain('Garage shelf');
    expect(html).not.toContain(REPORT);
  });

  it.each<Schema>(['after', 'before'])("%s 0483: a report on another family's shared listing is filed", async (schema) => {
    const db = database(schema);
    seedTheirs(db, schema, sale({ id: 'desk', member_id: 'm-seller' }));

    expect(await reportListingAction({ listingId: 'desk', reason: 'scam' })).toEqual({ ok: true });

    expect(db.table('marketplace_reports')).toMatchObject([{ family_id: 'fam-buyer', listing_id: 'desk', reporter_member: 'm-buyer', reason: 'scam' }]);
  });
});

describe('an auction on the listing page takes bids, not interest (N8)', () => {
  it("a sibling viewing their own family's live auction is not offered I'm interested", async () => {
    const db = database('after');
    db.seed('marketplace_listings', [{ ...auction({ id: 'ours', member_id: 'm-sibling' }), family_id: 'fam-buyer', status: 'available', created_at: '2026-10-01T00:00:00Z' }]);

    const html = await visit('ours');

    expect(html).toContain(BID_HINT);
    expect(html).not.toContain(INTERESTED);
  });

  it("the same family's fixed-price sale still offers it", async () => {
    const db = database('after');
    db.seed('marketplace_listings', [{ ...sale({ id: 'ours', member_id: 'm-sibling' }), family_id: 'fam-buyer', status: 'available', created_at: '2026-10-01T00:00:00Z' }]);
    expect(await visit('ours')).toContain(INTERESTED);
  });
});

describe('a guest views a listing (N12)', () => {
  it('is offered no interest, report or question', async () => {
    harness.role = 'guest';
    const db = database('after');
    db.seed('marketplace_listings', [{ ...sale({ id: 'ours', member_id: 'm-sibling' }), family_id: 'fam-buyer', status: 'available', created_at: '2026-10-01T00:00:00Z' }]);

    const html = await visit('ours');

    expect(html).toContain('Oak desk');
    expect(html).not.toContain(INTERESTED);
    expect(html).not.toContain(REPORT);
    expect(html).not.toContain(ASK);
  });

  it('cannot file a report by calling the action', async () => {
    harness.role = 'guest';
    const db = database('after');
    seedTheirs(db, 'after', sale({ id: 'desk', member_id: 'm-seller' }));
    expect(await reportListingAction({ listingId: 'desk', reason: 'scam' })).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(db.table('marketplace_reports')).toEqual([]);
  });
});

describe("the seller's rating on the listing page is over every review (N17)", () => {
  it('counts all 1,500 when the server caps a response at 1,000', async () => {
    const db = database('after', { maxRows: 1000 });
    db.seed('marketplace_listings', [{ ...sale({ id: 'ours', member_id: 'm-sibling' }), family_id: 'fam-buyer', status: 'available', created_at: '2026-10-01T00:00:00Z' }]);
    db.seed('marketplace_reviews', Array.from({ length: 1_500 }, (_, i) => ({
      id: `rev-${String(i).padStart(5, '0')}`, family_id: 'fam-buyer', reviewee_member: 'm-sibling', rating: i < 1_000 ? 5 : 1,
    })));

    const html = await visit('ours');

    // 1,000 fives and 500 ones: 3.7 over all of them; the capped read said 5.0 (1000).
    expect(html).toContain('3.7 (1500)');
    expect(html).not.toContain('(1000)');
  });
});

describe("the offers inbox keeps the buyer's threads on another family's listings (N14)", () => {
  const seedThread = (db: InMemorySupabase) => db.seed('marketplace_negotiations', [{
    id: 'neg-1', listing_id: 'desk', family_id: 'fam-seller', buyer_member_id: 'm-buyer', buyer_family_id: 'fam-buyer',
    status: 'open', current_amount_cents: 9_000, last_actor: 'seller', agreed_amount_cents: null, updated_at: '2026-10-20T10:00:00Z',
  }]);

  it("after 0483: the buyer sees the thread, and that the seller's counter waits on them", async () => {
    const db = database('after');
    seedTheirs(db, 'after', sale({ id: 'desk', member_id: 'm-seller' }));
    seedThread(db);

    const html = renderTranslated(await NegotiationsInboxPage()).replace(/&#x27;/g, "'");

    expect(html).toContain('Oak desk');
    expect(html).toContain(t('marketplaceNegotiations.yourMove'));
    expect(html).not.toContain(t('marketplaceNegotiations.noOffersGoingYet'));
  });

  it('a thread whose listing neither the table nor the view returns is still left out', async () => {
    const db = database('after');
    seedThread(db);
    const html = renderTranslated(await NegotiationsInboxPage());
    expect(html).toContain(t('marketplaceNegotiations.noOffersGoingYet'));
  });
});
