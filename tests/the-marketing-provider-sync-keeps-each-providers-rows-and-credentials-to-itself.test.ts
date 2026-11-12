// Register B, group API-2: GET /api/cron/marketing-providers (API-418A48B840A8)
// and its job (JOB-F003E81306B4), driven through the REAL exported route and
// the real lib/marketing/provider-sync.ts over a populated in-memory database.
//
// This data is not family- or tenant-scoped: marketing_provider_observations
// and marketing_provider_syncs are operator-wide, keyed by PROVIDER (Google
// Search Console, Bing Webmaster, the AI-citation feed). "Isolation" here is
// applied to that key: one provider's rows, sync state, failure and credential
// never land on, or travel to, another provider.
//
// Existing coverage: marketing-platform-spine pins the source text only (the
// auth guard is called, the upsert's onConflict, `ready` in the reply); the
// cron-dispatch / cadence tests pin scheduling. Nothing drove the route.
//
// Providers are stubbed at the fetch seam (fetchWithDeadline calls the global
// fetch). The fake database keys an upsert with no onConflict on `id`;
// marketing_provider_syncs has no `id` — its primary key is `provider` (0237),
// which is what PostgREST resolves such an upsert on — so the fake is handed
// that key for that table and nothing else changes.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
const service = vi.hoisted(() => ({ createServiceClient: vi.fn(() => h.db) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: service.createServiceClient }));
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn, revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));

const { GET } = await import('@/app/api/cron/marketing-providers/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = '2026-11-12T10:00:00.000Z';
const TODAY = '2026-11-12';
const GOOGLE_TOKEN = 'ya29.test-google-token-not-real';
const BING_KEY = 'bing-test-key-not-real';
const AI_URL = 'https://citations.example.com/v1/observations';
const AI_KEY = 'ai-citation-test-key-not-real';
const SITE = 'https://bubaly.example.com';

type Reply = { status: number; body: unknown };
const replies: Record<'google' | 'bing' | 'ai', Reply> = { google: { status: 200, body: {} }, bing: { status: 200, body: {} }, ai: { status: 200, body: {} } };
const fetchStub = vi.fn(async (url: unknown) => {
  const host = new URL(String(url)).host;
  const reply = host === 'searchconsole.googleapis.com' ? replies.google
    : host === 'ssl.bing.com' ? replies.bing
      : host === 'citations.example.com' ? replies.ai
        : null;
  if (!reply) throw new Error(`unexpected host in test: ${host}`);
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
});

let db: InMemorySupabase;

/** The in-memory client, with marketing_provider_syncs upserts resolved on its primary key. */
function withSyncPrimaryKey(base: InMemorySupabase): InMemorySupabase {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as { upsert: (rows: unknown, opts?: Record<string, unknown>) => unknown };
        if (table !== 'marketing_provider_syncs') return builder;
        const upsert = builder.upsert.bind(builder);
        builder.upsert = (rows, opts) => upsert(rows, { onConflict: 'provider', ...opts });
        return builder;
      };
    },
  });
}

function configureAll() {
  vi.stubEnv('GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN', GOOGLE_TOKEN);
  vi.stubEnv('BING_WEBMASTER_API_KEY', BING_KEY);
  vi.stubEnv('AI_CITATION_API_URL', AI_URL);
  vi.stubEnv('AI_CITATION_API_KEY', AI_KEY);
}

