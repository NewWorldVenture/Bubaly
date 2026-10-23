// Admin reach round 6: a marketing job whose page moved on while the job was
// queued or running.
//
// The three job runners in lib/marketing/platform.ts (runRegeneration,
// runQuestions, runEmbedding) read the page, work, and write what they built
// from the row as it was READ. Round 5 made the regeneration write only over
// the version it read. This covers what was left:
//
// - RV51-ARCHIVED-PAGE-JOB-DEAD-LETTERS. Each runner read live rows only and
//   threw "Marketing page not found." for an archived one, so every job still
//   queued at an archive (the publish's regeneration behind the create's, the
//   old mirror a legacy rename retires, a page's questions and embedding jobs)
//   failed each cron run, answering 502, until it dead-lettered behind a Retry
//   that could never succeed. Such a job is superseded now, with no failure; a
//   row that is gone is still not found.
// - RV51-QUESTIONS-RENAME-RACE. runQuestions deletes and re-inserts the page's
//   answers by the path it read. A console rename (or archive) landing between
//   that read and the delete retired the answers there first, so the delete
//   removed them and the insert published them again at a path no page holds,
//   on /faq and in the Knowledge Center, for good.
// - F5-EMBED-STALE-CHUNKS. runEmbedding inserts 'ready' chunks of the page as
//   it read it after a model call of up to a minute. A newer version's
//   embedding finishing inside that call (an overlapping cron run) marked
//   stale what it found, and the older chunks landed 'ready' after it.
// - RV61-F5-STALES-A-CHUNK-THE-REGENERATION-RESTORES. That fix marks stale a
//   chunk the page no longer has once its version moved on. A legacy save
//   inside the model call writes the raw legacy text over its mirror, which
//   the regeneration it queued then fills back to the very text embedded; the
//   newer embedding reused the stale row by hash, so the mirror kept no ready
//   chunk. A chunk the page needs that only a stale row holds is ready again,
//   and one deleted before it could be is embedded afresh. All three cases
//   fail on eb7281f1e.
// - RV62-F5-SAME-VERSION-REWRITE. That check compared the text only once the
//   version had moved. The regeneration rewrites a page's text at the version
//   it read and queues that version's embedding, so a run that read the page
//   between a save and its regeneration kept the raw saved text ready beside
//   the regenerated one.
// - RV62-EMBED-OVERLAP-DUPLICATE-KEY. Two overlapping runs needing the same
//   chunk: the second insert hit 0237's unique key, and the cron answered 502
//   for a superseded job until a retry. These three cases fail on 7137727.
//   The round-6 reviewer's revert probe (S3) pins the restore above; it fails
//   on 6c2da65e8 and eb7281f1e.
//
// Driven through the REAL legacy and platform actions, the job worker behind
// the REAL /api/cron/marketing route (CRON_SECRET stubbed), the public /lp
// route and the public AEO reader, against one in-memory database. That
// database runs no triggers, so every admin action here goes through
// `anAdminSaves`, which does what 0237's triggers (version bump, regeneration
// queued) and 0383's (answers retired when a published page is hidden or
// moved) do on the page rows the action wrote: the round-5 reviewer's probe
// approach. The embeddings provider is a stubbed fetch. Each raced or archived
// case fails on 6c2da65e8; the controls pass there and here.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
  /** Runs once, inside a regeneration: after it read the page, before it writes it. */
  duringGeneration: null as null | (() => Promise<void>),
  /** Runs once, inside an embedding's model call: after it read the page, before it inserts its chunks. */
  duringEmbedding: null as null | (() => Promise<void>),
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

