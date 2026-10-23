import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * A member's reputation is over every review and every completed exchange,
 * wherever it is shown (N17's siblings, and the storefront and reviews page
 * tails MT-5 / MT-6).
 *
 * N17 paged the ratings on /marketplace/creators and /marketplace/store. Three
 * more figures were still a sample:
 *
 *  - the rail's Trust Score (readTrustScoreInputsAction, on every marketplace
 *    page) read the member's ratings unbounded, which db-max-rows stops at
 *    1,000, and counted completed exchanges by reading the FAMILY's whole
 *    order list, the first 1,000 of it, and filtering to the member;
 *  - a storefront (/marketplace/creators/[id]) averaged and counted the
 *    seller's 12 newest reviews, so "N reviews" stopped at 12, the trust score
 *    was over those 12, and "open listings" was the 24 it showed;
 *  - /marketplace/reviews built "Your rating" from the family's 200 newest
 *    reviews filtered to the member, so a member's older reviews fell out of
 *    the average, the count and both lists.
 *
 * And the marketplace home page (N17-home-creators): its Top creators card and
 * its listings' rating chips were built from the family's 500 newest reviews,
 * so a seller with older reviews read one rating there and another on
 * /marketplace/creators.
 */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
// The home page's one-sentence composer needs the app shell's provider; it plays no part in a rating.
vi.mock('@/components/marketplace/quick-post', () => ({ QuickPost: () => null }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-self', family_id: 'fam-1' } },
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

const { readTrustScoreInputsAction } = await import('@/app/(app)/marketplace/actions');
const { default: ReviewsPage } = await import('@/app/(app)/marketplace/reviews/page');
const { default: StorefrontPage } = await import('@/app/(app)/marketplace/creators/[id]/page');
const { default: MarketplaceHomePage } = await import('@/app/(app)/marketplace/page');
const { computeTrustScore } = await import('@/lib/marketplace/trust');

const STORE = '00000000-0000-4000-8000-00000000a001';
const pad = (i: number) => String(i).padStart(5, '0');
const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
let db: InMemorySupabase;

beforeEach(() => {
  // The server's own ceiling on one response, as a default Supabase project sets it.
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('family_members', [
    { id: 'm-self', family_id: 'fam-1', display_name: 'Sam' },
    { id: 'm-sib', family_id: 'fam-1', display_name: 'Bea' },
  ]);
});

describe('the rail\'s Trust Score inputs', () => {
  it('are every rating the member received and every exchange they completed, past 1,000', async () => {
    // 1,200 ratings for the member: 900 fives, then 300 ones.
    db.seed('marketplace_reviews', Array.from({ length: 1_200 }, (_, i) => ({
      id: `rev-${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-self', reviewer_member: 'm-sib', rating: i < 900 ? 5 : 1,
    })));
    // 1,100 completed orders of the sibling's come first, then the member's 40.
    db.seed('marketplace_orders', [
      ...Array.from({ length: 1_100 }, (_, i) => ({
        id: `ord-${pad(i)}`, family_id: 'fam-1', buyer_family_id: 'fam-1', buyer_member: 'm-x', seller_member: 'm-sib', status: 'completed',
      })),
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `ord-self-${pad(i)}`, family_id: 'fam-1', buyer_family_id: 'fam-1',
        buyer_member: i % 2 ? 'm-self' : 'm-x', seller_member: i % 2 ? 'm-sib' : 'm-self', status: i < 30 ? 'completed' : 'active',
      })),
    ]);

    const inputs = await readTrustScoreInputsAction();
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    expect(inputs.ratingsReceived).toHaveLength(1_200);
    expect(inputs.ratingsReceived.filter((r) => r === 1)).toHaveLength(300);
    // 30 completed on either side; the 10 active ones are not completed.
    expect(inputs.ordersCompleted).toBe(30);
  });
});

describe('/marketplace/reviews', () => {
  it('rates the member over every review they received, however many newer ones the family has', async () => {
    db.seed('marketplace_reviews', [
      // The member's three, the oldest in the family: 5, 4 and 1.
      { id: 'rev-a', family_id: 'fam-1', reviewee_member: 'm-self', reviewer_member: 'm-sib', role: 'seller', rating: 5, comment: 'Great swap', created_at: day(0), listing_id: null },
      { id: 'rev-b', family_id: 'fam-1', reviewee_member: 'm-self', reviewer_member: 'm-sib', role: 'buyer', rating: 4, comment: null, created_at: day(1), listing_id: null },
      { id: 'rev-c', family_id: 'fam-1', reviewee_member: 'm-self', reviewer_member: 'm-sib', role: 'seller', rating: 1, comment: null, created_at: day(2), listing_id: null },
      // And one the member gave.
      { id: 'rev-d', family_id: 'fam-1', reviewee_member: 'm-sib', reviewer_member: 'm-self', role: 'buyer', rating: 3, comment: 'Late but fine', created_at: day(3), listing_id: null },
      // 250 newer reviews between two other members.
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `rev-z${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-sib', reviewer_member: 'm-x', role: 'seller', rating: 2, comment: null, created_at: day(10 + i), listing_id: null,
      })),
    ]);

    const html = renderTranslated(await ReviewsPage());
    expect(html).toContain('★ 3.3');
    expect(html).toContain('from 3 reviews');
    expect(html).toContain('Great swap');
    expect(html).toContain('Late but fine');
  });
});

describe('a storefront', () => {
  beforeEach(() => {
    db.seed('marketplace_stores', [{ id: STORE, family_id: 'fam-1', member_id: 'm-sib', name: 'Bea Makes', tagline: null, description: null, emoji: null, is_active: true }]);
  });

  it('counts and averages every review the seller received, not the 12 newest', async () => {
    // 20 reviews: the 8 oldest are ones, the 12 newest fives.
    db.seed('marketplace_reviews', Array.from({ length: 20 }, (_, i) => ({
      id: `rev-${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-sib', reviewer_member: 'm-self', rating: i < 8 ? 1 : 5, comment: null, created_at: day(i),
    })));
    const ratings = Array.from({ length: 20 }, (_, i) => (i < 8 ? 1 : 5));
    const trust = computeTrustScore({ ratingsReceived: ratings, ordersCompleted: 0, listingsPosted: 0 });

    const html = renderTranslated(await StorefrontPage({ params: Promise.resolve({ id: STORE }) }));
    expect(html).toContain('20 reviews');
    expect(html).toContain('3.4');
    expect(html).not.toContain('12 reviews');
    expect(html).toContain(`>${trust.score}<`);
  });

  it('counts every open listing, not the 24 it shows', async () => {
    db.seed('marketplace_listings', Array.from({ length: 30 }, (_, i) => ({
      id: `lst-${pad(i)}`, family_id: 'fam-1', member_id: 'm-sib', title: `Thing ${i}`, kind: 'sell', category: 'other',
      price_cents: 100, rent_period: null, photo_url: null, location: null, status: i < 27 ? 'available' : 'completed', created_at: day(i),
    })));
    const html = renderTranslated(await StorefrontPage({ params: Promise.resolve({ id: STORE }) }));
    // 27 open; the grid still shows 24 of them.
    expect(html).toMatch(/>27<[^]*?open listings/i);
    expect((html.match(/href="\/marketplace\/item\/lst-/g) ?? []).length).toBe(24);
  });
});

describe('the marketplace home page', () => {
  it('rates its top creators and its listings over every review, not the family\'s 500 newest', async () => {
    db.seed('marketplace_stores', [{ id: STORE, family_id: 'fam-1', member_id: 'm-sib', name: 'Bea Makes', tagline: null, description: null, emoji: null, is_active: true }]);
    db.seed('marketplace_listings', [{
      id: 'lst-lamp', family_id: 'fam-1', member_id: 'm-sib', title: 'Brass lamp', kind: 'sell', category: 'other',
      price_cents: 1_500, rent_period: null, location: null, condition: null, status: 'available', created_at: day(0),
    }]);
    db.seed('marketplace_reviews', [
      // Bea's 30 oldest reviews, all ones, on the lamp.
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `rev-a${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-sib', reviewer_member: 'm-self', listing_id: 'lst-lamp', rating: 1, created_at: day(i),
      })),
      // 1,100 newer reviews between two other members.
      ...Array.from({ length: 1_100 }, (_, i) => ({
        id: `rev-m${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-x', reviewer_member: 'm-self', listing_id: null, rating: 3, created_at: day(100 + i),
      })),
      // And Bea's 10 newest, all fives.
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `rev-z${pad(i)}`, family_id: 'fam-1', reviewee_member: 'm-sib', reviewer_member: 'm-self', listing_id: null, rating: 5, created_at: day(5_000 + i),
      })),
    ]);

    const html = renderTranslated(await MarketplaceHomePage());
    // Top creators: (30 × 1 + 10 × 5) / 40, as /marketplace/creators reads it.
    expect(html).toContain('Bea Makes');
    expect(html).toContain('★ 2.0 (40)');
    expect(html).not.toContain('★ 5.0 (10)');
    // The lamp's chip is over its 30 reviews, none of them among the 500 newest.
    expect(html).toContain('Brass lamp');
    expect(html).toContain('★ 1.0 (30)');
    // The activity feed still lists the newest reviews: Bea's fives.
    expect(html).toContain('Bea received a review');
    expect(html).not.toContain('Unavailable:');
  });
});
