// Admin reach N12-R1-REGEN-TAKEDOWN, N12-R1-REGEN-PUBLISH and
// N12-S1-REGEN-REPUBLISH: the marketing cron's regeneration of a legacy page's
// own mirror in the platform registry.
//
// Round 2 made the legacy landing and blog bridges recognise their own
// marketing_pages row by `content.source` / `content.source_id`, the keys they
// stamp on every write. Every bridge write also sets `updated_by` to the admin,
// so migration 0239's insert trigger and 0237's version and update triggers
// queue a `regenerate_page` job, which /api/cron/marketing runs every five
// minutes. runRegeneration then replaced `content` with what it generated
// (`{ sections, generated: false }`, or the model's reply), and the marker was
// gone. From then on the page's own mirror read as another page's row:
//   - landing Unpublish left the mirror 'published', and Archive matched
//     nothing, so /lp/<slug> fell through to the platform route and kept
//     serving the regenerated mirror;
//   - landing Publish and edit were refused 'duplicate', and a rename left the
//     old path's mirror live;
//   - a blog republish was refused 'duplicate', and Unpublish and Archive left
//     the mirror published.
//
// Driven through the REAL legacy, content and platform actions, the bridge,
// the job worker (processMarketingGenerationJobs, with the claim RPC served
// from the table), the public /lp route and the public AEO reader, against one
// in-memory database. Before the fix every case here fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';

const h = vi.hoisted(() => ({
  db: null as unknown,
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  /** The model's `content` when the AI provider is configured; null leaves it off (the deterministic page). */
  aiContent: null as Record<string, unknown> | null,
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
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => h.aiContent !== null,
  resolveProvider: async () => ({
    complete: async () => ({
      text: JSON.stringify({
        title: 'Regenerated title', summary: 'Regenerated summary.', body: 'Regenerated body.', content: h.aiContent,
        seo: { title: 'Regenerated | Bubaly', description: 'Regenerated summary.', keywords: [] },
        aeo: { questions: [{ question: 'What changed?', answer: 'The regenerated answer.' }] },
      }),
    }),
  }),
}));

const { createLandingPage, setLandingPublished, archiveLandingPage, updateLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { publishContentToBlogAction, unpublishBlogPostAction, archiveContentAction } = await import('@/app/(app)/admin/marketing/content/actions');
const { createPlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { processMarketingGenerationJobs } = await import('@/lib/marketing/platform');
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

/** The worker's claim (0237's claim_marketing_generation_jobs), served from the table. */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  const due = d.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && ['regenerate_page', 'generate_questions'].includes(String(row.job_type)))
    .slice(0, Number(args.p_limit ?? 10));
  for (const row of due) { row.status = 'running'; row.attempts = Number(row.attempts ?? 0) + 1; row.locked_at = new Date().toISOString(); }
  return due.map((row) => ({ ...row }));
}

/**
 * What follows a bridge write in production: it set `updated_by` to the admin,
 * so 0237's version trigger moved the page to a new version and 0239's insert
 * trigger (or 0237's update trigger) queued a regenerate_page job for it. The
 * marketing cron then runs the queue, including the questions job that the
 * regeneration queues in turn.
 */
async function theCronRegenerates(path: string) {
  const page = pageAt(path)!;
  page.version = Number(page.version ?? 1) + 1;
  db.seed('marketing_generation_jobs', [{
    job_type: 'regenerate_page', target_id: page.id, target_path: path,
    idempotency_key: `marketing-page:${page.id}:v:${page.version}`,
    payload: { page_id: page.id, path, version: page.version }, created_by: 'admin-1',
  }]);
  let ran = 0;
  for (let round = 0; round < 5; round++) {
    const summary = await processMarketingGenerationJobs(db as never);
    expect(summary.failed).toBe(0);
    if (!summary.claimed) break;
    ran += summary.succeeded;
  }
  expect(ran).toBeGreaterThan(0);
  // The regeneration did run: the generator's content is on the row.
  expect(pageAt(path)!.content).toHaveProperty('sections');
}