function populatedReplies() {
  replies.google = { status: 200, body: { rows: [
    { keys: [`${SITE}/features/alpha`, 'family calendar app'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 },
    { keys: [`${SITE}/guides/beta`, 'weekly meal plan'], clicks: 2, impressions: 40, ctr: 0.05, position: 7.5 },
  ] } };
  replies.bing = { status: 200, body: { d: [{ Date: '/Date(1762905600000)/', Clicks: 3, Impressions: 40 }] } };
  replies.ai = { status: 200, body: { rows: [
    { engine: 'perplexity', observed_for: '2026-11-11', page_path: '/features/alpha', query: 'best family organizer', citations: 2, cited: true },
    { engine: 'chatgpt', observed_for: '2026-11-11', page_path: '/features/alpha', query: 'best family organizer', citations: 0, cited: false },
  ] } };
}

async function call(authorization?: string) {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  const res = await GET(new NextRequest('https://cron.example.com/api/cron/marketing-providers', { headers }));
  return { status: res.status, body: await res.json() as { ok?: boolean; ready?: boolean; results?: Record<string, Row>; error?: string } };
}
const run = () => call(`Bearer ${SECRET}`);

const observations = (provider: string) => db.table('marketing_provider_observations').filter((row) => row.provider === provider);
const syncRow = (provider: string) => {
  const rows = db.table('marketing_provider_syncs').filter((row) => row.provider === provider);
  expect(rows).toHaveLength(1);
  return rows[0];
};
const fetched = () => (fetchStub.mock.calls as unknown[][]).map(([url, init]) => ({ url: String(url), headers: JSON.stringify((init as RequestInit | undefined)?.headers ?? {}) }));
const snapshot = () => JSON.stringify(['marketing_provider_observations', 'marketing_provider_syncs'].map((t) => db.table(t)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', SITE);
  for (const name of ['GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN', 'GOOGLE_SEARCH_CONSOLE_KEY', 'BING_WEBMASTER_API_KEY', 'AI_CITATION_API_URL', 'AI_CITATION_API_KEY']) vi.stubEnv(name, '');
  vi.stubGlobal('fetch', fetchStub);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchStub.mockClear();
  service.createServiceClient.mockClear();
  db = createInMemorySupabase();
  // 0237 seeds one sync row per provider; plus observations the run must not touch.
  db.seed('marketing_provider_syncs', ['google_search_console', 'bing_webmaster', 'ai_citation'].map((provider) => ({ provider, status: 'not_configured', last_started_at: null, last_completed_at: null, last_error: null, rows_imported: 0, metadata: {} })));
  db.seed('marketing_provider_observations', [
    { provider: 'manual', engine: 'google', observed_for: '2026-11-01', page_path: '/features/alpha', query: 'manual note', clicks: 9, impressions: 90, citations: 0, payload: {}, source_status: 'manual' },
    { provider: 'google_search_console', engine: 'google', observed_for: '2026-11-05', page_path: '/features/alpha', query: 'family calendar app', clicks: 1, impressions: 10, citations: 0, payload: {}, source_status: 'observed' },
  ]);
  h.db = withSyncPrimaryKey(db);
  populatedReplies();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authorization comes before any read or provider call', () => {
  it('API-418A48B840A8 JOB-F003E81306B4: no Authorization header answers 401 with no database access and no provider call', async () => {
    configureAll();
    const before = snapshot();
    expect(await call()).toEqual({ status: 401, body: { error: 'marketingProviders.unauthorized' } });
    expect(service.createServiceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('API-418A48B840A8 JOB-F003E81306B4: a wrong Bearer secret answers 401 with no database access and no provider call', async () => {
    configureAll();
    const before = snapshot();
    expect(await call('Bearer not-the-cron-secret')).toEqual({ status: 401, body: { error: 'marketingProviders.unauthorized' } });
    expect(service.createServiceClient).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('API-418A48B840A8 JOB-F003E81306B4: the right secret with no provider configured answers 200, ready:false, and records why on each sync row without a call', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, ready: false, results: {
        google_search_console: { ok: true, configured: false, status: 'not_configured', rows: 0 },
        bing_webmaster: { ok: true, configured: false, status: 'not_configured', rows: 0 },
        ai_citation: { ok: true, configured: false, status: 'not_configured', rows: 0 },
      },
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(syncRow('google_search_console')).toMatchObject({ status: 'not_configured', last_started_at: NOW, last_completed_at: null, last_error: expect.stringContaining('GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN') });
    expect(syncRow('bing_webmaster')).toMatchObject({ status: 'not_configured', last_error: expect.stringContaining('BING_WEBMASTER_API_KEY') });
    expect(syncRow('ai_citation')).toMatchObject({ status: 'not_configured', last_error: expect.stringContaining('AI_CITATION_API_URL') });
    expect(db.table('marketing_provider_observations')).toHaveLength(2);
  });
});

describe('a run with every provider configured', () => {
  it('API-418A48B840A8 JOB-F003E81306B4: imports each provider’s rows under that provider, marks each sync connected, and answers 200 ready:true', async () => {
    configureAll();
    const res = await run();
    expect(res).toEqual({ status: 200, body: {
      ok: true, ready: true, results: {
        google_search_console: { ok: true, configured: true, status: 'connected', rows: 2 },
        bing_webmaster: { ok: true, configured: true, status: 'connected', rows: 1 },
        ai_citation: { ok: true, configured: true, status: 'connected', rows: 2 },
      },
    } });
    expect(observations('google_search_console').filter((row) => row.observed_for === TODAY).map((row) => [row.engine, row.page_path, row.query, row.clicks, row.impressions])).toEqual([
      ['google', '/features/alpha', 'family calendar app', 5, 100],
      ['google', '/guides/beta', 'weekly meal plan', 2, 40],
    ]);
    expect(observations('bing_webmaster').map((row) => [row.engine, row.observed_for, row.page_path, row.query, row.payload])).toEqual([
      ['bing', TODAY, '', '', { Date: '/Date(1762905600000)/', Clicks: 3, Impressions: 40 }],
    ]);
    expect(observations('ai_citation').map((row) => [row.engine, row.observed_for, row.citations, row.cited])).toEqual([
      ['perplexity', '2026-11-11', 2, true],
      ['chatgpt', '2026-11-11', 0, false],
    ]);
    for (const [provider, rows] of [['google_search_console', 2], ['bing_webmaster', 1], ['ai_citation', 2]] as const) {
      expect(syncRow(provider)).toMatchObject({ status: 'connected', rows_imported: rows, last_started_at: NOW, last_completed_at: NOW, last_error: null });
    }
    // Rows from before the run, of another provider or another day, are untouched.
    expect(observations('manual')).toEqual([expect.objectContaining({ clicks: 9, query: 'manual note' })]);
    expect(observations('google_search_console').filter((row) => row.observed_for === '2026-11-05')).toEqual([expect.objectContaining({ clicks: 1 })]);
  });

  it('API-418A48B840A8 JOB-F003E81306B4: each credential goes only to its own provider, and the request names the site', async () => {
    configureAll();
    await run();
    const calls = fetched();
    expect(calls).toHaveLength(3);
    const google = calls.filter((c) => c.url.startsWith('https://searchconsole.googleapis.com/'));
    const bing = calls.filter((c) => c.url.startsWith('https://ssl.bing.com/'));
    const citations = calls.filter((c) => c.url === AI_URL);
    expect(google).toHaveLength(1);
    expect(bing).toHaveLength(1);
    expect(citations).toHaveLength(1);
    expect(google[0].url).toContain(encodeURIComponent(SITE));
    expect(google[0].headers).toContain(`Bearer ${GOOGLE_TOKEN}`);
    expect(bing[0].url).toContain(`apikey=${encodeURIComponent(BING_KEY)}`);
    expect(bing[0].url).toContain(`siteUrl=${encodeURIComponent(SITE)}`);
    expect(citations[0].headers).toContain(`Bearer ${AI_KEY}`);
    const everything = (c: { url: string; headers: string }) => c.url + c.headers;
    expect([...bing, ...citations].map(everything).join(' ')).not.toContain(GOOGLE_TOKEN);
    expect([...google, ...citations].map(everything).join(' ')).not.toContain(BING_KEY);
    expect([...google, ...bing].map(everything).join(' ')).not.toContain(AI_KEY);
  });
});

describe('idempotence', () => {
  it('API-418A48B840A8 JOB-F003E81306B4: a second run the same day updates the same observation rows and the same sync rows, adding none', async () => {
    configureAll();
    await run();
    const counts = () => [db.table('marketing_provider_observations').length, db.table('marketing_provider_syncs').length];
    const after1 = counts();
    replies.google = { status: 200, body: { rows: [
      { keys: [`${SITE}/features/alpha`, 'family calendar app'], clicks: 8, impressions: 120, ctr: 0.066, position: 3.0 },
      { keys: [`${SITE}/guides/beta`, 'weekly meal plan'], clicks: 2, impressions: 40, ctr: 0.05, position: 7.5 },
    ] } };
    const second = await run();
    expect(second.status).toBe(200);
    expect(counts()).toEqual(after1);
    expect(after1).toEqual([2 + 2 + 1 + 2, 3]);
    expect(observations('google_search_console').filter((row) => row.observed_for === TODAY && row.page_path === '/features/alpha').map((row) => row.clicks)).toEqual([8]);
  });
});

describe('a failing provider is reported, and the others still run', () => {
  it('API-418A48B840A8 JOB-F003E81306B4: a provider answering 503 makes the run 502 ok:false, records the error on its own sync row only, and the other two still import', async () => {
    configureAll();
    replies.bing = { status: 503, body: { message: 'unavailable' } };
    const res = await run();
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.ready).toBe(false);
    expect(res.body.results).toEqual({
      google_search_console: { ok: true, configured: true, status: 'connected', rows: 2 },
      bing_webmaster: { ok: false, configured: false, status: 'error', rows: 0, error: 'Provider synchronization failed.' },
      ai_citation: { ok: true, configured: true, status: 'connected', rows: 2 },
    });
    expect(syncRow('bing_webmaster')).toMatchObject({ status: 'error', last_error: 'Bing Webmaster returned 503.', last_completed_at: null, rows_imported: 0 });
    expect(observations('bing_webmaster')).toEqual([]);
    expect(syncRow('google_search_console')).toMatchObject({ status: 'connected', last_error: null });
    expect(syncRow('ai_citation')).toMatchObject({ status: 'connected', last_error: null });
    expect(observations('ai_citation')).toHaveLength(2);
  });

  it('API-418A48B840A8 JOB-F003E81306B4: a refused observation write is a failed sync for that provider, not a connected one', async () => {
    configureAll();
    h.db = withFaults(withSyncPrimaryKey(db), (table, calls) => (
      table === 'marketing_provider_observations' && calls[0]?.method === 'upsert' && (calls[0].args[0] as Row[])[0]?.provider === 'google_search_console'
        ? { code: '42501', message: 'permission denied for table marketing_provider_observations' }
        : null
    ));
    const res = await run();
    expect(res.status).toBe(502);
    expect(res.body.results?.google_search_console).toEqual({ ok: false, configured: false, status: 'error', rows: 0, error: 'Provider synchronization failed.' });
    expect(syncRow('google_search_console')).toMatchObject({ status: 'error', rows_imported: 0, last_completed_at: null });
    expect(observations('google_search_console').filter((row) => row.observed_for === TODAY)).toEqual([]);
    expect(syncRow('bing_webmaster')).toMatchObject({ status: 'connected', rows_imported: 1 });
    expect(syncRow('ai_citation')).toMatchObject({ status: 'connected', rows_imported: 2 });
  });

  it('API-418A48B840A8 JOB-F003E81306B4: a missing site URL fails the two site-scoped providers and makes no call for them', async () => {
    configureAll();
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const res = await run();
    expect(res.status).toBe(502);
    expect(res.body.results?.google_search_console).toMatchObject({ ok: false, status: 'error' });
    expect(res.body.results?.bing_webmaster).toMatchObject({ ok: false, status: 'error' });
    expect(res.body.results?.ai_citation).toMatchObject({ ok: true, status: 'connected', rows: 2 });
    expect(syncRow('google_search_console')).toMatchObject({ status: 'error', last_error: 'NEXT_PUBLIC_SITE_URL is not configured.' });
    expect(fetched().map((c) => new URL(c.url).host)).toEqual(['citations.example.com']);
  });

  it('API-418A48B840A8 JOB-F003E81306B4: a refused sync-state write is logged, not raised: the import itself still answers 200 (C1-S9-76)', async () => {
    configureAll();
    h.db = withFaults(withSyncPrimaryKey(db), (table) => (table === 'marketing_provider_syncs' ? { message: 'write refused' } : null));
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.table('marketing_provider_observations')).toHaveLength(2 + 2 + 1 + 2);
    expect(db.table('marketing_provider_syncs').map((row) => row.status)).toEqual(['not_configured', 'not_configured', 'not_configured']);
    expect(vi.mocked(console.error).mock.calls.filter(([message]) => String(message).includes('marketing_provider_syncs upsert failed'))).toHaveLength(3);
  });
});
