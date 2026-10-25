// Admin reach N12-R1 — the legacy Landing Pages console's Publish, Unpublish
// and Archive buttons, once another page holds the legacy page's /lp path.
//
// Round 1 (assertLegacyLandingPathFree) guarded create and rename. The other
// two writers still addressed marketing_pages by path alone: setLandingPublished
// re-synced the mirror with an upsert on `path`, and archiveLandingPage archived
// `.eq('path', '/lp/<slug>')`. Neither looked at whose row was there, and the
// platform console hands the path to someone else in three steps: it lists the
// legacy mirror like any page, its edit form renames the mirror off
// /lp/<slug>, and its create form then puts a new platform page at the path
// that freed. After that, Unpublish on the legacy page replaced the platform
// page with the legacy one's copy and set it to draft (/lp/<slug> then 404'd),
// Archive archived it and retired its published answers, and Publish put the
// legacy page live in its place.
//
// Driven through the REAL legacy and platform actions, the bridge, the public
// /lp route and the public AEO reader, against one in-memory database. Negative
// controls: before the fix, each of the three changed or hid the platform page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';

const h = vi.hoisted(() => ({
  db: null as unknown,
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
// lib/marketing/aeo.ts builds its own anon client, the one a visitor's render uses.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.db }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: h.notFound, redirect: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: async () => ({ supabase: h.db, actorId: 'admin-1', actorEmail: 'admin@example.test' }),
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));

const { createLandingPage, setLandingPublished, archiveLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { createPlatformPage, updatePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { getPublishedMarketingPage } = await import('@/lib/marketing/public-pages');
const { readPublishedAeoQuestions } = await import('@/lib/marketing/aeo');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

let db: InMemorySupabase;

function form(fields: Record<string, unknown>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, String(value));
  return fd;
}
async function digestOf(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string });
  return error?.digest ?? null;
}
/** What a visitor to /lp/<slug> gets: the legacy page, the platform page, or not found. */
async function visit(slug: string): Promise<'legacy page' | 'platform page' | 'not found'> {
  try {
    const element = await LandingRoute({ params: Promise.resolve({ slug }) }) as { props?: { type?: string } };
    return element?.props?.type === 'landing' ? 'platform page' : 'legacy page';
  } catch (error) {
    if ((error as Error).message === 'NEXT_NOT_FOUND') return 'not found';
    throw error;
  }
}
async function publicAnswers(): Promise<string[]> {
  const read = await readPublishedAeoQuestions(60);
  expect(read.available).toBe(true);
  return read.questions.map((q) => q.answer);
}
const pageAt = (path: string) => db.table('marketing_pages').find((row) => row.path === path);
const legacyRow = () => db.table('marketing_landing_pages')[0];

/**
 * The state the console reaches with ordinary clicks: a legacy page at
 * /lp/spring, its mirror renamed off that path in the platform console, and a
 * published platform page (with a published answer) created at the freed path.
 */
async function aPlatformPageTakesTheLegacyPath(legacyPublished: boolean): Promise<{ legacy: Row; platform: Row }> {
  await createLandingPage(form({ title: 'Spring', slug: 'spring', headline: 'Legacy spring', body: 'Legacy body' }));
  const legacy = legacyRow();
  if (legacyPublished) await setLandingPublished(form({ id: legacy.id, publish: '1' }));
  const mirror = pageAt('/lp/spring')!;
  await updatePlatformPage(form({
    id: mirror.id, page_type: 'landing', title: 'Legacy spring', slug: 'spring-legacy',
    status: legacyPublished ? 'published' : 'draft',
  }));
  expect(pageAt('/lp/spring')).toBeUndefined();
  await createPlatformPage(form({ page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign', body: 'Live body' }));
  const created = pageAt('/lp/spring')!;
  await updatePlatformPage(form({
    id: created.id, page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign', body: 'Live body', status: 'published',
  }));
  db.seed('marketing_aeo_questions', [{
    question: 'What is in the spring offer?', answer: 'Three months of Bubaly Plus for the price of one.',
    source_path: '/lp/spring', pattern: 'faq', status: 'published', clarity_score: 90,
    metadata: { source: 'marketing_platform', page_id: created.id },
  }]);
  expect(await getPublishedMarketingPage('landing', 'spring')).toMatchObject({ id: created.id, title: 'Spring offer' });
  return { legacy: structuredClone(legacy), platform: structuredClone(pageAt('/lp/spring')!) };
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { marketing_pages: [['path']], marketing_landing_pages: [['slug']] },
    defaults: { marketing_pages: { deleted_at: null }, marketing_landing_pages: { deleted_at: null, published: false } },
  });
  h.db = db;
  db.seed('marketing_pages', []);
  db.seed('marketing_landing_pages', []);
  db.seed('marketing_aeo_questions', []);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the legacy landing buttons leave a platform page at their path alone', () => {
  it('Unpublish takes the legacy page down and the platform page there stays as it was, and live', async () => {
    const { legacy, platform } = await aPlatformPageTakesTheLegacyPath(true);
    expect(await visit('spring')).toBe('legacy page');

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));

    expect(legacyRow()).toMatchObject({ id: legacy.id, published: false, status: 'draft' });
    expect(pageAt('/lp/spring')).toEqual(platform);
    expect(await getPublishedMarketingPage('landing', 'spring')).toMatchObject({ id: platform.id, title: 'Spring offer' });
    expect(await visit('spring')).toBe('platform page');
    expect(await publicAnswers()).toContain('Three months of Bubaly Plus for the price of one.');
  });

  it('Archive archives the legacy page and the platform page there keeps its row and its answers', async () => {
    const { legacy, platform } = await aPlatformPageTakesTheLegacyPath(true);

    await archiveLandingPage(form({ id: legacy.id }));

    expect(legacyRow()).toMatchObject({ id: legacy.id, published: false, status: 'archived' });
    expect(legacyRow().deleted_at).not.toBeNull();
    expect(pageAt('/lp/spring')).toEqual(platform);
    expect(await visit('spring')).toBe('platform page');
    expect(await publicAnswers()).toContain('Three months of Bubaly Plus for the price of one.');
  });

  it('Publish onto that path is refused before the legacy page changes', async () => {
    const { legacy, platform } = await aPlatformPageTakesTheLegacyPath(false);

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(legacyRow()).toEqual(legacy);
    expect(pageAt('/lp/spring')).toEqual(platform);
    expect(await visit('spring')).toBe('platform page');
  });
});

