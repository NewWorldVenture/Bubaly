// Admin reach N12-REGEN-REPAIR-SPEC: the mirrors production already has.
//
// Round 2 made the legacy landing and blog bridges recognise their own
// marketing_pages row by `content.source` / `content.source_id`, and its re-fix
// (7ebf6fe94) made the marketing cron's regeneration keep those keys. But every
// bridge write queues a regeneration (0239's insert trigger, 0237's version and
// update triggers), and main's runRegeneration replaced `content` whole. So in
// production almost every existing mirror has already lost its marker. With the
// marker as the only test of ownership, deploying before the owner's data
// repair turned each legacy page's own buttons against it: landing Publish and
// edit were refused 'duplicate', Unpublish and Archive left /lp/<slug> serving
// the mirror, and a blog republish was refused while Unpublish and Archive left
// the mirror published. Main does all of these by path.
//
// The transitional rule: a row with NO `content.source` is handled as main
// handles it, by path: at the path the legacy record holds it is that record's
// mirror, and a create or rename onto it takes it over, as main's upsert did
// (admin reach N12-TRANSITION-OLD-SLUG). The bridge's write stamps the marker
// back. A row marked as another source, including a page the platform console
// made, is never touched.
//
// Each case seeds the mirror as production has it: written by the REAL legacy
// or content action, then given the content main's regeneration wrote. Then it
// drives the REAL legacy, content and platform actions, the bridge, the job
// worker, the public /lp route and the public AEO reader against one in-memory
// database. On 7ebf6fe94 the 14 publish, edit, unpublish and archive cases
// fail; the two controls pass there and here. Without the console's stamp on
// the pages it makes, the console-page controls (and round 2's) fail under
// this rule. The two takeover cases (a create or rename onto an unmarked row
// no legacy page holds) fail on 7ebf6fe94 and on 5fb3a933b, which refused them;
// a-legacy-landing-page-can-take-back-a-former-slug has the former-slug cases.
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
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => false, resolveProvider: async () => { throw new Error('no provider'); } }));

