// Register B, group API-2: GET /api/cron/marketing (API-B7C1506769BC) and its
// job (JOB-1C0E9374DE2E), driven through the REAL exported route over a
// populated in-memory database.
//
// Marketing data is not family-scoped: there are no households here. The
// ownership key of every row this worker writes is the marketing PAGE a job
// targets (`target_id`, and the page's `path` for its AEO answers,
// `source_id` for its embedding chunks, `page_id` for its version snapshots).
// "Isolation" below therefore means: a job for page A never writes, deletes or
// stales a row that belongs to page B.
//
// What the neighbouring tests already prove, and this file does not repeat:
// - a-marketing-job-for-a-page-that-moved-on-leaves-nothing-behind: jobs for a
//   page archived, renamed or re-saved while queued/running (supersede, no
//   failure), questions rename race, embedding stale/restore races, overlap
//   duplicate key.
// - a-regeneration-never-writes-over-a-newer-save: the version-guarded write.
// - a-regenerated-mirror-still-belongs-to-its-legacy-page: provenance keys.
// - marketing-platform-spine: source-text contract (auth guard present, claim
//   RPC grant, persistence-failure strings).
// - cron-dispatch*, a-cron-cadence-*, a-late-tick-*: scheduling only.
// None of them seeds rows the worker must leave alone (another worker's
// running job, a backoff, a dead letter, a finished job), recovers a stale
// lock, reads tables back per page, runs the queue dry a third time, or pins
// the 502/500 mapping of a failed read, a dead letter, a failed claim or an
// unpersistable failure.
//
// The claim RPC is served from the table exactly as 0237's
// claim_marketing_generation_jobs does it: stale `running` rows (lock older
// than 15 minutes) go back to `queued` (or `dead_letter` when out of
// attempts) with run_after = now(); then queued rows whose run_after has come,
// by priority desc then created_at, limited to greatest(1, least(p_limit, 50)),
// are flipped to running with attempts + 1, locked_at/started_at = now(). The
// handler runs synchronously, so two overlapping invocations can never claim
// the same row, which is what FOR UPDATE SKIP LOCKED guarantees.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  claims: [] as Record<string, unknown>[],
  claimFails: false,
}));
const service = vi.hoisted(() => ({ createServiceClient: vi.fn(() => h.db) }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const ai = vi.hoisted(() => ({ isAIConfigured: vi.fn(async () => false), resolveProvider: vi.fn(async () => { throw new Error('no provider in tests'); }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: service.createServiceClient }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: cache.revalidatePath, revalidateTag: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: ai.isAIConfigured, resolveProvider: ai.resolveProvider }));

const { GET } = await import('@/app/api/cron/marketing/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-11-12T10:00:00.000Z';
const minutes = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString();

const PAGE_A = '00000000-0000-4000-8000-0000000000a1'; // published, live
const PAGE_B = '00000000-0000-4000-8000-0000000000b1'; // draft, live
const PAGE_C = '00000000-0000-4000-8000-0000000000c1'; // archived
const PAGE_D = '00000000-0000-4000-8000-0000000000d1'; // no job queued for it
const GONE = '00000000-0000-4000-8000-0000000000e1'; // no page row at all

const JOB_REGEN_A = '00000000-0000-4000-8000-000000000101';
const JOB_REGEN_B = '00000000-0000-4000-8000-000000000102';
const JOB_REGEN_C = '00000000-0000-4000-8000-000000000103';
const JOB_STALE_SITEMAP = '00000000-0000-4000-8000-000000000104';
const JOB_OTHER_WORKER = '00000000-0000-4000-8000-000000000105';
const JOB_BACKOFF = '00000000-0000-4000-8000-000000000106';
const JOB_DEAD = '00000000-0000-4000-8000-000000000107';
const JOB_DONE = '00000000-0000-4000-8000-000000000108';

let db: InMemorySupabase;

/** 0237's claim_marketing_generation_jobs, over the backing table. */
function claim(args: Record<string, unknown>, d: InMemorySupabase): Row[] {
  h.claims.push(args);
  if (h.claimFails) throw new Error('could not serialize access due to concurrent update');
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const jobs = d.table('marketing_generation_jobs');
  for (const row of jobs) {
    if (row.status !== 'running' || row.locked_at == null || Date.parse(String(row.locked_at)) >= now - 15 * 60_000) continue;
    row.status = Number(row.attempts) >= Number(row.max_attempts) ? 'dead_letter' : 'queued';
    row.locked_at = null;
    row.run_after = nowIso;
    row.error = row.error ?? 'Recovered after a stale worker lock.';
  }
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10) || 10, 50));
  const due = jobs
    .filter((row) => row.status === 'queued' && Date.parse(String(row.run_after)) <= now)
    .sort((a, b) => Number(b.priority) - Number(a.priority) || Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)))
    .slice(0, limit);
  for (const row of due) Object.assign(row, { status: 'running', attempts: Number(row.attempts) + 1, locked_at: nowIso, started_at: nowIso, updated_at: nowIso });
  return due.map((row) => ({ ...row }));
}