const { createLandingPage, setLandingPublished, updateLandingPage, archiveLandingPage } = await import('@/app/(app)/admin/marketing/actions');
const { createPlatformPage, updatePlatformPage, archivePlatformPage } = await import('@/app/(app)/admin/marketing/platform/actions');
const { GET: marketingCron } = await import('@/app/api/cron/marketing/route');
const { default: LandingRoute } = await import('@/app/(marketing)/lp/[slug]/page');
const { readPublishedAeoQuestions } = await import('@/lib/marketing/aeo');

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
const queued = (id: unknown) => jobsFor(id).filter((row) => row.status === 'queued').map((row) => row.job_type);
const answersAt = (path: string, status: string) => db.table('marketing_aeo_questions').filter((row) => row.source_path === path && row.status === status);
const chunksOf = (id: unknown, status: string) => db.table('marketing_embeddings').filter((row) => row.source_id === id && row.status === status);
const workerFailures = () => errors.filter((args) => String(args[0]).startsWith('[marketing-platform] job'));
/** The paths the public Knowledge Center (/faq) cites. */
async function citedOnTheFaq(): Promise<(string | null)[]> {
  const read = await readPublishedAeoQuestions(60);
  expect(read.available).toBe(true);
  return [...new Set(read.questions.map((question) => question.sourcePath))];
}
/** The text runEmbedding embeds for a page: its title, summary and body. */
const embeddedText = (page: Row) => [page.title, page.summary ?? '', page.body ?? ''].filter(Boolean).join('\n\n');

/**
 * The worker's claim (0237's claim_marketing_generation_jobs), served from the
 * table: queued jobs by priority, then age. `run_after` is not modelled, so
 * each invocation here stands for the next one after a failed job's backoff.
 */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  const due = d.table('marketing_generation_jobs')
    .map((row, order) => ({ row, order }))
    .filter(({ row }) => row.status === 'queued')
    .sort((a, b) => Number(b.row.priority) - Number(a.row.priority) || a.order - b.order)
    .slice(0, Number(args.p_limit ?? 10))
    .map(({ row }) => row);
  for (const row of due) { row.status = 'running'; row.attempts = Number(row.attempts ?? 0) + 1; row.locked_at = new Date().toISOString(); }
  return due.map((row) => ({ ...row }));
}

/** The columns 0237's marketing_page_version_on_edit compares. */
const VERSIONED = ['page_type', 'slug', 'path', 'parent_id', 'campaign_id', 'template_id', 'title', 'summary', 'body', 'content', 'seo', 'aeo', 'status', 'published_at', 'deleted_at'];
const live = (page: Row) => page.status === 'published' && page.deleted_at == null;

function queueRegeneration(page: Row) {
  const key = `marketing-page:${page.id}:v:${page.version}`;
  if (db.table('marketing_generation_jobs').some((row) => row.idempotency_key === key)) return;
  db.seed('marketing_generation_jobs', [{
    job_type: 'regenerate_page', target_id: page.id, target_path: page.path, idempotency_key: key,
    payload: { page_id: page.id, path: page.path, version: page.version }, created_by: page.updated_by ?? null,
  }]);
}

/**
 * An admin action, with what the database's triggers do on the page rows it
 * wrote. 0237: an insert queues version 1's regeneration; an admin update that
 * changes a versioned column bumps `version` and, unless it archived the page,
 * queues that version's regeneration. 0383: a published, live page that is
 * hidden or moved has its generated answers retired at both paths, wherever no
 * published live page holds the path.
 */
async function anAdminSaves(action: () => Promise<unknown>): Promise<void> {
  const before = new Map(db.table('marketing_pages').map((row) => [row.id, structuredClone(row)]));
  await action();
  for (const page of db.table('marketing_pages')) {
    const old = before.get(page.id);
    if (!old) { queueRegeneration(page); continue; }
    if (page.updated_by == null || !VERSIONED.some((column) => JSON.stringify(old[column] ?? null) !== JSON.stringify(page[column] ?? null))) continue;
    page.version = Number(old.version) + 1;
    if (page.deleted_at == null) queueRegeneration(page);
    if (live(old) && (!live(page) || old.path !== page.path)) {
      for (const path of new Set([old.path, page.path])) {
        if (db.table('marketing_pages').some((other) => other.path === path && live(other))) continue;
        for (const answer of answersAt(String(path), 'published')) {
          if ((answer.metadata as Row)?.source === 'marketing_platform') Object.assign(answer, { status: 'answered', last_reviewed: new Date().toISOString() });
        }
      }
    }
  }
}

/**
 * Runs `during` once, as runQuestions sends its delete of the page's answers:
 * after it read the page, before the delete reaches the table. Nothing else
 * deletes from marketing_aeo_questions.
 */
