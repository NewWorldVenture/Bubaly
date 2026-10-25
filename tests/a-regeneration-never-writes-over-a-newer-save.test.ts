// Admin reach N12-REGEN-RACE-CONSOLE-MOVE: a console save that lands while the
// cron is regenerating the page.
//
// runRegeneration (lib/marketing/platform.ts) reads the page, generates (a
// model call: seconds), then writes title, summary, body, content, seo and aeo
// back. It wrote by id alone, with `content` built from the row as it was READ.
// A console move inside that window (the move stamps content.source
// 'platform_console', and 0237's marketing_page_version_on_edit bumps
// `version`) was overwritten: the moved page carried the legacy page's marker
// again, the job the move queued kept that marker, and the legacy page's next
// edit archived the moved, published page. An archive in the window got the
// generated copy written onto the archived row and a questions job queued for
// a page that is gone, which then failed the cron run five times over.
//
// The rule: a regeneration writes only over the version it read. When the page
// has moved on, the job is superseded: it finishes as succeeded, writes nothing
// (no page, no snapshot, no follow-up jobs) and the cron run reports no
// failure. The job the newer version queued regenerates the page.
//
// Driven through the REAL legacy and platform actions, the job worker behind
// the REAL /api/cron/marketing route, and the public /lp route, against one
// in-memory database. That database runs no triggers, so the test bumps the
// version and queues the newer job where 0237's triggers would. The save lands
// inside the mocked isAIConfigured, which runRegeneration reaches after its
// read and before its write. On 340cd7dae the two raced cases fail; the two
// controls pass there and here.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  /** Runs once, inside the regeneration: after it read the page, before it writes it. */
  duringGeneration: null as null | (() => Promise<void>),
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
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => {
    const during = h.duringGeneration;
    h.duringGeneration = null;
    if (during) await during();
    return false;
  },
  resolveProvider: async () => { throw new Error('no provider'); },
}));