beforeEach(() => {
  h.aiContent = null;
  db = createInMemorySupabase({
    uniques: {
      marketing_pages: [['path']], marketing_landing_pages: [['slug']], blog_posts: [['slug']],
      marketing_generation_jobs: [['idempotency_key']], marketing_page_versions: [['page_id', 'version']],
    },
    defaults: {
      marketing_pages: { deleted_at: null, version: 1 },
      marketing_landing_pages: { deleted_at: null, published: false },
      // 0237's column defaults, which the jobs the regeneration queues rely on.
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

describe('a regenerated mirror keeps the marker that says whose row it is', () => {
  it('on the row and in its version snapshot, with the generator’s content around it', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();

    await theCronRegenerates('/lp/autumn');

    const mirror = pageAt('/lp/autumn')!;
    expect(mirror.content).toMatchObject({ source: 'marketing_landing_pages', source_id: legacy.id, generated: false });
    const snapshot = db.table('marketing_page_versions').find((row) => row.page_id === mirror.id && row.version === mirror.version);
    expect(snapshot?.content).toMatchObject({ source: 'marketing_landing_pages', source_id: legacy.id, generated: false });
  });

  it('when the model writes the content, and whatever provenance the model’s reply claims', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    h.aiContent = { sections: [{ type: 'hero', body: 'Autumn' }], source: 'ai', source_id: 'made-up' };

    await theCronRegenerates('/lp/autumn');

    expect(pageAt('/lp/autumn')).toMatchObject({
      title: 'Regenerated title',
      content: { sections: [{ type: 'hero', body: 'Autumn' }], source: 'marketing_landing_pages', source_id: legacy.id },
    });
  });

  it('a page made in the console gets no marker from the model, so a legacy page still cannot take its path', async () => {
    await createPlatformPage(form({ page_type: 'landing', title: 'Spring offer', slug: 'spring', summary: 'The live campaign' }));
    const consolePage = pageAt('/lp/spring')!;
    await createLandingPage(form({ title: 'Spring', slug: 'spring-legacy', headline: 'Legacy spring' }));
    const legacy = legacyRow();
    h.aiContent = { sections: [], source: 'marketing_landing_pages', source_id: legacy.id };

    await theCronRegenerates('/lp/spring');

    expect(pageAt('/lp/spring')!.id).toBe(consolePage.id);
    // The console's own stamp (admin reach N12-REGEN-REPAIR-SPEC), not the model's claim.
    expect(pageAt('/lp/spring')!.content).toHaveProperty('source', 'platform_console');
    expect(pageAt('/lp/spring')!.content).not.toHaveProperty('source_id');
    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'spring', headline: 'Legacy spring' }))))
      .toBe(`${REFUSAL_DIGEST_PREFIX}duplicate`);
    expect(legacyRow()).toMatchObject({ slug: 'spring-legacy' });
  });
});