function beforeTheNextAnswerDelete(during: () => Promise<void>) {
  type Thenable = { then: (ok: unknown, ko: unknown) => unknown };
  const from = db.from.bind(db);
  let pending: (() => Promise<void>) | null = during;
  (db as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    const builder = from(table) as unknown as { delete: () => Thenable };
    if (table !== 'marketing_aeo_questions') return builder;
    const remove = builder.delete.bind(builder);
    builder.delete = () => {
      const query = remove();
      const race = pending;
      pending = null;
      if (!race) return query;
      const send = query.then.bind(query);
      query.then = (ok, ko) => race().then(() => send(ok, ko));
      return query;
    };
    return builder;
  };
}

/**
 * Runs `during` once, as runEmbedding sends its update making a page's stale
 * chunks ready again: after it read them, before the update reaches the table.
 * Nothing else sets a chunk 'ready' by update.
 */
function beforeTheNextChunkRestore(during: () => void) {
  type Thenable = { then: (ok: unknown, ko: unknown) => unknown };
  const from = db.from.bind(db);
  let pending: (() => void) | null = during;
  (db as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    const builder = from(table) as unknown as { update: (values: Row) => Thenable };
    if (table !== 'marketing_embeddings') return builder;
    const update = builder.update.bind(builder);
    builder.update = (values: Row) => {
      const query = update(values);
      const race = pending;
      if (values.status !== 'ready' || !race) return query;
      pending = null;
      const send = query.then.bind(query);
      query.then = (ok, ko) => { race(); return send(ok, ko); };
      return query;
    };
    return builder;
  };
}

