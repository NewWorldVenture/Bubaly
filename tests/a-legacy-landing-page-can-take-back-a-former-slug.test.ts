// Admin reach N12-TRANSITION-OLD-SLUG: the former slugs main's renames left.
//
// Main's runRegeneration replaced a mirror's `content` whole, and
// retireLegacyLandingAliases matches the mirror by its `content.source` marker,
// on main as here. So every rename of a legacy landing page under main left the
// old mirror at /lp/<old slug> unmarked and live. Round 3's transitional rule
// handled an unmarked row by path only at the slug the legacy page holds now, so
// until the owner's repair a rename back to a former slug, or a new or renamed
// legacy page at another page's former slug, was refused 'duplicate', where main
// took the row over. Now an unmarked row is handled as main handles it on the
// create and rename paths too: by path, and the bridge's write stamps it.
//
// Each case seeds the mirror as production has it (written by the REAL legacy
// action, then given the content main's regeneration wrote) and drives the REAL
// legacy and platform actions, the bridge, the job worker and the public /lp
// route against one in-memory database. On 5fb3a933b the cases not named "the
// control" fail; the controls (a live row marked as another legacy page's, a
// page the console made, a mirror the console moved) are still refused, there
// and here.
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

const { createLandingPage, setLandingPublished, updateLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { createPlatformPage, updatePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { buildDeterministicMarketingPage, processMarketingGenerationJobs } = await import('@/lib/marketing/platform');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

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
const legacyBySlug = (slug: string) => db.table('marketing_landing_pages').find((row) => row.slug === slug);

/** The `content` main's runRegeneration left on a mirror, replacing the whole column. */
const MAIN_REGENERATIONS: [string, (row: Row) => Record<string, unknown>][] = [
  ['the deterministic page', (row) => buildDeterministicMarketingPage(row as never).content],
  ['a model reply with no content', () => ({})],
];

/** The worker's claim (0237's claim_marketing_generation_jobs), served from the table. */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  const due = d.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && ['regenerate_page', 'generate_questions'].includes(String(row.job_type)))
    .slice(0, Number(args.p_limit ?? 10));
  for (const row of due) { row.status = 'running'; row.attempts = Number(row.attempts ?? 0) + 1; row.locked_at = new Date().toISOString(); }
  return due.map((row) => ({ ...row }));
}

/** The cron running the regeneration a console write queued, with THIS code. */
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(MAIN_REGENERATIONS)('a former slug a rename under main left (%s) is free again', (_label, regenerated) => {
  /**
   * A published legacy page made at /lp/autumn, its mirror given main's
   * regenerated content, then renamed to /lp/fall with the real action. The
   * rename leaves the unmarked mirror at /lp/autumn live, as it did on main.
   */
  async function aRenameUnderMainLeftAnAlias(): Promise<{ autumn: Row; aliasId: string }> {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const autumn = legacyBySlug('autumn')!;
    await setLandingPublished(form({ id: autumn.id, publish: '1' }));
    const alias = pageAt('/lp/autumn')!;
    expect(alias.content).toHaveProperty('source', 'marketing_landing_pages');
    alias.content = regenerated(alias);
    alias.version = Number(alias.version ?? 1) + 1;
    expect(alias.content).not.toHaveProperty('source');

    expect(await digestOf(updateLandingPage(form({ id: autumn.id, title: 'Autumn', slug: 'fall', headline: 'Fall sale' })))).toBeNull();

    expect(legacyBySlug('fall')).toMatchObject({ id: autumn.id });
    expect(pageAt('/lp/fall')).toMatchObject({ status: 'published', content: { source: 'marketing_landing_pages', source_id: autumn.id } });
    expect(pageAt('/lp/autumn')).toMatchObject({ id: alias.id, status: 'published', deleted_at: null });
    expect(pageAt('/lp/autumn')!.content).not.toHaveProperty('source');
    return { autumn: structuredClone(autumn), aliasId: String(alias.id) };
  }

  it('renaming the page back to its former slug takes the alias over, and the page serves there again', async () => {
    const { autumn, aliasId } = await aRenameUnderMainLeftAnAlias();

    expect(await digestOf(updateLandingPage(form({ id: autumn.id, title: 'Autumn', slug: 'autumn', headline: 'Autumn sale, again' })))).toBeNull();

    expect(legacyBySlug('autumn')).toMatchObject({ id: autumn.id, headline: 'Autumn sale, again' });
    expect(pageAt('/lp/autumn')).toMatchObject({
      id: aliasId, status: 'published', deleted_at: null, title: 'Autumn sale, again',
      content: { source: 'marketing_landing_pages', source_id: autumn.id },
    });
    expect(pageAt('/lp/fall')).toMatchObject({ status: 'archived' });
    expect(pageAt('/lp/fall')!.deleted_at).not.toBeNull();
    expect(await visit('autumn')).toBe('legacy page');
    expect(await visit('fall')).toBe('not found');
  });

  it('a new legacy page at the former slug takes the alias over, and the renamed page stays live', async () => {
    const { autumn, aliasId } = await aRenameUnderMainLeftAnAlias();

    expect(await digestOf(createLandingPage(form({ title: 'Harvest', slug: 'autumn', headline: 'Harvest fair' })))).toBeNull();

    const harvest = legacyBySlug('autumn')!;
    expect(harvest).toMatchObject({ title: 'Harvest', published: false });
    expect(pageAt('/lp/autumn')).toMatchObject({
      id: aliasId, status: 'draft', title: 'Harvest fair', content: { source: 'marketing_landing_pages', source_id: harvest.id },
    });
    // The old page's stale copy no longer serves at its former slug.
    expect(await visit('autumn')).toBe('not found');
    expect(await visit('fall')).toBe('legacy page');
    expect(pageAt('/lp/fall')).toMatchObject({ status: 'published', content: { source_id: autumn.id } });

    expect(await digestOf(setLandingPublished(form({ id: harvest.id, publish: '1' })))).toBeNull();
    expect(pageAt('/lp/autumn')).toMatchObject({ id: aliasId, status: 'published', content: { source_id: harvest.id } });
    expect(await visit('autumn')).toBe('legacy page');
  });

  it('another legacy page renamed onto the former slug takes the alias over and retires its own old path', async () => {
    const { autumn, aliasId } = await aRenameUnderMainLeftAnAlias();
    await createLandingPage(form({ title: 'Harvest', slug: 'harvest', headline: 'Harvest fair' }));
    const harvest = legacyBySlug('harvest')!;
    await setLandingPublished(form({ id: harvest.id, publish: '1' }));

    expect(await digestOf(updateLandingPage(form({ id: harvest.id, title: 'Harvest', slug: 'autumn', headline: 'Harvest fair' })))).toBeNull();

    expect(legacyBySlug('autumn')).toMatchObject({ id: harvest.id });
    expect(pageAt('/lp/autumn')).toMatchObject({
      id: aliasId, status: 'published', deleted_at: null, title: 'Harvest fair',
      content: { source: 'marketing_landing_pages', source_id: harvest.id },
    });
    expect(pageAt('/lp/harvest')).toMatchObject({ status: 'archived' });
    expect(await visit('autumn')).toBe('legacy page');
    expect(await visit('harvest')).toBe('not found');
    expect(await visit('fall')).toBe('legacy page');
    expect(pageAt('/lp/fall')).toMatchObject({ status: 'published', content: { source_id: autumn.id } });
  });
});

