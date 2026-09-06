import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { parseBuildRevision } from '../lib/build-identity.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const authCalls = vi.hoisted(() => ({ create: vi.fn(), getUser: vi.fn() }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => {
    authCalls.create(...args);
    return { auth: { getUser: authCalls.getUser } };
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
  authCalls.getUser.mockResolvedValue({ data: { user: null }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadBuild(input: string | undefined) {
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', input);
  const { default: config } = await import('../next.config.mjs');
  // Vitest does not run Next's DefinePlugin. Supply the config's exact literal
  // before importing the handler, rather than treating hosting env as runtime data.
  vi.stubEnv('BUBALY_BUILD_REVISION', config.env?.BUBALY_BUILD_REVISION ?? '');
  const route = await import('../app/api/build-info/route');
  return { config, route };
}

describe('build identity', () => {
  it.each([SHA, SHA.toUpperCase()])('embeds only a complete revision: %s', async (input) => {
    const { config, route } = await loadBuild(input);
    expect(config.env).toEqual({ BUBALY_BUILD_REVISION: SHA });
    const response = route.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: SHA });
  });

  it.each([
    undefined,
    '',
    ' ',
    'main',
    SHA.slice(0, 7),
    SHA.slice(0, 39),
    SHA + 'a',
    'g'.repeat(40),
    ' ' + SHA,
    SHA + ' ',
    SHA + '\n',
    SHA + '\r\n',
    SHA.slice(0, 20) + '\n' + SHA.slice(21),
    'https://example.com/' + SHA,
    '{"revision":"' + SHA + '"}',
  ])('reports unavailable rather than guessing for input %s', async (input) => {
    const { config, route } = await loadBuild(input);
    expect(config.env).toEqual({ BUBALY_BUILD_REVISION: '' });
    expect(await route.GET().json()).toEqual({ revision: null });
  });

  it.each([null, 123, {}, [SHA]])('rejects non-string values: %j', (input) => {
    expect(parseBuildRevision(input)).toBeNull();
  });

  it.each([SHA, undefined])('keeps the response read-only and uncached for %s', async (input) => {
    const fetchSpy = vi.fn(() => { throw new Error('Unexpected network access'); });
    vi.stubGlobal('fetch', fetchSpy);
    const { route } = await loadBuild(input);
    const response = route.GET();
    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic']);
    expect(route.dynamic).toBe('force-dynamic');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ revision: input ?? null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authCalls.create).not.toHaveBeenCalled();
  });

  it.each([SHA, undefined])('does not replace build identity with mutable input: %s', async (input) => {
    const { config, route } = await loadBuild(input);
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', OTHER_SHA);
    vi.stubEnv('BUBALY_BUILD_REVISION', OTHER_SHA);
    const spoofedRequest = new NextRequest(
      'https://example.com/api/build-info?revision=' + OTHER_SHA + '&code=ignored',
      { headers: { 'x-vercel-git-commit-sha': OTHER_SHA, 'x-build-revision': OTHER_SHA } },
    );
    const response = Reflect.apply(route.GET, undefined, [spoofedRequest]);
    expect(config.env).toEqual({ BUBALY_BUILD_REVISION: input ?? '' });
    expect(await response.json()).toEqual({ revision: input ?? null });
  });

  it('defensively rejects an invalid injected literal as well', async () => {
    vi.stubEnv('BUBALY_BUILD_REVISION', 'not-a-revision');
    const { GET } = await import('../app/api/build-info/route');
    expect(await GET().json()).toEqual({ revision: null });
  });
});

describe('build identity middleware boundary', () => {
  it.each([true, false])('needs no session or OAuth handling, configured=%s', async (configured) => {
    if (!configured) {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined);
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined);
    }
    const { middleware } = await import('../middleware');
    const response = await middleware(new NextRequest(
      'https://example.com/api/build-info?code=ignored&revision=' + OTHER_SHA,
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(authCalls.create).not.toHaveBeenCalled();
    expect(authCalls.getUser).not.toHaveBeenCalled();
  });

  it.each(['/api/build-info/private', '/api/build-information', '/api/notes'])(
    'does not bypass authorization for neighboring path %s',
    async (path) => {
      const { middleware } = await import('../middleware');
      const response = await middleware(new NextRequest('https://example.com' + path));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/login');
      expect(authCalls.getUser).toHaveBeenCalledOnce();
    },
  );
});