/** One Vercel Cron invocation of /api/cron/marketing. */
async function theCronRuns() {
  const res = await marketingCron(new NextRequest('https://fixture.invalid/api/cron/marketing', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  return { status: res.status, body: await res.json() as { claimed: number; succeeded: number; failed: number; deadLettered: number; ok: boolean } };
}
/** Cron invocations until nothing is left to claim (at most eight). */
async function theCronDrainsTheQueue() {
  const runs: Awaited<ReturnType<typeof theCronRuns>>[] = [];
  for (let round = 0; round < 8; round++) {
    const run = await theCronRuns();
    if (!run.body.claimed) break;
    runs.push(run);
  }
  return runs;
}
const cleanRun = { status: 200, body: expect.objectContaining({ failed: 0, deadLettered: 0, ok: true }) };

/** A published legacy page at /lp/<slug>; the create's and the publish's regenerations are queued. */
async function aPublishedLegacyPage(slug = 'spring'): Promise<{ legacy: Row; mirror: Row }> {
  await anAdminSaves(() => createLandingPage(form({ title: 'Spring', slug, headline: 'Legacy spring' })));
  const legacy = db.table('marketing_landing_pages').find((row) => row.slug === slug)!;
  await anAdminSaves(() => setLandingPublished(form({ id: legacy.id, publish: '1' })));
  const mirror = pageAt(`/lp/${slug}`)!;
  expect(mirror).toMatchObject({ status: 'published', version: 2, content: { source: 'marketing_landing_pages', source_id: legacy.id } });
  expect(queued(mirror.id)).toEqual(['regenerate_page', 'regenerate_page']);
  return { legacy, mirror };
}

/** A console page at /lp/<slug>, created and published; both regenerations are queued. */
async function aPublishedConsolePage(slug: string, fields: Record<string, string> = {}): Promise<Row> {
  const text = { title: 'Winter', summary: 'Winter planning for the whole family.', ...fields };
  await anAdminSaves(() => createPlatformPage(form({ page_type: 'landing', slug, ...text })));
  const page = pageAt(`/lp/${slug}`)!;
  await anAdminSaves(() => updatePlatformPage(form({ id: page.id, page_type: 'landing', slug, ...text, status: 'published' })));
  expect(page).toMatchObject({ status: 'published', version: 2 });
  return page;
}
/**
 * The console's edit form, posted with what it renders for the page now, and
 * `changes`. The form stamps a published page's `published_at` afresh, so it
 * is posted after the millisecond of the last stamp: a save inside that same
 * millisecond changes no column 0237 compares, which no admin's next save does.
 */
async function theConsoleSaves(page: Row, changes: Record<string, string> = {}) {
  while (page.published_at && Date.now() <= Date.parse(String(page.published_at))) await new Promise((resolve) => setTimeout(resolve, 1));
  return anAdminSaves(() => updatePlatformPage(form({
    id: page.id, page_type: 'landing', slug: page.slug, title: page.title, summary: page.summary ?? '', body: page.body ?? '', status: page.status, ...changes,
  })));
}

/** OpenAI's embeddings endpoint: one 1536-dimension vector per input. */
async function theEmbeddingsProvider(url: unknown, init?: RequestInit): Promise<Response> {
  expect(String(url)).toBe('https://api.openai.com/v1/embeddings');
  const during = h.duringEmbedding;
  h.duringEmbedding = null;
  if (during) await during();
  const { input } = JSON.parse(String(init?.body)) as { input: string[] };
  return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, () => 0.01) })) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  vi.stubEnv('OPENAI_API_KEY', 'sk-fixture');
  vi.stubGlobal('fetch', vi.fn(theEmbeddingsProvider));
  db = createInMemorySupabase({
    uniques: {
      marketing_pages: [['path']], marketing_landing_pages: [['slug']], blog_posts: [['slug']],
      marketing_generation_jobs: [['idempotency_key']], marketing_page_versions: [['page_id', 'version']],
      marketing_embeddings: [['source_type', 'source_id', 'chunk_index', 'content_hash']],
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
  h.duringEmbedding = null;
  for (const table of ['marketing_pages', 'marketing_landing_pages', 'marketing_aeo_questions', 'marketing_generation_jobs', 'marketing_page_versions',
    'marketing_content_templates', 'marketing_brand_rules', 'marketing_embeddings', 'app_settings', 'blog_posts']) db.seed(table, []);
  errors = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('RV51-ARCHIVED-PAGE-JOB-DEAD-LETTERS: a job queued before its page was archived finishes, with no failure', () => {
  it('the publish’s regeneration, queued behind the create’s, when the legacy page is archived inside the first one', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage();
    const [createJob, publishJob] = jobsFor(mirror.id);
    h.duringGeneration = async () => { await anAdminSaves(() => archiveLandingPage(form({ id: legacy.id }))); };

    const runs = await theCronDrainsTheQueue();

    expect(runs).toEqual([cleanRun]);
    expect(runs[0].body).toMatchObject({ claimed: 2, succeeded: 2 });
    expect(createJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { superseded: true } });
    expect(publishJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { pageId: mirror.id, superseded: true, archived: true } });
    expect(workerFailures()).toEqual([]);
    expect(pageById(mirror.id)).toMatchObject({ status: 'archived', deleted_at: expect.any(String), title: 'Legacy spring' });
    expect(db.table('marketing_page_versions')).toEqual([]);
    expect(queued(mirror.id)).toEqual([]);
    expect(await visit('spring')).toBe('not found');
  });

  it('the old mirror’s regeneration, when a legacy rename retires that mirror before the cron reaches it', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage();
    expect(await theCronDrainsTheQueue()).toEqual(expect.arrayContaining([cleanRun]));
    await anAdminSaves(() => updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'spring', headline: 'Fresh headline' })));
    const editJob = jobsFor(mirror.id).find((row) => row.status === 'queued')!;
    expect(editJob).toMatchObject({ job_type: 'regenerate_page', payload: { version: 3 } });
    await anAdminSaves(() => updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'summer', headline: 'Fresh headline' })));
    const retired = structuredClone(pageById(mirror.id)!);
    expect(retired).toMatchObject({ path: '/lp/spring', status: 'archived', deleted_at: expect.any(String) });

    const runs = await theCronDrainsTheQueue();

    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(editJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { pageId: mirror.id, superseded: true, archived: true } });
    expect(workerFailures()).toEqual([]);
    expect(pageById(mirror.id)).toEqual(retired);
    expect(pageAt('/lp/summer')).toMatchObject({ status: 'published', title: 'Fresh headline', content: { source: 'marketing_landing_pages', source_id: legacy.id, sections: expect.any(Array) } });
    expect(await visit('summer')).toBe('legacy page');
    expect(await visit('spring')).toBe('not found');
  });

  it('a page’s questions and embedding jobs, when the console archives the page before the cron reaches them', async () => {
    const page = await aPublishedConsolePage('autumn');
    expect(await theCronRuns()).toEqual(cleanRun);
    expect(queued(page.id)).toEqual(['generate_questions', 'embed_page']);
    const [questionsJob, embeddingJob] = jobsFor(page.id).filter((row) => row.status === 'queued');
    await anAdminSaves(() => archivePlatformPage(form({ id: page.id })));

    const runs = await theCronDrainsTheQueue();

    expect(runs).toEqual([cleanRun]);
    expect(questionsJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { pageId: page.id, superseded: true, archived: true } });
    expect(embeddingJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { pageId: page.id, superseded: true, archived: true } });
    expect(workerFailures()).toEqual([]);
    expect(db.table('marketing_aeo_questions')).toEqual([]);
    expect(db.table('marketing_embeddings')).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await visit('autumn')).toBe('not found');
  });

  it('control: a job whose page row is gone is still reported, as not found', async () => {
    const page = await aPublishedConsolePage('gone');
    const rows = db.table('marketing_pages');
    rows.splice(rows.indexOf(page), 1);

    const run = await theCronRuns();

    expect(run).toEqual({ status: 502, body: expect.objectContaining({ claimed: 2, succeeded: 0, failed: 2, ok: false }) });
    expect(jobsFor(page.id)).toEqual([
      expect.objectContaining({ status: 'queued', error: 'Marketing page not found.' }),
      expect.objectContaining({ status: 'queued', error: 'Marketing page not found.' }),
    ]);
  });
});

