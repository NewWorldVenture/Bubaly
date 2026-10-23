import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * The Orders page and the offers inbox keep the member's own exchanges,
 * however many newer ones the rest of the family has (MT-7).
 *
 * /marketplace/orders read the family's 100 newest orders (either side) and
 * only then kept the viewer's; /marketplace/negotiations read the 100 most
 * recently updated threads RLS shows (family-wide, on both sides) and only
 * then kept the viewer's. A member's older live exchange (a long borrow, an
 * open thread with a counter waiting on them) fell out of their inbox, with
 * its controls, once the family had 100 newer ones. Both reads now ask for
 * the member's own rows and cap those.
 */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-self', family_id: 'fam-1' }, family: { timezone: 'UTC' } },
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

const { default: OrdersPage } = await import('@/app/(app)/marketplace/orders/page');
const { default: NegotiationsInboxPage } = await import('@/app/(app)/marketplace/negotiations/page');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const pad = (i: number) => String(i).padStart(4, '0');
const at = (i: number) => new Date(Date.UTC(2026, 5, 1) + i * 60_000).toISOString();
let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('family_members', [
    { id: 'm-self', family_id: 'fam-1', display_name: 'Sam' },
    { id: 'm-sib', family_id: 'fam-1', display_name: 'Bea' },
    { id: 'm-kid', family_id: 'fam-1', display_name: 'Kit' },
  ]);
});

describe('/marketplace/orders', () => {
  it('shows the member\'s older live borrow behind 120 newer family orders', async () => {
    db.seed('marketplace_listings', [
      { id: 'l-ladder', family_id: 'fam-1', member_id: 'm-self', title: 'Long ladder', rent_period: null },
      { id: 'l-toy', family_id: 'fam-1', member_id: 'm-sib', title: 'Toy car', rent_period: null },
    ]);
    db.seed('marketplace_orders', [
      { id: 'o-self', family_id: 'fam-1', buyer_family_id: 'fam-1', listing_id: 'l-ladder', buyer_member: 'm-sib', seller_member: 'm-self',
        kind: 'borrow', status: 'active', amount_cents: 0, ends_on: '2026-12-01', returned_at: null, created_at: at(0) },
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `o-${pad(i)}`, family_id: 'fam-1', buyer_family_id: 'fam-1', listing_id: 'l-toy', buyer_member: 'm-kid', seller_member: 'm-sib',
        kind: 'buy', status: 'completed', amount_cents: 500, ends_on: null, returned_at: null, created_at: at(10 + i),
      })),
    ]);

    const html = renderTranslated(await OrdersPage());

    expect(html).toContain('Long ladder');
    // Nobody else's orders are on this member's page.
    expect(html).not.toContain('Toy car');
  });
});

describe('/marketplace/negotiations', () => {
  it('keeps the member\'s older open threads, on either side, behind 120 newer ones', async () => {
    db.seed('marketplace_listings', [
      { id: 'l-mine', family_id: 'fam-1', member_id: 'm-self', title: 'My stroller', price_cents: 12_000 },
      { id: 'l-sib', family_id: 'fam-1', member_id: 'm-sib', title: 'Bea\'s lamp', price_cents: 3_000 },
    ]);
    // Another family's listing, which this member is buying, is in the circle view.
    db.seed('marketplace_circle_listings', [{ id: 'l-theirs', family_id: 'fam-2', family_name: 'The Riveras', title: 'Their canoe', price_cents: 40_000 }]);
    db.seed('marketplace_negotiations', [
      // The member's own two, the oldest of all.
      { id: 'n-buy', listing_id: 'l-theirs', family_id: 'fam-2', buyer_member_id: 'm-self', buyer_family_id: 'fam-1',
        status: 'open', current_amount_cents: 35_000, last_actor: 'seller', agreed_amount_cents: null, updated_at: at(0) },
      { id: 'n-sell', listing_id: 'l-mine', family_id: 'fam-1', buyer_member_id: 'm-out', buyer_family_id: 'fam-3',
        status: 'open', current_amount_cents: 10_000, last_actor: 'buyer', agreed_amount_cents: null, updated_at: at(1) },
      // 120 newer threads on the sibling's listing.
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `n-${pad(i)}`, listing_id: 'l-sib', family_id: 'fam-1', buyer_member_id: `m-out-${i}`, buyer_family_id: 'fam-3',
        status: 'open', current_amount_cents: 2_000, last_actor: 'buyer', agreed_amount_cents: null, updated_at: at(10 + i),
      })),
    ]);

    const html = renderTranslated(await NegotiationsInboxPage()).replace(/&#x27;/g, "'");

    expect(html).toContain('Their canoe');
    expect(html).toContain('My stroller');
    expect(html).not.toContain('Bea\'s lamp');
    expect(html).not.toContain(t('marketplaceNegotiations.noOffersGoingYet'));
  });
});
