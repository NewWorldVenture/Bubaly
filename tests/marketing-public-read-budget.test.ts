import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the actual Supabase/PostgREST SDK. Only fetch and Next's cache
// boundary are replaced; query builders, error conversion and retry waits run.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));

import { getSeoPage, resolveMarketingMetadata } from '@/lib/marketing/seo';
import {
  readAeoQuestionsForCategory,
  readAeoQuestionsForPath,
  readAeoQuestionsForPathCached,
  readPublishedAeoQuestions,
} from '@/lib/marketing/aeo';

type RequestRecord = { url: URL; signal: AbortSignal | null | undefined };
let requests: RequestRecord[];
let respond: (request: RequestRecord) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function untilAborted({ signal }: RequestRecord): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function question(id: string, text = 'Configured answer') {
  return {
    id, question: `Question ${id}`, answer: text,
    entity: null, pattern: null, source_path: '/features', metadata: {},
  };
}

beforeEach(() => {
  requests = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://audit-fixture.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'audit-fixture-anon');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: new URL(input instanceof Request ? input.url : String(input)),
      signal: init?.signal,
    };
    // Native fetch rejects an already-aborted signal without starting network
    // work. The SDK may call fetch again after cancellation; those calls never
    // reach this transport and must not be counted as another request.
    request.signal?.throwIfAborted();
    requests.push(request);
    return respond(request);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('public editorial reads keep one deadline through real SDK retries', () => {
  it('bounds simultaneous SEO and AEO outages during retry backoff', async () => {
    respond = async () => { throw new TypeError('fixture transport failure'); };
    const started = performance.now();
    const results = await Promise.all([
      getSeoPage('/features'),
      readAeoQuestionsForPath('/features'),
    ]);
    expect(results).toEqual([null, { questions: [], available: false }]);
    expect(performance.now() - started).toBeLessThan(2500);
    // The real SDK retries at 1s, but its 2s/4s waits are cancelled. Once the
    // shared budget expires neither reader starts its legacy lookup.
    expect(requests.map(({ url }) => url.pathname)).not.toContain('/rest/v1/marketing_seo_pages');
    const seoRequests = requests.filter(({ url }) => url.pathname.endsWith('/marketing_pages'));
    const aeoRequests = requests.filter(({ url }) => url.pathname.endsWith('/marketing_aeo_questions'));
    expect(seoRequests.length).toBeGreaterThanOrEqual(1);
    expect(aeoRequests.length).toBeGreaterThanOrEqual(1);
    expect(seoRequests.length).toBeLessThanOrEqual(2);
    expect(aeoRequests.length).toBeLessThanOrEqual(2);
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true);
  });

  it('aborts a pending request and keeps the authored metadata fallback', async () => {
    respond = untilAborted;
    const fallback = { title: 'Authored title', description: 'Authored description', robots: { index: true } };
    const started = performance.now();
    const result = await resolveMarketingMetadata('/features', fallback);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(result).toMatchObject(fallback);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it('cancels a retryable server response even when Retry-After exceeds the read budget', async () => {
    respond = async () => new Response(JSON.stringify({ message: 'fixture schema cache unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    });
    const started = performance.now();
    expect(await readAeoQuestionsForPath('/features')).toEqual({ questions: [], available: false });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(true);
  });

  it('gives the SEO compatibility read only the time remaining after the primary read', async () => {
    respond = async (request) => {
      if (request.url.pathname.endsWith('/marketing_pages')) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return json([]);
      }
      return untilAborted(request);
    };
    const started = performance.now();
    expect(await getSeoPage('/features')).toBeNull();
    expect(performance.now() - started).toBeLessThan(2200);
    expect(requests).toHaveLength(2);
    expect(requests[1].url.pathname).toBe('/rest/v1/marketing_seo_pages');
    expect(requests[1].signal).toBe(requests[0].signal);
  });

  it('gives the AEO compatibility read only the remaining shared budget', async () => {
    respond = async (request) => {
      if (request.url.pathname.endsWith('/marketing_aeo_questions')) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return json({ message: 'fixture table unavailable', code: '42P01' }, 404);
      }
      return untilAborted(request);
    };
    const started = performance.now();
    expect(await readAeoQuestionsForPath('/features')).toEqual({ questions: [], available: false });
    expect(performance.now() - started).toBeLessThan(2200);
    expect(requests).toHaveLength(2);
    expect(requests[1].url.pathname).toBe('/rest/v1/marketing_pages');
    expect(requests[1].signal).toBe(requests[0].signal);
  });

  it('shares the category budget with published fallback and retains available category rows on failure', async () => {
    respond = async (request) => {
      if (request.url.searchParams.has('metadata->>category')) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return json([question('category')]);
      }
      return untilAborted(request);
    };
    const started = performance.now();
    const result = await readAeoQuestionsForCategory('family', 2);
    expect(performance.now() - started).toBeLessThan(2200);
    expect(result.available).toBe(false);
    expect(result.questions.map(({ id }) => id)).toEqual(['category']);
    expect(requests).toHaveLength(2);
    expect(requests[1].signal).toBe(requests[0].signal);
  });

  it('bounds standalone published reads and category transport failures', async () => {
    respond = async () => { throw new TypeError('fixture transport failure'); };
    const started = performance.now();
    expect(await Promise.all([readPublishedAeoQuestions(), readAeoQuestionsForCategory('family')]))
      .toEqual([{ questions: [], available: false }, { questions: [], available: false }]);
    expect(performance.now() - started).toBeLessThan(2500);
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true);
  });
});

describe('configured editorial content and fallback semantics stay intact', () => {
  it('uses configured platform SEO without reading legacy content', async () => {
    respond = async () => json([{ title: 'Page title', summary: 'Summary', seo: {
      title: 'Configured title', description: 'Configured description', canonical: '/configured',
    } }]);
    expect(await getSeoPage('/features')).toEqual({
      title: 'Configured title', description: 'Configured description', canonical: '/configured',
    });
    expect(requests).toHaveLength(1);
  });

  it('uses legacy SEO when the platform row is absent', async () => {
    respond = async ({ url }) => json(url.pathname.endsWith('/marketing_pages') ? [] : [{
      title: 'Legacy title', meta_description: 'Legacy description', metadata: { canonical: '/legacy' },
    }]);
    expect(await getSeoPage('/features')).toEqual({
      title: 'Legacy title', description: 'Legacy description', canonical: '/legacy',
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].signal).toBe(requests[0].signal);
  });

  it('returns configured AEO rows and treats a successful empty read as authoritative', async () => {
    respond = async () => json([question('canonical')]);
    expect((await readAeoQuestionsForPath('/features')).questions.map(({ id }) => id)).toEqual(['canonical']);
    respond = async () => json([]);
    expect(await readAeoQuestionsForPath('/features')).toEqual({ questions: [], available: true });
    expect(requests).toHaveLength(2);
    expect(requests.every(({ url }) => url.pathname.endsWith('/marketing_aeo_questions'))).toBe(true);
  });

  it('uses available legacy AEO after a primary error and can recover after an unavailable read', async () => {
    respond = async ({ url }) => url.pathname.endsWith('/marketing_aeo_questions')
      ? json({ message: 'fixture table unavailable', code: '42P01' }, 404)
      : json([{ aeo: { questions: [{ question: 'Legacy question', answer: 'Legacy answer' }] } }]);
    const legacy = await readAeoQuestionsForPath('/features');
    expect(legacy.available).toBe(true);
    expect(legacy.questions.map(({ answer }) => answer)).toEqual(['Legacy answer']);
    respond = async () => json({ message: 'fixture unavailable', code: '42P01' }, 404);
    expect(await readAeoQuestionsForPathCached('/features')).toEqual({ questions: [], available: false });
    respond = async () => json([question('recovered')]);
    const recovered = await readAeoQuestionsForPathCached('/features');
    expect(recovered.available).toBe(true);
    expect(recovered.questions.map(({ id }) => id)).toEqual(['recovered']);
    // Next's cache is an identity boundary here: this proves the callback's
    // failure/fallback and subsequent fresh read, not production cache storage.
  });

  it('fills thin categories from published rows without duplicating questions', async () => {
    respond = async ({ url }) => json(url.searchParams.has('metadata->>category')
      ? [question('category')]
      : [question('category'), question('extra'), question('unused')]);
    const result = await readAeoQuestionsForCategory('family', 2);
    expect(result.available).toBe(true);
    expect(result.questions.map(({ id }) => id)).toEqual(['category', 'extra']);
    expect(requests).toHaveLength(2);
    expect(requests[1].signal).toBe(requests[0].signal);
  });
});