function freshDb(): InMemorySupabase {
  return createInMemorySupabase({
    uniques: {
      marketing_generation_jobs: [['idempotency_key']],
      marketing_page_versions: [['page_id', 'version']],
      marketing_embeddings: [['source_type', 'source_id', 'chunk_index', 'content_hash']],
    },
    uuidColumns: {
      marketing_generation_jobs: ['id', 'target_id'],
      marketing_page_versions: ['page_id'],
      marketing_embeddings: ['source_id'],
    },
    defaults: {
      marketing_generation_jobs: {
        target_type: 'marketing_page', status: 'queued', priority: 50, attempts: 0, max_attempts: 5,
        run_after: NOW, locked_at: null, started_at: null, completed_at: null, payload: {}, result: {}, error: null, created_by: null,
      },
    },
    rpc: { claim_marketing_generation_jobs: claim },
  });
}

function page(id: string, fields: Row): Row {
  return {
    id, page_type: 'feature', parent_id: null, content: { source: 'platform_console' }, seo: {}, aeo: {},
    status: 'published', published_at: minutes(-1440), deleted_at: null, updated_by: null, version: 1, ...fields,
  };
}

function job(id: string, fields: Row): Row {
  return { id, target_type: 'marketing_page', status: 'queued', priority: 50, attempts: 0, max_attempts: 5, run_after: minutes(-1), locked_at: null, started_at: null, completed_at: null, payload: {}, result: {}, error: null, created_by: null, ...fields };
}

/**
 * Pages A, B (to act on), C (archived) and D (untouched), with their queue:
 * a regeneration each for A, B, C; a sitemap job whose worker died 20 minutes
 * ago; and rows the run must leave alone — another worker's fresh lock, a job
 * in backoff, a dead letter, and a finished job.
 */
