import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}));

import { middleware } from '@/middleware';
import { PROTECTED, PUBLIC, matchesPrefix } from '@/lib/auth/route-access';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
});
afterEach(() => vi.unstubAllEnvs());

describe('public customer story routing', () => {
  it.each([true, false])('lets signed-out visitors reach the publication check (auth configured: %s)', async (configured) => {
    if (!configured) {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    }
    for (const path of ['/customers/calmer-week', '/customers/private-draft', '/customers/unknown']) {
      const response = await middleware(new NextRequest(`https://bubaly.com${path}`));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('keeps the admin editor protected', async () => {
    for (const path of ['/admin/marketing/reputation', '/dashboard']) {
      const response = await middleware(new NextRequest(`https://bubaly.com${path}`));
      expect(response.status, path).toBe(307);
      const target = new URL(response.headers.get('location')!);
      expect(target.pathname).toBe('/login');
      expect(target.searchParams.get('redirect')).toBe(path);
    }
  });

  it('does not let a similarly prefixed path inherit /customers', () => {
    // /customers is public; /customers-private must not be. This was checked by
    // asserting a 307, which distinguished nothing once unlisted paths began
    // falling through to a 404 instead of a login redirect. The list is the
    // real subject, and a startsWith that ignored the separator would fail it.
    expect(matchesPrefix('/customers-private/story', PUBLIC)).toBe(false);
    expect(matchesPrefix('/customers-private/story', PROTECTED)).toBe(false);
    expect(matchesPrefix('/customers/acme', PUBLIC)).toBe(true);
  });
});