const { createLandingPage, setLandingPublished, updateLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { createPlatformPage, updatePlatformPage, archivePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { buildDeterministicMarketingPage } = await import('@/lib/marketing/platform');
const { GET: marketingCron } = await import('@/app/api/cron/marketing/route');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');

const CRON_SECRET = 'marketing-cron-fixture-secret';
let db: InMemorySupabase;
let errors: unknown[][];

function form(fields: Record<string, unknown>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, String(value));
  return fd;
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
const pageById = (id: unknown) => db.table('marketing_pages').find((row) => row.id === id);
const jobsFor = (id: unknown) => db.table('marketing_generation_jobs').filter((row) => row.target_id === id);
const workerFailures = () => errors.filter((args) => String(args[0]).startsWith('[marketing-platform] job'));

/** The worker's claim (0237's claim_marketing_generation_jobs), served from the table. */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  const due = d.table('marketing_generation_jobs')
    .filter((row) => row.status === 'queued' && ['regenerate_page', 'generate_questions'].includes(String(row.job_type)))
    .slice(0, Number(args.p_limit ?? 10));
  for (const row of due) { row.status = 'running'; row.attempts = Number(row.attempts ?? 0) + 1; row.locked_at = new Date().toISOString(); }
  return due.map((row) => ({ ...row }));
}

/**
 * 0237's triggers on an admin save of the page: the BEFORE UPDATE trigger bumps
 * `version`, and the AFTER UPDATE trigger queues that version's regeneration,
 * except for a page the save deleted.
 */
function theTriggersFireOnTheSave(id: unknown) {
  const page = pageById(id)!;
  page.version = Number(page.version) + 1;
  if (page.deleted_at) return;
  db.seed('marketing_generation_jobs', [{
    job_type: 'regenerate_page', target_id: page.id, target_path: page.path,
    idempotency_key: `marketing-page:${page.id}:v:${page.version}`,
    payload: { page_id: page.id, path: page.path, version: page.version }, created_by: 'admin-1',
  }]);
}

/** One Vercel Cron invocation of /api/cron/marketing. */
async function theCronRuns() {
  const res = await marketingCron(new NextRequest('https://fixture.invalid/api/cron/marketing', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  return { status: res.status, body: await res.json() as { claimed: number; succeeded: number; failed: number; ok: boolean } };
}

/** A published legacy page at /lp/spring, its mirror's regeneration queued by the publish. */
async function aPublishedLegacyPage(): Promise<{ legacy: Row; mirror: Row }> {
  await createLandingPage(form({ title: 'Spring', slug: 'spring', headline: 'Legacy spring' }));
  const legacy = db.table('marketing_landing_pages')[0];
  await setLandingPublished(form({ id: legacy.id, publish: '1' }));
  const mirror = pageAt('/lp/spring')!;
  theTriggersFireOnTheSave(mirror.id);
  expect(mirror).toMatchObject({ status: 'published', version: 2, content: { source: 'marketing_landing_pages', source_id: legacy.id } });
  return { legacy, mirror };
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  db = createInMemorySupabase({
    uniques: {
      marketing_pages: [['path']], marketing_landing_pages: [['slug']], blog_posts: [['slug']],
      marketing_generation_jobs: [['idempotency_key']], marketing_page_versions: [['page_id', 'version']],
    },
    defaults: {
      marketing_pages: { deleted_at: null, version: 1 },
      marketing_landing_pages: { deleted_at: null, published: false },
      marketing_generation_jobs: { target_type: 'marketing_page', status: 'queued', priority: 50, attempts: 0, max_attempts: 5, payload: {}, result: {}, error: null },
    },
    rpc: { claim_marketing_generation_jobs: claim },
  });
  h.db = db;
  h.duringGeneration = null;
  for (const table of ['marketing_pages', 'marketing_landing_pages', 'marketing_aeo_questions', 'marketing_generation_jobs',
    'marketing_page_versions', 'marketing_content_templates', 'marketing_brand_rules', 'blog_posts']) db.seed(table, []);
  errors = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a console save that lands while the page regenerates', () => {
  it('a move is not overwritten, and the legacy page’s next edit leaves the moved page live', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage();
    const racedJob = jobsFor(mirror.id)[0];
    let afterTheMove: Row | null = null;
    h.duringGeneration = async () => {
      await updatePlatformPage(form({ id: mirror.id, page_type: 'landing', title: 'Console adopted', slug: 'spring-console', status: 'published' }));
      theTriggersFireOnTheSave(mirror.id);
      afterTheMove = structuredClone(pageById(mirror.id)!);
    };

    const raced = await theCronRuns();

    expect(afterTheMove).toMatchObject({ path: '/lp/spring-console', version: 3, content: { source: 'platform_console' } });
    // The regeneration that read version 2 wrote nothing over version 3.
    expect(pageById(mirror.id)).toEqual(afterTheMove);
    // Superseded, not failed: finished, no error, nothing for the cron to report.
    expect(raced).toEqual({ status: 200, body: expect.objectContaining({ claimed: 1, succeeded: 1, failed: 0, ok: true }) });
    expect(racedJob).toMatchObject({ status: 'succeeded', error: null, result: { pageId: mirror.id, version: 2, superseded: true } });
    expect(workerFailures()).toEqual([]);
    // No snapshot or follow-up jobs for the version it read; only the move's regeneration is waiting.
    expect(db.table('marketing_page_versions')).toEqual([]);
    expect(jobsFor(mirror.id).filter((row) => row.status === 'queued').map((row) => [row.job_type, row.payload])).toEqual([
      ['regenerate_page', { page_id: mirror.id, path: '/lp/spring-console', version: 3 }],
    ]);

    // The move's own job regenerates the page, and keeps the console's stamp.
    for (let round = 0; round < 5; round++) {
      const run = await theCronRuns();
      expect(run).toEqual({ status: 200, body: expect.objectContaining({ failed: 0, ok: true }) });
      if (!run.body.claimed) break;
    }
    const moved = structuredClone(pageAt('/lp/spring-console')!);
    expect(moved).toMatchObject({ id: mirror.id, status: 'published', title: 'Console adopted', content: { source: 'platform_console', sections: expect.any(Array) } });
    expect(moved.content).not.toHaveProperty('source_id');
    expect(db.table('marketing_page_versions')).toEqual([expect.objectContaining({ page_id: mirror.id, version: 3, title: 'Console adopted' })]);

    await updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'spring', headline: 'Legacy spring, again' }));

    expect(pageAt('/lp/spring-console')).toEqual(moved);
    expect(await visit('spring-console')).toBe('platform page');
    expect(pageAt('/lp/spring')).toMatchObject({ status: 'published', title: 'Legacy spring, again', content: { source_id: legacy.id } });
    expect(await visit('spring')).toBe('legacy page');
  });

  it('an archive leaves the page archived, with nothing queued for it and no failed run', async () => {
    await createPlatformPage(form({ page_type: 'landing', title: 'Autumn', slug: 'autumn', summary: 'Autumn sale' }));
    const page = pageAt('/lp/autumn')!;
    db.seed('marketing_generation_jobs', [{
      job_type: 'regenerate_page', target_id: page.id, target_path: page.path, idempotency_key: `marketing-page:${page.id}:v:1`,
      payload: { page_id: page.id, path: page.path, version: 1 }, created_by: 'admin-1',
    }]);
    let afterTheArchive: Row | null = null;
    h.duringGeneration = async () => {
      await archivePlatformPage(form({ id: page.id }));
      theTriggersFireOnTheSave(page.id);
      afterTheArchive = structuredClone(pageById(page.id)!);
    };

    const raced = await theCronRuns();

    expect(afterTheArchive).toMatchObject({ status: 'archived', deleted_at: expect.any(String), version: 2, title: 'Autumn' });
    expect(pageById(page.id)).toEqual(afterTheArchive);
    expect(raced).toEqual({ status: 200, body: expect.objectContaining({ claimed: 1, succeeded: 1, failed: 0, ok: true }) });
    expect(jobsFor(page.id)).toEqual([expect.objectContaining({ status: 'succeeded', error: null, result: expect.objectContaining({ superseded: true }) })]);
    expect(db.table('marketing_page_versions')).toEqual([]);
    expect(await theCronRuns()).toEqual({ status: 200, body: expect.objectContaining({ claimed: 0, failed: 0, ok: true }) });
    expect(workerFailures()).toEqual([]);
  });
});