function seedWorld() {
  db.seed('marketing_pages', [
    page(PAGE_A, { path: '/features/alpha', slug: 'alpha', title: 'Alpha planner', summary: 'Alpha summary.', body: 'Alpha body text.', version: 3 }),
    page(PAGE_B, { page_type: 'guide', path: '/guides/beta', slug: 'beta', title: 'Beta guide', summary: 'Beta summary.', body: 'Beta body text.', status: 'draft', published_at: null }),
    page(PAGE_C, { path: '/features/gamma', slug: 'gamma', title: 'Gamma', summary: 'Gamma summary.', body: 'Gamma body.', deleted_at: minutes(-30), version: 2 }),
    page(PAGE_D, { path: '/features/delta', slug: 'delta', title: 'Delta', summary: 'Delta summary.', body: 'Delta body.' }),
  ]);
  db.seed('marketing_generation_jobs', [
    job(JOB_REGEN_A, { job_type: 'regenerate_page', target_id: PAGE_A, target_path: '/features/alpha', idempotency_key: `marketing-page:${PAGE_A}:v:3`, created_at: minutes(-10) }),
    job(JOB_REGEN_B, { job_type: 'regenerate_page', target_id: PAGE_B, target_path: '/guides/beta', idempotency_key: `marketing-page:${PAGE_B}:v:1`, created_at: minutes(-9) }),
    job(JOB_REGEN_C, { job_type: 'regenerate_page', target_id: PAGE_C, target_path: '/features/gamma', idempotency_key: `marketing-page:${PAGE_C}:v:2`, created_at: minutes(-8) }),
    job(JOB_STALE_SITEMAP, { job_type: 'sitemap_sync', target_type: 'sitemap', target_id: null, idempotency_key: 'sitemap:2026-11-12', status: 'running', attempts: 1, locked_at: minutes(-20), started_at: minutes(-20), created_at: minutes(-25) }),
    job(JOB_OTHER_WORKER, { job_type: 'regenerate_page', target_id: PAGE_D, target_path: '/features/delta', idempotency_key: `marketing-page:${PAGE_D}:v:1`, status: 'running', attempts: 1, locked_at: minutes(-5), started_at: minutes(-5), created_at: minutes(-30) }),
    job(JOB_BACKOFF, { job_type: 'regenerate_page', target_id: PAGE_D, target_path: '/features/delta', idempotency_key: `marketing-page:${PAGE_D}:v:0`, attempts: 2, run_after: minutes(60), error: 'earlier failure', created_at: minutes(-40) }),
    job(JOB_DEAD, { job_type: 'regenerate_page', target_id: PAGE_D, target_path: '/features/delta', idempotency_key: `marketing-page:${PAGE_D}:dead`, status: 'dead_letter', attempts: 5, error: 'gave up', created_at: minutes(-50) }),
    job(JOB_DONE, { job_type: 'regenerate_page', target_id: PAGE_A, target_path: '/features/alpha', idempotency_key: `marketing-page:${PAGE_A}:v:2`, status: 'succeeded', attempts: 1, completed_at: minutes(-60), result: { pageId: PAGE_A, version: 2 }, created_at: minutes(-70) }),
  ]);
  // Page D's own answers and chunk, and a blog-seeded answer at page B's path.
  db.seed('marketing_aeo_questions', [
    { question: 'What is Delta?', answer: 'Delta summary.', entity: 'Delta', source_path: '/features/delta', pattern: 'faq', status: 'published', metadata: { source: 'marketing_platform', page_id: PAGE_D } },
    { question: 'Blog seed at beta', answer: 'Seeded.', entity: 'Beta', source_path: '/guides/beta', pattern: 'faq', status: 'published', metadata: { seed: 'blog_aeo_v1' } },
  ]);
  db.seed('marketing_embeddings', [
    { source_type: 'page', source_id: PAGE_D, chunk_index: 0, content_hash: 'delta-hash', content: 'Delta', model: 'text-embedding-3-small', dimensions: 1536, status: 'ready' },
    { source_type: 'page', source_id: PAGE_B, chunk_index: 0, content_hash: 'beta-old-hash', content: 'Old beta text', model: 'text-embedding-3-small', dimensions: 1536, status: 'ready' },
  ]);
}

const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
  return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, () => 0.001) })) }), { status: 200, headers: { 'content-type': 'application/json' } });
});