describe('RV51-QUESTIONS-RENAME-RACE: a questions run never publishes answers at a path its page has left', () => {
  /** A published console page at /lp/q1 whose answers are out, then an edit whose questions job is queued. */
  async function aPageWhoseNextQuestionsRunIsQueued(): Promise<Row> {
    const page = await aPublishedConsolePage('q1', { title: 'Quiet hours' });
    await theCronDrainsTheQueue();
    expect(answersAt('/lp/q1', 'published')).toHaveLength(3);
    await theConsoleSaves(page, { summary: 'Quiet hours, kept by the whole family.' });
    expect(await theCronRuns()).toEqual(cleanRun);
    expect(queued(page.id)).toEqual(['generate_questions', 'embed_page']);
    return page;
  }

  it('a console rename landing between its read and its delete leaves nothing published at the old path', async () => {
    const page = await aPageWhoseNextQuestionsRunIsQueued();
    beforeTheNextAnswerDelete(() => theConsoleSaves(page, { slug: 'q2' }));

    const runs = await theCronDrainsTheQueue();

    expect(page.path).toBe('/lp/q2');
    expect(answersAt('/lp/q1', 'published')).toEqual([]);
    expect(answersAt('/lp/q1', 'answered')).toHaveLength(3);
    expect(answersAt('/lp/q2', 'published')).toHaveLength(3);
    expect(await citedOnTheFaq()).toEqual(['/lp/q2']);
    expect(await visit('q1')).toBe('not found');
    expect(await visit('q2')).toBe('platform page');
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(jobsFor(page.id).find((row) => row.job_type === 'generate_questions' && (row.result as Row).superseded))
      .toMatchObject({ status: 'succeeded', error: null, result: { pageId: page.id, questions: 3, retired: 3 } });
  });

  it('a console archive landing between its read and its delete leaves nothing published for the page', async () => {
    const page = await aPageWhoseNextQuestionsRunIsQueued();
    beforeTheNextAnswerDelete(() => anAdminSaves(() => archivePlatformPage(form({ id: page.id }))));

    const runs = await theCronDrainsTheQueue();

    expect(page).toMatchObject({ status: 'archived', deleted_at: expect.any(String) });
    expect(answersAt('/lp/q1', 'published')).toEqual([]);
    expect(answersAt('/lp/q1', 'answered')).toHaveLength(3);
    expect(await citedOnTheFaq()).toEqual([]);
    expect(await visit('q1')).toBe('not found');
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
  });

  it('control: a questions run nothing raced publishes the page’s answers at its path and takes nothing back', async () => {
    const page = await aPageWhoseNextQuestionsRunIsQueued();

    const runs = await theCronDrainsTheQueue();

    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(answersAt('/lp/q1', 'published').map((row) => row.answer)).toEqual(Array(3).fill('Quiet hours, kept by the whole family.'));
    expect(answersAt('/lp/q1', 'answered')).toEqual([]);
    expect(await citedOnTheFaq()).toEqual(['/lp/q1']);
    const runsOfQuestions = jobsFor(page.id).filter((row) => row.job_type === 'generate_questions');
    expect(runsOfQuestions.map((row) => row.result)).toEqual([{ pageId: page.id, questions: 3 }, { pageId: page.id, questions: 3 }]);
  });
});