describe('the controls: a regeneration nothing raced, and a page that vanished', () => {
  it('an un-raced regeneration still writes its result, its snapshot and its follow-up jobs', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage();
    const read = structuredClone(mirror);
    const expected = buildDeterministicMarketingPage(read as never);

    const run = await theCronRuns();

    expect(run).toEqual({ status: 200, body: expect.objectContaining({ claimed: 1, succeeded: 1, failed: 0, ok: true }) });
    expect(pageById(mirror.id)).toMatchObject({
      version: 2, status: 'published', path: '/lp/spring', updated_by: null,
      title: expected.title, summary: expected.summary, body: expected.body, seo: expected.seo, aeo: expected.aeo,
      content: { ...expected.content, source: 'marketing_landing_pages', source_id: legacy.id },
    });
    expect(jobsFor(mirror.id)[0]).toMatchObject({ status: 'succeeded', result: { pageId: mirror.id, version: 2, source: 'system' } });
    expect(jobsFor(mirror.id)[0].result).not.toHaveProperty('superseded');
    expect(db.table('marketing_page_versions')).toEqual([expect.objectContaining({ page_id: mirror.id, version: 2, title: expected.title, change_source: 'system' })]);
    expect(jobsFor(mirror.id).filter((row) => row.status === 'queued').map((row) => [row.job_type, row.idempotency_key])).toEqual([
      ['generate_questions', `marketing-page:${mirror.id}:v:2:questions`],
      ['embed_page', `marketing-page:${mirror.id}:v:2:embedding`],
    ]);
    expect(workerFailures()).toEqual([]);
  });

  it('a page that vanished between the read and the write is still reported at its own write', async () => {
    const { mirror } = await aPublishedLegacyPage();
    h.duringGeneration = async () => {
      const rows = db.table('marketing_pages');
      rows.splice(rows.findIndex((row) => row.id === mirror.id), 1);
    };

    const run = await theCronRuns();

    expect(run).toEqual({ status: 502, body: expect.objectContaining({ claimed: 1, succeeded: 0, failed: 1, ok: false }) });
    expect(jobsFor(mirror.id)).toEqual([expect.objectContaining({
      status: 'queued', error: `Marketing page ${mirror.id} was not found when saving its regeneration.`,
    })]);
    expect(db.table('marketing_page_versions')).toEqual([]);
  });
});
