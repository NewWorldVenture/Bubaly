import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';
import { PROTECTED, PUBLIC, matchesPrefix } from '@/lib/auth/route-access';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

afterEach(() => { vi.unstubAllEnvs(); });

for (const configured of [true, false]) {
  describe(`anonymous entry points with Supabase ${configured ? 'configured' : 'unconfigured'}`, () => {
    beforeEach(() => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', configured ? 'https://example.supabase.co' : '');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', configured ? 'test-anon-key' : '');
      getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
    });

    it.each(['/welcome', '/kid-login', '/signup', '/login'])('allows %s before sign-in', async (path) => {
      const response = await middleware(new NextRequest(`https://www.bubaly.com${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    });

    it.each(['/dashboard', '/admin', '/wallet'])('still protects %s', async (path) => {
      const response = await middleware(new NextRequest(`https://www.bubaly.com${path}`));
      expect(response.status).toBe(307);
      const destination = new URL(response.headers.get('location')!);
      expect(destination.pathname).toBe('/login');
      expect(destination.searchParams.get('redirect')).toBe(path);
    });

    // /welcome-private and /kid-login-private are invented: they exist to prove
    // a path that merely SHARES A PREFIX with a public entry does not inherit
    // its access. They used to be checked by asserting a 307, which worked
    // while every unlisted path redirected; unlisted paths now fall through to
    // a 404, so passing through no longer distinguishes public from unrouted.
    // Asserting against the lists themselves is what the case was always for,
    // and it cannot be satisfied by a sloppy startsWith.
    it.each(['/welcome-private', '/kid-login-private', '/logout', '/blogger'])(
      'does not let %s inherit a public prefix', (path) => {
        expect(matchesPrefix(path, PUBLIC), `${path} must not be public`).toBe(false);
        expect(matchesPrefix(path, PROTECTED), `${path} must not be protected`).toBe(false);
      },
    );
  });
}