const { createLandingPage, setLandingPublished, archiveLandingPage, updateLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { publishContentToBlogAction, unpublishBlogPostAction, archiveContentAction } = await import('@/app/(app)/admin/marketing/content/actions');
const { createPlatformPage, updatePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { buildDeterministicMarketingPage, processMarketingGenerationJobs } = await import('@/lib/marketing/platform');
const { readPublishedAeoQuestions } = await import('@/lib/marketing/aeo');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

const BLOG_SLUG = 'spring-cleaning-with-kids';
const BLOG_PATH = `/blog/${BLOG_SLUG}`;
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
async function publicAnswers(): Promise<string[]> {
  const read = await readPublishedAeoQuestions(60);
  expect(read.available).toBe(true);
  return read.questions.map((q) => q.answer);
}
const pageAt = (path: string) => db.table('marketing_pages').find((row) => row.path === path);
const legacyRow = () => db.table('marketing_landing_pages')[0];
const post = () => db.table('blog_posts').find((row) => row.slug === BLOG_SLUG);

/**
 * The `content` main's runRegeneration left on a mirror, replacing the whole
 * column: the deterministic page's, or a model reply's (here one that sent no
 * `content` at all, which normalizeGeneratedPage reads as {}).
 */
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
  db.seed('marketing_content_items', [{
    id: 'item-1', kind: 'blog', title: 'Spring cleaning with kids', status: 'approved', deleted_at: null,
    body: 'Start with one drawer.\n\nThen let each child pick a shelf.',
    metadata: { blog: { slug: BLOG_SLUG, category: 'Organization', excerpt: 'One drawer at a time.' } },
  }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(MAIN_REGENERATIONS)('a mirror main regenerated (%s) still follows its legacy page', (_label, regenerated) => {
  /** The mirror at `path` as production has it: main's regeneration took its marker. */
  function asProductionHasIt(path: string): string {
    const row = pageAt(path)!;
    expect(row.content).toHaveProperty('source');
    row.content = regenerated(row);
    row.version = Number(row.version ?? 1) + 1;
    expect(row.content).not.toHaveProperty('source');
    return String(row.id);
  }

  it('landing Publish of a draft goes out, and the mirror gets its marker back', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    const mirrorId = asProductionHasIt('/lp/autumn');

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBeNull();

    expect(legacyRow()).toMatchObject({ published: true, status: 'published' });
    expect(pageAt('/lp/autumn')).toMatchObject({
      id: mirrorId, status: 'published', title: 'Autumn sale', content: { source: 'marketing_landing_pages', source_id: legacy.id },
    });
    expect(await visit('autumn')).toBe('legacy page');
  });

  it('a landing edit is saved, to the legacy page and its mirror', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    const mirrorId = asProductionHasIt('/lp/autumn');

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug: 'autumn', headline: 'Autumn sale, extended' })))).toBeNull();

    expect(legacyRow()).toMatchObject({ headline: 'Autumn sale, extended' });
    expect(pageAt('/lp/autumn')).toMatchObject({
      id: mirrorId, status: 'published', title: 'Autumn sale, extended', content: { source: 'marketing_landing_pages', source_id: legacy.id },
    });
    expect(await visit('autumn')).toBe('legacy page');
  });

  it('landing Unpublish takes /lp/<slug> down, and Publish puts it back', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    const mirrorId = asProductionHasIt('/lp/autumn');

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));

    expect(legacyRow()).toMatchObject({ published: false, status: 'draft' });
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirrorId, status: 'draft' });
    expect(await visit('autumn')).toBe('not found');

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBeNull();
    expect(pageAt('/lp/autumn')).toMatchObject({ id: mirrorId, status: 'published' });
    expect(await visit('autumn')).toBe('legacy page');
  });

  it('landing Archive takes /lp/<slug> down and retires the answers it published', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    const mirrorId = asProductionHasIt('/lp/autumn');
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

  it('a blog republish goes out over the mirror and marks it again', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirrorId = asProductionHasIt(BLOG_PATH);

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBeNull();

    expect(post()).toMatchObject({ published: true });
    expect(pageAt(BLOG_PATH)).toMatchObject({
      id: mirrorId, status: 'published', content: { source: 'marketing_content_items', source_id: 'item-1' },
    });
  });

  it('blog Unpublish drafts the mirror', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirrorId = asProductionHasIt(BLOG_PATH);

    await unpublishBlogPostAction(BLOG_SLUG);

    expect(post()).toMatchObject({ published: false });
    expect(pageAt(BLOG_PATH)).toMatchObject({ id: mirrorId, status: 'draft' });
  });

  it('archiving the blog content item archives the mirror', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirrorId = asProductionHasIt(BLOG_PATH);

    await archiveContentAction(form({ id: 'item-1' }));

    expect(post()).toMatchObject({ published: false });
    expect(pageAt(BLOG_PATH)).toMatchObject({ id: mirrorId, status: 'archived' });
    expect(pageAt(BLOG_PATH)!.deleted_at).not.toBeNull();
  });

  it('an unmarked row at a path the legacy page does not hold is taken over by a rename or a create, as on main', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    // No legacy page holds /lp/spring or /lp/summer: a former slug's alias, or a
    // console page made before the console stamped its own, as main's
    // regeneration left it. Main's sync upserted over such a row on a create or
    // a rename; until the owner's repair marks it, so does the bridge.
    for (const slug of ['spring', 'summer']) {
      const row: Row = {
        id: `unowned-${slug}`, page_type: 'landing', slug, path: `/lp/${slug}`, title: `${slug} offer`,
        summary: 'The live campaign', body: 'Live body', seo: {}, aeo: {}, status: 'published',
        published_at: '2026-10-01T00:00:00.000Z', deleted_at: null, version: 3,
      };
      db.seed('marketing_pages', [{ ...row, content: regenerated(row) }]);
      expect(pageAt(`/lp/${slug}`)!.content).not.toHaveProperty('source');
    }

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug: 'spring', headline: 'Autumn sale' })))).toBeNull();
    expect(legacyRow()).toMatchObject({ id: legacy.id, slug: 'spring' });
    expect(pageAt('/lp/spring')).toMatchObject({
      id: 'unowned-spring', status: 'draft', title: 'Autumn sale', content: { source: 'marketing_landing_pages', source_id: legacy.id },
    });
    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'archived' });

    expect(await digestOf(createLandingPage(form({ title: 'Summer', slug: 'summer' })))).toBeNull();
    const summer = db.table('marketing_landing_pages').find((row) => row.slug === 'summer')!;
    expect(pageAt('/lp/summer')).toMatchObject({
      id: 'unowned-summer', status: 'draft', title: 'Summer', content: { source: 'marketing_landing_pages', source_id: summer.id },
    });
  });
});

describe('the control: a page the console made is never a bridge’s, even after the cron regenerated it', () => {
  it('on the legacy landing page’s own path: Unpublish and Archive leave it live, and Publish is refused', async () => {
    await createLandingPage(form({ title: 'Spring', slug: 'spring', headline: 'Legacy spring' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    await updatePlatformPage(form({ id: pageAt('/lp/spring')!.id, page_type: 'landing', title: 'Legacy spring', slug: 'spring-legacy', status: 'published' }));
    await createPlatformPage(form({ page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign' }));
    await updatePlatformPage(form({ id: pageAt('/lp/spring')!.id, page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign', status: 'published' }));
    await theCronRegenerates('/lp/spring');
    const consolePage = structuredClone(pageAt('/lp/spring')!);

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));
    expect(pageAt('/lp/spring')).toEqual(consolePage);
    expect(await visit('spring')).toBe('platform page');

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    await archiveLandingPage(form({ id: legacy.id }));
    expect(pageAt('/lp/spring')).toEqual(consolePage);
    expect(await visit('spring')).toBe('platform page');
  });

  it('at a blog path: publishing there is refused and the page is left as it was', async () => {
    await createPlatformPage(form({ page_type: 'blog', title: 'Spring cleaning (editorial)', slug: BLOG_SLUG, summary: 'Our editors’ take' }));
    await updatePlatformPage(form({ id: pageAt(BLOG_PATH)!.id, page_type: 'blog', title: 'Spring cleaning (editorial)', slug: BLOG_SLUG, summary: 'Our editors’ take', status: 'published' }));
    await theCronRegenerates(BLOG_PATH);
    const consolePage = structuredClone(pageAt(BLOG_PATH)!);

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);

    expect(pageAt(BLOG_PATH)).toEqual(consolePage);
    expect(post()).toBeUndefined();
  });
});
