// Admin reach N12 and N16 — the legacy Landing Pages console and /lp/<slug>.
//
// N12: syncLegacyLandingToPlatform upserts marketing_pages on `path`, and a
// legacy slug is unique only in its own table. Creating a draft legacy page
// (or renaming one) onto the slug of a live platform landing page replaced
// that page's title, body, SEO and AEO with the draft and set it to draft:
// /lp/<slug> 404'd and its generated answers were retired, with no warning.
//
// N16: the console normalized a slug with its own regex, which kept repeated
// hyphens, stripped only one leading or trailing hyphen and had no length cap,
// while the public route looks a page up by normalizeSlug. "Summer - Sale"
// was stored as summer---sale, published, listed in the sitemap at
// /lp/summer---sale and shown as Live — and every visit 404'd.
//
// Driven through the REAL actions, bridge and public route against the
// in-memory database. Negative controls: before the fix the platform page was
// overwritten and unpublished, and the published page's own URL was not found.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';
import { normalizeSlug } from '@/lib/marketing/landing';

const h = vi.hoisted(() => ({
  db: null as unknown,
  gate: vi.fn(),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: h.notFound, redirect: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: h.gate,
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));
vi.mock('@/lib/marketing/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/marketing/platform')>(),
  retireAeoQuestionsForPath: vi.fn(async () => ({ error: null })),
}));

const { createLandingPage, updateLandingPage, setLandingPublished } = await import('@/app/(app)/admin/marketing/actions');
const { getPublishedMarketingPage } = await import('@/lib/marketing/public-pages');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

let db: InMemorySupabase;
const platformPage: Row = {
  id: 'platform-spring', page_type: 'landing', slug: 'spring', path: '/lp/spring', title: 'Spring offer',
  summary: 'The live campaign', body: 'Live body', content: {}, seo: { title: 'Spring offer' }, aeo: { questions: [] },
  status: 'published', published_at: '2026-10-01T00:00:00.000Z', deleted_at: null,
};
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
async function digestOf(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string });
  return error?.digest ?? null;
}
/** What a visitor to /lp/<slug> gets: the page, or not found. */
async function visit(slug: string): Promise<'page' | 'not found'> {
  try {
    await LandingRoute({ params: Promise.resolve({ slug }) });
    return 'page';
  } catch (error) {
    if ((error as Error).message === 'NEXT_NOT_FOUND') return 'not found';
    throw error;
  }
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { marketing_pages: [['path']], marketing_landing_pages: [['slug']] },
    defaults: { marketing_pages: { deleted_at: null }, marketing_landing_pages: { deleted_at: null, published: false } },
  });
  h.db = db;
  db.seed('marketing_pages', [structuredClone(platformPage)]);
  db.seed('marketing_landing_pages', []);
  h.gate.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a legacy landing page takes only a free /lp path', () => {
  it('creating one on a live platform page’s slug is refused and the live page stays up', async () => {
    const live = structuredClone(db.table('marketing_pages'));
    expect(await digestOf(createLandingPage(form({ title: 'Spring draft', slug: 'spring', body: 'Draft body' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(db.table('marketing_pages')).toEqual(live);
    expect(db.table('marketing_landing_pages')).toEqual([]);
    expect(await getPublishedMarketingPage('landing', 'spring')).toMatchObject({ id: 'platform-spring', title: 'Spring offer' });
    expect(await visit('spring')).toBe('page');
  });

  it('renaming one onto that slug is refused before the legacy row changes', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn' }));
    const legacy = db.table('marketing_landing_pages')[0];
    const live = structuredClone(db.table('marketing_pages').find((row) => row.path === '/lp/spring'));
    expect(await digestOf(updateLandingPage(form({ id: String(legacy.id), title: 'Autumn', slug: 'spring' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(db.table('marketing_landing_pages')[0]).toMatchObject({ slug: 'autumn' });
    expect(db.table('marketing_pages').find((row) => row.path === '/lp/spring')).toEqual(live);
  });

  it('the control: a free slug, its own mirror and a retired legacy alias are all usable', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn' }));
    const legacy = db.table('marketing_landing_pages')[0];
    expect(db.table('marketing_pages').find((row) => row.path === '/lp/autumn')).toMatchObject({ status: 'draft', content: { source_id: legacy.id } });
    // Its own mirror: an ordinary edit at the same slug.
    await updateLandingPage(form({ id: String(legacy.id), title: 'Autumn sale', slug: 'autumn' }));
    // An archived alias another legacy page left behind.
    db.seed('marketing_pages', [{ ...platformPage, id: 'old-alias', slug: 'winter', path: '/lp/winter', status: 'archived',
      deleted_at: '2026-09-01T00:00:00.000Z', content: { source: 'marketing_landing_pages', source_id: 'another-legacy-page' } }]);
    await createLandingPage(form({ title: 'Winter', slug: 'winter' }));
    expect(db.table('marketing_landing_pages').map((row) => row.slug)).toEqual(['autumn', 'winter']);
  });
});

describe('a published landing page is reachable at the slug the console stored', () => {
  it.each([
    ['Summer - Sale', 'summer-sale'],
    ['--promo', 'promo'],
    ['Big  --  Day!!', 'big-day'],
    [`${'a'.repeat(119)}-${'b'.repeat(10)}`, 'a'.repeat(119)],
  ])('%j is stored as %j and its own URL serves it', async (typed, stored) => {
    db.replace('marketing_pages', []);
    await createLandingPage(form({ title: 'Seasonal', slug: typed, headline: 'Seasonal offer' }));
    const legacy = db.table('marketing_landing_pages')[0];
    expect(legacy.slug).toBe(stored);
    await setLandingPublished(form({ id: String(legacy.id), publish: '1' }));
    expect(db.table('marketing_pages')[0]).toMatchObject({ path: `/lp/${stored}`, status: 'published' });
    expect(await visit(String(legacy.slug))).toBe('page');
  });

  it('normalizeSlug is idempotent, so the stored form looks itself up', () => {
    for (const typed of ['Summer - Sale', '--promo', `${'a'.repeat(119)}-${'b'.repeat(10)}`, 'x'.repeat(300)]) {
      expect(normalizeSlug(normalizeSlug(typed))).toBe(normalizeSlug(typed));
    }
  });
});