describe('a legacy landing page still moves its own mirror after the cron regenerated it', () => {
  it('Unpublish takes /lp/<slug> down', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    await theCronRegenerates('/lp/autumn');
    expect(await visit('autumn')).toBe('legacy page');

    await setLandingPublished(form({ id: legacy.id, publish: '0' }));

    expect(legacyRow()).toMatchObject({ published: false, status: 'draft' });
    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'draft', content: { source_id: legacy.id } });
    expect(await visit('autumn')).toBe('not found');
  });

  it('Archive takes /lp/<slug> down and retires the answers the regeneration published', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    h.aiContent = { sections: [] };
    await theCronRegenerates('/lp/autumn');
    expect(await publicAnswers()).toContain('The regenerated answer.');

    await archiveLandingPage(form({ id: legacy.id }));

    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'archived' });
    expect(pageAt('/lp/autumn')!.deleted_at).not.toBeNull();
    expect(await visit('autumn')).toBe('not found');
    expect(await publicAnswers()).not.toContain('The regenerated answer.');
  });

  it('Publish of a draft goes out', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await theCronRegenerates('/lp/autumn');

    expect(await digestOf(setLandingPublished(form({ id: legacy.id, publish: '1' })))).toBeNull();

    expect(legacyRow()).toMatchObject({ published: true, status: 'published' });
    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'published', title: 'Autumn sale' });
    expect(await visit('autumn')).toBe('legacy page');
  });

  it('an edit of a draft is saved', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await theCronRegenerates('/lp/autumn');

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug: 'autumn', headline: 'Autumn sale, extended' })))).toBeNull();

    expect(legacyRow()).toMatchObject({ headline: 'Autumn sale, extended' });
    expect(pageAt('/lp/autumn')).toMatchObject({ title: 'Autumn sale, extended', content: { source_id: legacy.id } });
  });

  it('a rename of a published page moves it, and the old path stops serving the regenerated mirror', async () => {
    await createLandingPage(form({ title: 'Autumn', slug: 'autumn', headline: 'Autumn sale' }));
    const legacy = legacyRow();
    await setLandingPublished(form({ id: legacy.id, publish: '1' }));
    await theCronRegenerates('/lp/autumn');

    expect(await digestOf(updateLandingPage(form({ id: legacy.id, title: 'Autumn', slug: 'fall', headline: 'Autumn sale' })))).toBeNull();

    expect(await visit('fall')).toBe('legacy page');
    expect(pageAt('/lp/autumn')).toMatchObject({ status: 'archived' });
    expect(await visit('autumn')).toBe('not found');
  });
});

describe('a blog post still moves its own mirror after the cron regenerated it', () => {
  it('a republish goes out', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirrorId = pageAt(BLOG_PATH)!.id;
    await theCronRegenerates(BLOG_PATH);

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBeNull();

    expect(post()).toMatchObject({ published: true });
    expect(pageAt(BLOG_PATH)).toMatchObject({ id: mirrorId, status: 'published', content: { source: 'marketing_content_items', source_id: 'item-1' } });
  });

  it('Unpublish drafts the mirror, and archiving the content item then archives it', async () => {
    await publishContentToBlogAction(form({ id: 'item-1' }));
    const mirrorId = pageAt(BLOG_PATH)!.id;
    await theCronRegenerates(BLOG_PATH);

    await unpublishBlogPostAction(BLOG_SLUG);
    expect(post()).toMatchObject({ published: false });
    expect(pageAt(BLOG_PATH)).toMatchObject({ id: mirrorId, status: 'draft' });

    await theCronRegenerates(BLOG_PATH);
    await archiveContentAction(form({ id: 'item-1' }));
    expect(pageAt(BLOG_PATH)).toMatchObject({ id: mirrorId, status: 'archived' });
    expect(pageAt(BLOG_PATH)!.deleted_at).not.toBeNull();
  });

  it('a mirror backfilled from blog_posts can be republished from its content item', async () => {
    db.seed('blog_posts', [{ id: 'post-1', slug: BLOG_SLUG, title: 'Spring cleaning with kids', published: true }]);
    db.seed('marketing_pages', [{
      id: 'backfilled-page', page_type: 'blog', slug: BLOG_SLUG, path: BLOG_PATH, title: 'Spring cleaning with kids',
      summary: 'One drawer at a time.', body: 'Start with one drawer.',
      content: { source: 'blog_posts', source_id: 'post-1', category: 'Organization', tags: [], blocks: [] },
      seo: {}, aeo: {}, status: 'published', published_at: '2026-01-01T00:00:00.000Z',
    }]);
    await theCronRegenerates(BLOG_PATH);
    expect(pageAt(BLOG_PATH)!.content).toMatchObject({ source: 'blog_posts', source_id: 'post-1' });

    expect(await digestOf(publishContentToBlogAction(form({ id: 'item-1' })))).toBeNull();

    expect(pageAt(BLOG_PATH)).toMatchObject({ id: 'backfilled-page', status: 'published', content: { source: 'marketing_content_items', source_id: 'item-1' } });
  });
});
