// Admin reach N12-REGEN-CONSOLE-MOVE: a legacy mirror the platform console
// moves to another path.
//
// The console lists a legacy page's mirror like any page, and its edit form
// can give it another slug. Since 7ebf6fe94 the cron's regeneration keeps the
// mirror's `content.source` / `content.source_id`, so a moved mirror stayed
// marked as the legacy page's for good. The legacy page's next save then
// retired it as one of its aliases (retireLegacyLandingAliases archives every
// row carrying its marker off its current path): the page the console had
// moved and published 404'd. A moved blog mirror stayed a "legacy blog mirror"
// too, so a content item published at its new slug overwrote it.
//
// The rule: a page the console moves is the console's from then on. The move
// stamps it CONSOLE_PAGE_SOURCE in the same confirmed update, the regeneration
// keeps that stamp, and the legacy bridges never touch a row marked as another
// source. The legacy page's own path is free again for it.
//
// Driven through the REAL platform, legacy and content actions, the bridge,
// the job worker, and the public /lp route against one in-memory database. On
// 7ebf6fe94 the three cases outside the control block fail; the two controls
// pass there and here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';

const h = vi.hoisted(() => ({
  db: null as unknown,
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
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
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => false, resolveProvider: async () => { throw new Error('no provider'); } }));

const { createLandingPage, setLandingPublished, archiveLandingPage, updateLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { publishContentToBlogAction } = await import('@/app/(app)/admin/marketing/content/actions');
const { updatePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { processMarketingGenerationJobs } = await import('@/lib/marketing/platform');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

const BLOG_SLUG = 'spring-cleaning-with-kids';
let db: InMemorySupabase;

function form(fields: Record<string, unknown>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, String(value));
  return fd;
}
async function digestOf(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string; message?: string });
  return error ? (error.digest ?? error.message ?? 'error') : null;
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
const pageAt = (path: string) => db.table('marketing_pages').find((row) => row.path === path);
const legacyRow = () => db.table('marketing_landing_pages')[0];

/** The worker's claim (0237's claim_marketing_generation_jobs), served from the table. */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  const due = d.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && ['regenerate_page', 'generate_questions'].includes(String(row.job_type)))
    .slice(0, Number(args.p_limit ?? 10));
  for (const row of due) { row.status = 'running'; row.attempts = Number(row.attempts ?? 0) + 1; row.locked_at = new Date().toISOString(); }
  return due.map((row) => ({ ...row }));
}

/** The cron running the regeneration the console's save queued (0237's version and update triggers). */
async function theCronRegenerates(path: string) {
  const page = pageAt(path)!;
  page.version = Number(page.version ?? 1) + 1;
  db.seed('marketing_generation_jobs', [{
    job_type: 'regenerate_page', target_id: page.id, target_path: path,
    idempotency_key: `marketing-page:${page.id}:v:${page.version}`,
    payload: { page_id: page.id, path, version: page.version }, created_by: 'admin-1',
  }]);
  for (let round = 0; round < 5; round++) {
    const summary = await processMarketingGenerationJobs(db as never);
    expect(summary.failed).toBe(0);
    if (!summary.claimed) break;
  }
  expect(pageAt(path)!.content).toHaveProperty('sections');
}