describe('F5-EMBED-STALE-CHUNKS: only the page as it now stands keeps ready chunks', () => {
  /** A published console page whose first chunks are in, then an edit whose embedding job is queued. */
  async function aPageWhoseNextEmbeddingIsQueued(): Promise<Row> {
    const page = await aPublishedConsolePage('winter');
    for (const run of await theCronDrainsTheQueue()) expect(run).toEqual(cleanRun);
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    await theConsoleSaves(page, { summary: 'Winter planning, revised.' });
    expect(await theCronRuns()).toEqual(cleanRun);
    expect(queued(page.id)).toEqual(['generate_questions', 'embed_page']);
    return page;
  }

  it('a newer version embedded by an overlapping cron run inside its model call', async () => {
    const page = await aPageWhoseNextEmbeddingIsQueued();
    const read = embeddedText(page);
    const olderJob = jobsFor(page.id).find((row) => row.job_type === 'embed_page' && row.status === 'queued')!;
    let inner: Awaited<ReturnType<typeof theCronDrainsTheQueue>> = [];
    h.duringEmbedding = async () => {
      await theConsoleSaves(page, { summary: 'Winter planning, final.' });
      inner = await theCronDrainsTheQueue();
      expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    };

    const outer = await theCronRuns();

    expect(page).toMatchObject({ version: 4, summary: 'Winter planning, final.' });
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(chunksOf(page.id, 'stale').map((row) => row.content)).toContain(read);
    for (const run of [...inner, outer]) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(olderJob).toMatchObject({ status: 'succeeded', error: null, result: { pageId: page.id, embedded: 1, superseded: true, staled: 1 } });
  });

  it('control: a save that leaves the text as it is, inside its model call, keeps its chunks ready', async () => {
    const page = await aPageWhoseNextEmbeddingIsQueued();
    const read = embeddedText(page);
    h.duringEmbedding = async () => { await theConsoleSaves(page); };

    const runs = [await theCronRuns(), ...await theCronDrainsTheQueue()];

    expect(page).toMatchObject({ version: 4 });
    expect(embeddedText(page)).toBe(read);
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([read]);
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
  });

  // RV61-F5-STALES-A-CHUNK-THE-REGENERATION-RESTORES. A legacy save writes the
  // legacy page's raw text over its mirror (an empty subhead and body are
  // null), so a mirror embedded inside that save no longer has the chunk this
  // run embedded, and it is marked stale. The regeneration the save queued
  // fills those fields as it did before, so the newer version's embedding needs
  // exactly that chunk again; it reused the stale row by hash and inserted
  // nothing, leaving the page no ready chunk at all. No overlapping cron run.
  it('a legacy save inside its model call that the regeneration undoes leaves the mirror its chunk ready', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage('lent');
    let asSaved = '';
    h.duringEmbedding = async () => {
      await anAdminSaves(() => updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'lent', headline: 'Legacy spring' })));
      asSaved = embeddedText(pageById(mirror.id)!);
    };

    const runs = await theCronDrainsTheQueue();

    const page = pageById(mirror.id)!;
    expect(page).toMatchObject({ version: 3, status: 'published', deleted_at: null });
    expect(asSaved).not.toBe(embeddedText(page));
    expect(chunksOf(mirror.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(chunksOf(mirror.id, 'stale')).toEqual([]);
    expect(db.table('marketing_embeddings')).toHaveLength(1);
    const [olderJob, newerJob] = jobsFor(mirror.id).filter((row) => row.job_type === 'embed_page');
    expect(olderJob).toMatchObject({ status: 'succeeded', error: null, result: { pageId: mirror.id, embedded: 1, superseded: true, staled: 1 } });
    expect(newerJob).toMatchObject({ status: 'succeeded', error: null, result: { pageId: mirror.id, embedded: 0, reused: 1, restored: 1 } });
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(await visit('lent')).toBe('legacy page');
  });

  it('a legacy unpublish inside its model call, then a republish, leaves the mirror its chunk ready', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage('lent');
    h.duringEmbedding = async () => { await anAdminSaves(() => setLandingPublished(form({ id: legacy.id, publish: '0' }))); };
    const whileHidden = await theCronDrainsTheQueue();
    expect(await visit('lent')).toBe('not found');

    await anAdminSaves(() => setLandingPublished(form({ id: legacy.id, publish: '1' })));
    const republished = await theCronDrainsTheQueue();

    const page = pageById(mirror.id)!;
    expect(page).toMatchObject({ status: 'published', deleted_at: null });
    expect(chunksOf(mirror.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(chunksOf(mirror.id, 'stale')).toEqual([]);
    for (const run of [...whileHidden, ...republished]) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(await visit('lent')).toBe('legacy page');
  });

  it('a stale chunk deleted before it is made ready again is embedded afresh', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage('lent');
    h.duringEmbedding = async () => {
      await anAdminSaves(() => updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 'lent', headline: 'Legacy spring' })));
    };
    beforeTheNextChunkRestore(() => { db.table('marketing_embeddings').splice(0); });

    const runs = await theCronDrainsTheQueue();

    const page = pageById(mirror.id)!;
    expect(chunksOf(mirror.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(db.table('marketing_embeddings')).toHaveLength(1);
    const [, newerJob] = jobsFor(mirror.id).filter((row) => row.job_type === 'embed_page');
    expect(newerJob).toMatchObject({ status: 'succeeded', error: null, result: { pageId: mirror.id, chunks: 1, embedded: 1, reused: 0 } });
    expect(newerJob.result).not.toHaveProperty('restored');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
  });

  // RV62-F5-SAME-VERSION-REWRITE. One cron run claims a page's questions and
  // embedding jobs; a save lands while it is on the questions job, so its
  // embedding reads the page at the saved version holding the saved text, not
  // yet regenerated. Inside that embedding's model call the queue drains: the
  // save's regeneration fills the text back IN PLACE, at the same version, and
  // that version's embedding inserts the filled text's chunk. The older run
  // then inserts the chunk of the text it read. The version never moved.
  it('a legacy save read before its regeneration leaves only the regenerated text ready', async () => {
    const { legacy, mirror } = await aPublishedLegacyPage('s1');
    expect(await theCronRuns()).toEqual(cleanRun);
    expect(queued(mirror.id)).toEqual(['generate_questions', 'embed_page']);
    beforeTheNextAnswerDelete(() => anAdminSaves(() => updateLandingPage(form({ id: legacy.id, title: 'Spring', slug: 's1', headline: 'Legacy spring' }))));
    let read = '';
    let inner: Awaited<ReturnType<typeof theCronDrainsTheQueue>> = [];
    h.duringEmbedding = async () => {
      read = embeddedText(pageById(mirror.id)!);
      inner = await theCronDrainsTheQueue();
    };

    const outer = await theCronRuns();

    const page = pageById(mirror.id)!;
    expect(page).toMatchObject({ version: 3, status: 'published', deleted_at: null });
    expect(read).toBe('Legacy spring');
    expect(embeddedText(page)).not.toBe(read);
    expect(chunksOf(mirror.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(chunksOf(mirror.id, 'stale').map((row) => row.content)).toEqual([read]);
    for (const run of [...inner, outer]) expect(run).toEqual(cleanRun);
    expect(queued(mirror.id)).toEqual([]);
    expect(workerFailures()).toEqual([]);
    const [olderJob, newerJob] = jobsFor(mirror.id).filter((row) => row.job_type === 'embed_page');
    expect(olderJob).toMatchObject({ status: 'succeeded', error: null, payload: { version: 2 }, result: { pageId: mirror.id, embedded: 1, superseded: true, staled: 1 } });
    expect(newerJob).toMatchObject({ status: 'succeeded', error: null, payload: { version: 3 }, result: { pageId: mirror.id, embedded: 1, reused: 0 } });
    expect(await visit('s1')).toBe('legacy page');
  });

  it('a console save with the body cleared, read before its regeneration, leaves only the regenerated text ready', async () => {
    const page = await aPublishedConsolePage('s2');
    expect(await theCronRuns()).toEqual(cleanRun);
    expect(queued(page.id)).toEqual(['generate_questions', 'embed_page']);
    beforeTheNextAnswerDelete(() => theConsoleSaves(page, { summary: 'Winter planning, revised.', body: '' }));
    let read = '';
    let inner: Awaited<ReturnType<typeof theCronDrainsTheQueue>> = [];
    h.duringEmbedding = async () => {
      read = embeddedText(page);
      inner = await theCronDrainsTheQueue();
    };

    const outer = await theCronRuns();

    expect(page).toMatchObject({ version: 3, summary: 'Winter planning, revised.' });
    expect(read).toBe('Winter\n\nWinter planning, revised.');
    expect(embeddedText(page)).not.toBe(read);
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([embeddedText(page)]);
    expect(chunksOf(page.id, 'stale').map((row) => row.content)).toEqual([read]);
    for (const run of [...inner, outer]) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
  });

  // RV62-EMBED-OVERLAP-DUPLICATE-KEY. A save that leaves the text as it is
  // lands inside an embedding's model call, and an overlapping cron run drains
  // the queue: the save's version embeds that very chunk first.
  it('an overlapping run that inserts the same chunk first leaves the older run nothing to fail on', async () => {
    const page = await aPageWhoseNextEmbeddingIsQueued();
    const read = embeddedText(page);
    const olderJob = jobsFor(page.id).find((row) => row.job_type === 'embed_page' && row.status === 'queued')!;
    let inner: Awaited<ReturnType<typeof theCronDrainsTheQueue>> = [];
    h.duringEmbedding = async () => {
      await theConsoleSaves(page);
      inner = await theCronDrainsTheQueue();
    };

    const outer = await theCronRuns();

    expect(page).toMatchObject({ version: 4 });
    expect(embeddedText(page)).toBe(read);
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([read]);
    expect(db.table('marketing_embeddings').filter((row) => row.content === read)).toHaveLength(1);
    for (const run of [...inner, outer]) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(olderJob).toMatchObject({ status: 'succeeded', error: null, attempts: 1, result: { pageId: page.id, chunks: 1, embedded: 0, reused: 0, skipped: 1 } });
    expect(olderJob.result).not.toHaveProperty('superseded');
    const newerJob = jobsFor(page.id).filter((row) => row.job_type === 'embed_page').at(-1)!;
    expect(newerJob).toMatchObject({ status: 'succeeded', payload: { version: 4 }, result: { pageId: page.id, chunks: 1, embedded: 1 } });
    expect(newerJob.result).not.toHaveProperty('skipped');
    expect(queued(page.id)).toEqual([]);
  });

  // The round-6 reviewer's probe S3, kept as a case: no race at all. The
  // revert's embedding reused the stale row by hash before 7137727.
  it('control: a console page edited to new text and back keeps exactly one ready chunk', async () => {
    const page = await aPublishedConsolePage('s3', { body: 'First body.' });
    const runs = await theCronDrainsTheQueue();
    const first = embeddedText(page);
    await theConsoleSaves(page, { body: 'Second body.' });
    runs.push(...await theCronDrainsTheQueue());
    const second = embeddedText(page);
    await theConsoleSaves(page, { body: 'First body.' });
    runs.push(...await theCronDrainsTheQueue());

    expect(page).toMatchObject({ version: 4, body: 'First body.' });
    expect(embeddedText(page)).toBe(first);
    expect(chunksOf(page.id, 'ready').map((row) => row.content)).toEqual([first]);
    expect(chunksOf(page.id, 'stale').map((row) => row.content)).toEqual([second]);
    for (const run of runs) expect(run).toEqual(cleanRun);
    expect(workerFailures()).toEqual([]);
    expect(jobsFor(page.id).filter((row) => row.job_type === 'embed_page').at(-1))
      .toMatchObject({ status: 'succeeded', result: { pageId: page.id, chunks: 1, embedded: 0, reused: 1, restored: 1 } });
  });
});
