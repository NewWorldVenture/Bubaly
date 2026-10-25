import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * A saved listing from another family is on the Saved page (N1, its tail).
 *
 * The listing page offers the heart on another family's shared listing, and
 * toggleSaveAction stores that save under the saver's family. The Saved page
 * then looked the listings up in marketplace_listings, which since 0483 answers
 * for the caller's own family only, and dropped every save whose listing did
 * not come back: the save was stored and never shown. It is the offers inbox's
 * cause (N14), and the same fix: what the table does not return is read from
 * the circle view. A collection holds listings the same way (0462 admits any
 * listing the family can see) and is read the same way.
 */
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => undefined, error: () => undefined }) }));
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

const { default: SavedPage } = await import('@/app/(app)/marketplace/saved/page');
const { default: CollectionsPage } = await import('@/app/(app)/marketplace/collections/page');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const VIEW = 'marketplace_circle_listings';
let db: InMemorySupabase;

const listing = (over: Row): Row => ({
  kind: 'sell', status: 'available', price_cents: 2_500, rent_period: null, photo_url: null, ...over,
});

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The table, after 0483: the caller's own family's listings only.
  db.seed('marketplace_listings', [listing({ id: 'l-own', family_id: 'fam-1', member_id: 'm-sib', title: 'Our wagon', location: 'Garage' })]);
  // Another family's shared listing is in the circle view, which has no member_id or location.
  db.seed(VIEW, [listing({ id: 'l-theirs', family_id: 'fam-2', family_name: 'The Riveras', title: 'Their kayak' })]);
});

describe('the Saved page', () => {
  it('shows a save on another family\'s listing, beside the family\'s own', async () => {
    db.seed('marketplace_saves', [
      { id: 's1', family_id: 'fam-1', member_id: 'm-self', listing_id: 'l-theirs', created_at: '2026-10-22T10:00:00Z' },
      { id: 's2', family_id: 'fam-1', member_id: 'm-self', listing_id: 'l-own', created_at: '2026-10-21T10:00:00Z' },
    ]);
    const html = renderTranslated(await SavedPage());
    expect(html).toContain('Their kayak');
    expect(html).toContain('href="/marketplace/item/l-theirs"');
    expect(html).toContain('Our wagon');
    expect(html).not.toContain(t('marketplaceSaved.nothingSavedYetTapTheOn'));
  });

  it('says it could not load the saves when the view read fails, rather than showing them as gone', async () => {
    db.seed('marketplace_saves', [{ id: 's1', family_id: 'fam-1', member_id: 'm-self', listing_id: 'l-theirs', created_at: '2026-10-22T10:00:00Z' }]);
    const realFrom = db.from.bind(db);
    (db as unknown as { from: (table: string) => object }).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== VIEW) return builder;
      return { select: () => ({ in: async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } }) }) };
    };
    const html = renderTranslated(await SavedPage());
    expect(html).toContain(t('marketplaceSaved.couldNotLoadYourSavedItems'));
    expect(html).not.toContain(t('marketplaceSaved.nothingSavedYetTapTheOn'));
  });
});

describe('a collection', () => {
  it('shows another family\'s listing it holds', async () => {
    db.seed('marketplace_collections', [{ id: 'c1', family_id: 'fam-1', name: 'Summer', emoji: null, description: null, created_at: '2026-10-01T00:00:00Z' }]);
    db.seed('marketplace_collection_items', [
      { id: 'ci-1', family_id: 'fam-1', collection_id: 'c1', listing_id: 'l-theirs' },
      { id: 'ci-2', family_id: 'fam-1', collection_id: 'c1', listing_id: 'l-own' },
    ]);
    const html = renderTranslated(await CollectionsPage({ searchParams: Promise.resolve({ id: 'c1' }) }));
    expect(html).toContain('Their kayak');
    expect(html).toContain('Our wagon');
    expect(html).not.toContain(t('marketplaceCollections.nothingInThisCollectionYet'));
  });
});