describe('the control: a create or rename onto a marked row that is not this page’s is still refused', () => {
  /** A legacy page at /lp/autumn, to rename. */
  async function aLegacyPageToRename(): Promise<Row> {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    return structuredClone(legacyBySlug('autumn')!);
  }
  async function bothAreRefused(slug: string, legacy: Row) {
    const before = structuredClone(pageAt(`/lp/${slug}`)!);
    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug, headline: 'Autumn sale' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(await digestOf(createLandingPage(form({ title: 'Another', slug, headline: 'Another page' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(legacyBySlug('autumn')).toMatchObject({ id: legacy.id });
    expect(db.table('marketing_landing_pages')).toHaveLength(1);
    expect(pageAt(`/lp/${slug}`)).toEqual(before);
  }

  it('a live row marked as another legacy page’s (an alias whose retirement has not run yet)', async () => {
    const legacy = await aLegacyPageToRename();
    db.seed('marketing_pages', [{
      id: 'another-pages-alias', page_type: 'landing', slug: 'spring', path: '/lp/spring', title: 'Spring offer',
      summary: 'Another legacy page', body: 'Its body', seo: {}, aeo: {}, status: 'published',
      published_at: '2026-10-01T00:00:00.000Z', deleted_at: null, version: 2,
      content: { source: 'marketing_landing_pages', source_id: 'another-legacy-page' },
    }]);

    await bothAreRefused('spring', legacy);
    expect(await visit('spring')).toBe('platform page');
  });

  it('a page the console made, after the cron regenerated it', async () => {
    const legacy = await aLegacyPageToRename();
    await createPlatformPage(form({ page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign' }));
    await updatePlatformPage(form({ id: pageAt('/lp/spring')!.id, page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign', status: 'published' }));
    await theCronRegenerates('/lp/spring');
    expect(pageAt('/lp/spring')!.content).toMatchObject({ source: 'platform_console' });

    await bothAreRefused('spring', legacy);
    expect(await visit('spring')).toBe('platform page');
  });

  it('a mirror the console moved, after the cron regenerated it', async () => {
    await createLandingPage(form({ title: 'Spring', slug: 'spring', headline: 'Legacy spring' }));
    const spring = legacyBySlug('spring')!;
    await setLandingPublished(form({ id: spring.id, publish: '1' }));
    await updatePlatformPage(form({ id: pageAt('/lp/spring')!.id, page_type: 'landing', title: 'Console adopted', slug: 'spring-console', status: 'published' }));
    await theCronRegenerates('/lp/spring-console');
    expect(pageAt('/lp/spring-console')!.content).toMatchObject({ source: 'platform_console' });
    const legacy = await aLegacyPageToRename();
    const moved = structuredClone(pageAt('/lp/spring-console')!);

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug: 'spring-console', headline: 'Autumn sale' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(await digestOf(createLandingPage(form({ title: 'Another', slug: 'spring-console', headline: 'Another page' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(legacyBySlug('autumn')).toMatchObject({ id: legacy.id });
    expect(pageAt('/lp/spring-console')).toEqual(moved);
    expect(await visit('spring-console')).toBe('platform page');
  });
});