describe('the control: on its own mirror, or a free path, each button still does what it says', () => {
  it('Publish, Unpublish, Publish and Archive move its own mirror and retire its own answers', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    const mirrorId = pageAt('/lp/autumn')!.id;
    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'draft', content: { source: 'marketing_landing_pages', source_id: legacy.id } });

    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirrorId, status: 'published', title: 'Autumn sale' });
    expect(await visit('autumn')).toBe('legacy page');

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirrorId, status: 'draft' });
    expect(await visit('autumn')).toBe('not found');

    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    db.seed('marketing_aeo_questions', [{
      question: 'When does the autumn sale end?', answer: 'At the end of October.', source_path: '/lp/autumn',
      pattern: 'faq', status: 'published', clarity_score: 88, metadata: { source: 'marketing_platform', page_id: mirrorId },
    }]);
    expect(await publicAnswers()).toContain('At the end of October.');

    await archiveLandingPage(form({ id: legacy.id }));
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirrorId, status: 'archived' });
    expect(pageAt('/lp/autumn')!.deleted_at).not.toBeNull();
    expect(await visit('autumn')).toBe('not found');
    expect(await publicAnswers()).not.toContain('At the end of October.');
  });

  it('Publish on a path with no registry row writes the mirror there', async () => {
    await createLandingPage(form({ title: 'Winter', slug: 'winter', headline: 'Winter sale' }));
    const legacy = legacyRow();
    db.replace('marketing_pages', []);

    await setLandingPublished(form({ id: legacy.id, publish: '1' }));

    expect(pageAt('/lp/winter')).toMatchObject({ status: 'published', content: { source: 'marketing_landing_pages', source_id: legacy.id } });
    expect(await visit('winter')).toBe('legacy page');
  });

  it('with the platform registry not migrated, Publish and Unpublish still move the legacy page', async () => {
    await createLandingPage(form({ title: 'Winter', slug: 'winter', headline: 'Winter sale' }));
    const legacy = legacyRow();
    const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.marketing_pages' in the schema cache" } };
    const absent: object = new Proxy({}, {
      get: (_target, property) => property === 'then'
        ? (resolve: (value: unknown) => unknown) => resolve(missing)
        : () => (property === 'single' || property === 'maybeSingle' ? Promise.resolve(missing) : absent),
    });
    h.db = { from: (table: string) => (table === 'marketing_pages' ? absent : db.from(table)) };

    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    expect(legacyRow()).toMatchObject({ published: true, status: 'published' });
    await setLandingPublished(form({ id: legacy.id, publish: '0' }));
    expect(legacyRow()).toMatchObject({ published: false, status: 'draft' });
  });

  it('Publish over a legacy page’s retired alias at the path is allowed, as on create', async () => {
    await createLandingPage(form({ title: 'Summer', slug: 'summer', headline: 'Summer sale' }));
    const legacy = legacyRow();
    Object.assign(pageAt('/lp/summer')!, {
      status: 'archived', deleted_at: '2026-09-01T00:00:00.000Z',
      content: { source: 'marketing_landing_pages', source_id: 'another-legacy-page' },
    });

    await setLandingPublished(form({ id: legacy.id, publish: '1' }));

    expect(pageAt('/lp/summer')).toMatchObject({ status: 'published', deleted_at: null, content: { source_id: legacy.id } });
    expect(await visit('summer')).toBe('legacy page');
  });
});