async function call(authorization?: string, query = '') {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  const res = await GET(new NextRequest(`https://cron.example.com/api/cron/marketing${query}`, { headers }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const run = (query = '') => call(`Bearer ${SECRET}`, query);

const jobRow = (id: string) => db.table('marketing_generation_jobs').find((row) => row.id === id)!;
const jobsFor = (pageId: string) => db.table('marketing_generation_jobs').filter((row) => row.target_id === pageId);
const versionsOf = (pageId: string) => db.table('marketing_page_versions').filter((row) => row.page_id === pageId);
const answersAt = (path: string) => db.table('marketing_aeo_questions').filter((row) => row.source_path === path);
const chunksOf = (pageId: string) => db.table('marketing_embeddings').filter((row) => row.source_id === pageId);
const pageRow = (id: string) => db.table('marketing_pages').find((row) => row.id === id)!;
const snapshot = () => JSON.stringify(['marketing_pages', 'marketing_generation_jobs', 'marketing_page_versions', 'marketing_aeo_questions', 'marketing_embeddings'].map((t) => db.table(t)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('OPENAI_API_KEY', 'sk-test-not-real');
  vi.stubGlobal('fetch', fetchStub);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db = freshDb();
  h.db = db;
  h.claims = [];
  h.claimFails = false;
  service.createServiceClient.mockClear();
  cache.revalidatePath.mockClear();
  fetchStub.mockClear();
  ai.isAIConfigured.mockClear();
  seedWorld();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authorization comes before any read', () => {
  it('API-B7C1506769BC JOB-1C0E9374DE2E: no Authorization header answers 401 and touches neither the database nor a provider', async () => {
    const before = snapshot();
    const res = await call();
    expect(res).toEqual({ status: 401, body: { error: 'marketing.unauthorized' } });
    expect(service.createServiceClient).not.toHaveBeenCalled();
    expect(h.claims).toEqual([]);
    expect(db.log).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(ai.isAIConfigured).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: a wrong Bearer secret answers 401 and touches neither the database nor a provider', async () => {
    const before = snapshot();
    const res = await call('Bearer not-the-cron-secret');
    expect(res).toEqual({ status: 401, body: { error: 'marketing.unauthorized' } });
    expect(service.createServiceClient).not.toHaveBeenCalled();
    expect(h.claims).toEqual([]);
    expect(db.log).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: the right secret claims through the RPC with the default limit of 10', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(service.createServiceClient).toHaveBeenCalledTimes(1);
    expect(h.claims).toEqual([{ p_limit: 10 }]);
  });
});

describe('a run over a populated queue', () => {
  it('API-B7C1506769BC JOB-1C0E9374DE2E: claims only due work, recovers a stale lock, regenerates the live pages and supersedes the archived one', async () => {
    const res = await run();
    expect(res).toEqual({ status: 200, body: { claimed: 4, succeeded: 4, failed: 0, deadLettered: 0, persistenceFailed: 0, ok: true } });

    // The four due jobs finished, each claimed once.
    for (const id of [JOB_REGEN_A, JOB_REGEN_B, JOB_REGEN_C]) {
      expect(jobRow(id)).toMatchObject({ status: 'succeeded', attempts: 1, locked_at: null, completed_at: NOW, error: null });
    }
    expect(jobRow(JOB_STALE_SITEMAP)).toMatchObject({ status: 'succeeded', attempts: 2, locked_at: null, result: { synced: true, path: '/sitemap.xml' } });
    expect(cache.revalidatePath).toHaveBeenCalledWith('/sitemap.xml');

    // Rows the run had to leave alone.
    expect(jobRow(JOB_OTHER_WORKER)).toMatchObject({ status: 'running', attempts: 1, locked_at: minutes(-5) });
    expect(jobRow(JOB_BACKOFF)).toMatchObject({ status: 'queued', attempts: 2, run_after: minutes(60), error: 'earlier failure' });
    expect(jobRow(JOB_DEAD)).toMatchObject({ status: 'dead_letter', attempts: 5, error: 'gave up' });
    expect(jobRow(JOB_DONE)).toMatchObject({ status: 'succeeded', attempts: 1, completed_at: minutes(-60) });

    // The live pages were rewritten at the version read, with a snapshot and follow-ups.
    expect(pageRow(PAGE_A)).toMatchObject({ version: 3, title: 'Alpha planner', seo: { title: 'Alpha planner | Bubaly', canonical: '/features/alpha' }, content: { source: 'platform_console', generated: false } });
    expect(versionsOf(PAGE_A)).toEqual([expect.objectContaining({ version: 3, change_source: 'system', change_note: 'Automatic regeneration for version 3' })]);
    expect(versionsOf(PAGE_B)).toEqual([expect.objectContaining({ version: 1, change_source: 'system' })]);
    expect(jobsFor(PAGE_A).filter((row) => row.status === 'queued').map((row) => [row.job_type, row.idempotency_key, row.priority]).sort()).toEqual([
      ['embed_page', `marketing-page:${PAGE_A}:v:3:embedding`, 40],
      ['generate_questions', `marketing-page:${PAGE_A}:v:3:questions`, 65],
    ]);

    // The archived page: superseded, nothing written, nothing queued.
    expect(jobRow(JOB_REGEN_C).result).toEqual({ pageId: PAGE_C, superseded: true, archived: true });
    expect(pageRow(PAGE_C)).toMatchObject({ title: 'Gamma', seo: {}, version: 2 });
    expect(versionsOf(PAGE_C)).toEqual([]);
    expect(jobsFor(PAGE_C).map((row) => row.id)).toEqual([JOB_REGEN_C]);
    expect(ai.isAIConfigured).toHaveBeenCalledTimes(2);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: the follow-up run publishes each page’s answers and chunks under that page only', async () => {
    await run();
    fetchStub.mockClear();
    const second = await run();
    expect(second).toEqual({ status: 200, body: { claimed: 4, succeeded: 4, failed: 0, deadLettered: 0, persistenceFailed: 0, ok: true } });

    // Page A is published: its three generated answers are public, at its path, tagged with its id.
    expect(answersAt('/features/alpha').map((row) => [row.status, (row.metadata as Row).page_id])).toEqual([
      ['published', PAGE_A], ['published', PAGE_A], ['published', PAGE_A],
    ]);
    // Page B is a draft: its answers are 'answered', and the blog-seeded row at its path survives.
    expect(answersAt('/guides/beta').map((row) => [row.status, (row.metadata as Row).page_id ?? (row.metadata as Row).seed]).sort()).toEqual([
      ['answered', PAGE_B], ['answered', PAGE_B], ['answered', PAGE_B], ['published', 'blog_aeo_v1'],
    ]);
    // Page D, which had no job, keeps its answer and its ready chunk.
    expect(answersAt('/features/delta').map((row) => row.status)).toEqual(['published']);
    expect(chunksOf(PAGE_D).map((row) => [row.content_hash, row.status])).toEqual([['delta-hash', 'ready']]);

    // Each page's chunks: B's old chunk is staled by B's own run, A's is new.
    expect(chunksOf(PAGE_A).map((row) => row.status)).toEqual(['ready']);
    expect(chunksOf(PAGE_B).map((row) => [row.content_hash === 'beta-old-hash', row.status]).sort()).toEqual([[false, 'ready'], [true, 'stale']]);
    expect(String(chunksOf(PAGE_A)[0].content)).toContain('Alpha planner');
    expect(String(chunksOf(PAGE_B).find((row) => row.status === 'ready')!.content)).toContain('Beta guide');
    // One provider call per page, each carrying only that page's text.
    const sent = fetchStub.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { input: string[] }).input.join(' '));
    expect(sent).toHaveLength(2);
    expect(sent.filter((text) => text.includes('Alpha') && !text.includes('Beta'))).toHaveLength(1);
    expect(sent.filter((text) => text.includes('Beta') && !text.includes('Alpha'))).toHaveLength(1);
  });
});

describe('idempotence', () => {
  it('API-B7C1506769BC JOB-1C0E9374DE2E: once the queue is drained a third run claims nothing and writes nothing', async () => {
    await run();
    await run();
    const before = snapshot();
    const logged = db.log.length;
    fetchStub.mockClear();
    const third = await run();
    expect(third).toEqual({ status: 200, body: { claimed: 0, succeeded: 0, failed: 0, deadLettered: 0, persistenceFailed: 0, ok: true } });
    expect(snapshot()).toBe(before);
    expect(db.log.length).toBe(logged);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: a second regeneration of the same version adds no snapshot and queues no duplicate follow-up', async () => {
    await run();
    db.seed('marketing_generation_jobs', [job('00000000-0000-4000-8000-000000000109', {
      job_type: 'generate_metadata', target_id: PAGE_A, target_path: '/features/alpha', idempotency_key: `marketing-page:${PAGE_A}:v:3:metadata`, created_at: NOW,
    })]);
    // Priority order: the two questions jobs (65), then this one (50), ahead of the embeddings (40).
    const res = await run('?limit=3');
    expect(res).toEqual({ status: 200, body: { claimed: 3, succeeded: 3, failed: 0, deadLettered: 0, persistenceFailed: 0, ok: true } });
    expect(h.claims.at(-1)).toEqual({ p_limit: 3 });
    expect(jobRow('00000000-0000-4000-8000-000000000109')).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(versionsOf(PAGE_A)).toHaveLength(1);
    expect(jobsFor(PAGE_A).filter((row) => row.job_type === 'generate_questions')).toHaveLength(1);
    expect(jobsFor(PAGE_A).filter((row) => row.job_type === 'embed_page')).toHaveLength(1);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: two overlapping invocations never claim the same job', async () => {
    const [one, two] = await Promise.all([run('?limit=2'), run('?limit=2')]);
    expect(h.claims).toEqual([{ p_limit: 2 }, { p_limit: 2 }]);
    expect([one.body.claimed, two.body.claimed]).toEqual([2, 2]);
    for (const id of [JOB_REGEN_A, JOB_REGEN_B, JOB_REGEN_C, JOB_STALE_SITEMAP]) expect(jobRow(id).status).toBe('succeeded');
    expect(jobRow(JOB_REGEN_A).attempts).toBe(1);
    expect(jobRow(JOB_REGEN_B).attempts).toBe(1);
    expect(jobRow(JOB_REGEN_C).attempts).toBe(1);
    expect(jobRow(JOB_STALE_SITEMAP).attempts).toBe(2);
    expect(versionsOf(PAGE_A)).toHaveLength(1);
  });
});

describe('a failure is reported, and the other pages still proceed', () => {
  it('API-B7C1506769BC JOB-1C0E9374DE2E: a failed read of one page answers 502 ok:false, backs that job off, and the other page is still regenerated', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'marketing_pages' && calls[0]?.method === 'select' && calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === PAGE_B)
        ? { code: '57014', message: 'canceling statement due to statement timeout' }
        : null
    ));
    const res = await run();
    expect(res).toEqual({ status: 502, body: { claimed: 4, succeeded: 3, failed: 1, deadLettered: 0, persistenceFailed: 0, ok: false } });
    // Backoff 2^attempts x 30 s. The recorded text is not asserted: see the report (a PostgREST error is a plain object and is stored as "[object Object]").
    expect(jobRow(JOB_REGEN_B)).toMatchObject({ status: 'queued', attempts: 1, locked_at: null, run_after: minutes(1), error: expect.any(String) });
    expect(versionsOf(PAGE_B)).toEqual([]);
    expect(jobsFor(PAGE_B).map((row) => row.id)).toEqual([JOB_REGEN_B]);
    // Page A went ahead.
    expect(jobRow(JOB_REGEN_A).status).toBe('succeeded');
    expect(versionsOf(PAGE_A)).toHaveLength(1);

    // Not retried before its backoff; retried and finished after it.
    h.db = db;
    const early = await run();
    expect(jobRow(JOB_REGEN_B)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(early.body.failed).toBe(0);
    vi.setSystemTime(new Date(minutes(2)));
    await run();
    expect(jobRow(JOB_REGEN_B)).toMatchObject({ status: 'succeeded', attempts: 2, error: null });
    expect(versionsOf(PAGE_B)).toHaveLength(1);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: a job on its last attempt is dead-lettered and the run answers 502', async () => {
    db.seed('marketing_generation_jobs', [job('00000000-0000-4000-8000-00000000010a', {
      job_type: 'regenerate_page', target_id: GONE, target_path: '/features/gone', idempotency_key: `marketing-page:${GONE}:v:1`, attempts: 4, priority: 90, created_at: NOW,
    })]);
    const res = await run();
    expect(res).toEqual({ status: 502, body: { claimed: 5, succeeded: 4, failed: 1, deadLettered: 1, persistenceFailed: 0, ok: false } });
    expect(jobRow('00000000-0000-4000-8000-00000000010a')).toMatchObject({ status: 'dead_letter', attempts: 5, locked_at: null, error: 'Marketing page not found.' });
    expect(jobRow(JOB_REGEN_A).status).toBe('succeeded');
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: a failed claim answers 500 and runs nothing', async () => {
    h.claimFails = true;
    const before = snapshot();
    const res = await run();
    expect(res).toEqual({ status: 500, body: { error: 'marketing.marketingWorkerFailed' } });
    expect(db.log).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('API-B7C1506769BC JOB-1C0E9374DE2E: a failure that cannot be recorded answers 500, not a success', async () => {
    h.db = withFaults(db, (table, calls) => {
      if (table === 'marketing_pages' && calls[0]?.method === 'select' && calls.some((c) => c.method === 'eq' && c.args[1] === PAGE_B)) return { message: 'read refused' };
      if (table === 'marketing_generation_jobs' && calls[0]?.method === 'update' && (calls[0].args[0] as Row).status === 'queued') return { message: 'write refused' };
      return null;
    });
    const res = await run();
    expect(res).toEqual({ status: 500, body: { error: 'marketing.marketingWorkerFailed' } });
    // The job stays running under its lock, for the 15-minute stale-lock recovery.
    expect(jobRow(JOB_REGEN_B)).toMatchObject({ status: 'running', attempts: 1, locked_at: NOW });
    expect(jobRow(JOB_REGEN_A).status).toBe('succeeded');
  });
});
