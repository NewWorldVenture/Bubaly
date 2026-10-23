import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

/**
 * A creator's rating, review count and open-listing count are over every row
 * (N17).
 *
 * /marketplace/creators read the family's reviews and open listings with
 * `.limit(1000)` and averaged and counted what came back; /marketplace/store
 * read a seller's ratings with `.limit(500)`. PostgREST caps a response at
 * db-max-rows (1,000) whatever the client asks, and says nothing, so past that
 * the page published an average and a count of a sample. Each is now every
 * row, paged on id (lib/supabase/read-all.ts readAllByIdAsQuery). The listing
 * page's seller rating is held in another-familys-listing-is-shopped-from-its-page.
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

const { default: CreatorsPage } = await import('@/app/(app)/marketplace/creators/page');
const { default: StorePage } = await import('@/app/(app)/marketplace/store/page');

const pad = (i: number) => String(i).padStart(5, '0');
let db: InMemorySupabase;

beforeEach(() => {
  // The server's own ceiling on one response, as a default Supabase project sets it.
  db = createInMemorySupabase({ maxRows: 1000 });
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('marketplace_stores', [
    { id: 'store-1', family_id: 'fam-1', member_id: 'm-maker', name: 'Maker Goods', tagline: null, emoji: null, is_active: true },
    { id: 'store-self', family_id: 'fam-1', member_id: 'm-self', name: 'My Shop', tagline: null, description: null, emoji: null, is_active: true },
  ]);
  // Each member: 500 fives and 250 ones, 3.7 over all 750. The store owner's
  // rows come first, so a family-wide read capped at 1,000 holds only 250 of
  // the maker's.
  db.seed('marketplace_reviews', Array.from({ length: 1_500 }, (_, i) => ({
    id: `rev-${pad(i)}`, family_id: 'fam-1', reviewee_member: i % 2 === 0 ? 'm-maker' : 'm-self', rating: i < 1_000 ? 5 : 1,
  })).sort((a, b) => b.reviewee_member.localeCompare(a.reviewee_member)));
});

describe('the creators page', () => {
  it('averages and counts every review and every open listing', async () => {
    db.seed('marketplace_listings', Array.from({ length: 1_200 }, (_, i) => ({
      id: `lst-${pad(i)}`, family_id: 'fam-1', member_id: 'm-maker', status: 'available',
    })));
    const html = renderTranslated(await CreatorsPage());
    // m-maker has every even review: 500 fives and 250 ones.
    expect(html).toContain('★ 3.7 (750)');
    expect(html).toContain('1200 open listings');
    expect(html).not.toContain('1000 open listings');
  });
});

describe('the store page', () => {
  it('counts every rating the seller received, past 500', async () => {
    const html = renderTranslated(await StorePage());
    // m-self has every odd review: 500 fives and 250 ones.
    expect(html).toContain('★ 3.7');
    expect(html).toContain('750 reviews');
    expect(html).not.toContain('500 reviews');
  });
});