/** A published legacy page at /lp/spring whose mirror the console moved to /lp/spring-console, published, and the cron regenerated. */
async function aMirrorTheConsoleMoved(): Promise<{ legacy: Row; moved: Row }> {
  await createLandingPage(form({ title: 'Spring', slug: 'spring', headline: 'Legacy spring' }));
  const legacy = legacyRow();
  await setLandingPublished(form({ id: legacy.id, publish: '1' }));
  const mirror = pageAt('/lp/spring')!;
  expect(mirror.content).toMatchObject({ source: 'marketing_landing_pages', source_id: legacy.id });

  await updatePlatformPage(form({ id: mirror.id, page_type: 'landing', title: 'Console adopted', slug: 'spring-console', status: 'published' }));
  await theCronRegenerates('/lp/spring-console');

  const moved = pageAt('/lp/spring-console')!;
  expect(moved).toMatchObject({ id: mirror.id, status: 'published', title: 'Console adopted' });
  expect(pageAt('/lp/spring')).toBeUndefined();
  return { legacy: structuredClone(legacy), moved: structuredClone(moved) };
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: {
      marketing_pages: [['path']], marketing_landing_pages: [['slug']], blog_posts: [['slug']],
      marketing_generation_jobs: [['idempotency_key']], marketing_page_versions: [['page_id', 'version']],
    },
    defaults: {
      marketing_pages: { deleted_at: null, version: 1 },
      marketing_landing_pages: { deleted_at: null, published: false },
      marketing_generation_jobs: { target_type: 'marketing_page', status: 'queued', priority: 50, attempts: 0, max_attempts: 5, payload: {}, result: {} },
    },
    rpc: { claim_marketing_generation_jobs: claim },
  });
  h.db = db;
  for (const table of ['marketing_pages', 'marketing_landing_pages', 'marketing_aeo_questions', 'marketing_generation_jobs',
    'marketing_page_versions', 'marketing_content_templates', 'marketing_brand_rules', 'blog_posts']) db.seed(table, []);
  db.seed('marketing_content_items', [
    {
      id: 'item-1', kind: 'blog', title: 'Spring cleaning with kids', status: 'approved', deleted_at: null,
      body: 'Start with one drawer.\n\nThen let each child pick a shelf.',
      metadata: { blog: { slug: BLOG_SLUG, category: 'Organization', excerpt: 'One drawer at a time.' } },
    },
    {
      id: 'item-2', kind: 'blog', title: 'Spring cleaning, the editors’ cut', status: 'approved', deleted_at: null,
      body: 'A different article.', metadata: { blog: { slug: `${BLOG_SLUG}-editorial`, category: 'Organization', excerpt: 'Another take.' } },
    },
  ]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a mirror the console moved is the console’s page', () => {
  it('the legacy page’s next edit leaves the moved page live, and takes its own path again', async () => {
    const { legacy, moved } = await aMirrorTheConsoleMoved();

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'spring', headline: 'Legacy spring, again' })))).toBeNull();

    expect(pageAt('/lp/spring-console')).toEqual(moved);
    expect(await visit('spring-console')).toBe('platform page');
    expect(pageAt('/lp/spring')).toMatchObject({ status: 'published', title: 'Legacy spring, again', content: { source_id: legacy.id } });
    expect(pageAt('/lp/spring')!.id).not.toBe(moved.id);
    expect(await visit('spring')).toBe('legacy page');
    // The move stamped it the console's, and the regeneration kept the stamp.
    expect(moved.content).toMatchObject({ source: 'platform_console' });
    expect(moved.content).not.toHaveProperty('source_id');
  });

  it('a rename of the legacy page leaves the moved page live', async () => {
    const { legacy, moved } = await aMirrorTheConsoleMoved();

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'summer', headline: 'Legacy summer' })))).toBeNull();

    expect(pageAt('/lp/spring-console')).toEqual(moved);
    expect(await visit('spring-console')).toBe('platform page');
    expect(await visit('summer')).toBe('legacy page');
  });

  it('a blog mirror the console moved is not overwritten by a post published at its new slug', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirror = pageAt(`/blog/${BLOG_SLUG}`)!;
    await updatePlatformPage(form({ id: mirror.id, page_type: 'blog', title: 'Spring cleaning (editorial)', slug: `${BLOG_SLUG}-editorial`, status: 'published' }));
    await theCronRegenerates(`/blog/${BLOG_SLUG}-editorial`);
    const moved = structuredClone(pageAt(`/blog/${BLOG_SLUG}-editorial`)!);

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-2' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(pageAt(`/blog/${BLOG_SLUG}-editorial`)).toEqual(moved);
    expect(db.table('blog_posts').map((row) => row.slug)).toEqual([BLOG_SLUG]);
    expect(moved.content).toMatchObject({ source: 'platform_console' });
  });
});

describe('the control: what the console does not move stays the legacy page’s', () => {
  it('the legacy page’s Unpublish and Archive after a move touch only its own path', async () => {
    const { legacy, moved } = await aMirrorTheConsoleMoved();

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));
    expect(pageAt('/lp/spring')).toMatchObject({ status: 'draft', content: { source_id: legacy.id } });
    await archiveLandingPage(form({ id: legacy.id }));
    expect(pageAt('/lp/spring')).toMatchObject({ status: 'archived' });

    expect(pageAt('/lp/spring-console')).toEqual(moved);
    expect(await visit('spring-console')).toBe('platform page');
  });

  it('an edit in the console at the same path keeps the mirror the legacy page’s, so its Publish still goes out', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    const mirror = pageAt('/lp/autumn')!;

    await updatePlatformPage(form({ id: mirror.id, page_type: 'landing', title: 'Autumn sale (edited)', slug: 'autumn', status: 'draft' }));
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirror.id, content: { source: 'marketing_landing_pages', source_id: legacy.id } });

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBeNull();
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirror.id, status: 'published', content: { source_id: legacy.id } });
    expect(await visit('autumn')).toBe('legacy page');
  });
});
