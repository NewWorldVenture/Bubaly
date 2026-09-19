import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ target: '', responseStatus: 0 }));
vi.mock('@/lib/auth/recovery-cookies', () => ({
  // Exercise the actual bounded transport at its SDK injection boundary. Even
  // an unexpected SDK target cannot turn this into a user-directed fetch.
  createPkceCookieExchange: async (options: { fetch: typeof fetch }) => ({
    client: { auth: { exchangeCodeForSession: async () => {
      const response = await options.fetch(seam.target, { redirect: 'follow' });
      seam.responseStatus = response.status;
      return { data: { session: null }, error: { status: 503 } };
    } } },
    anonymousId: null, dispose: async () => {},
  }),
}));
import { completeCallback } from '@/lib/auth/callback-server';

const ORIGIN = 'https://callback-transport.supabase.co';
const provider = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  seam.responseStatus = 0;
  provider.mockReset().mockResolvedValue(Response.json({ fixture: true }));
  vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const complete = () => completeCallback({ code: 'synthetic-code', next: '/home', verifierFingerprint: 'a'.repeat(64) });

describe('callback transport is confined to configured SDK endpoints', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:54321/auth/v1/token',
    'https://foreign.invalid/auth/v1/token',
    `${ORIGIN}.foreign.invalid/auth/v1/token`,
    `${ORIGIN}/storage/v1/object/private`,
    `${ORIGIN}/auth/v1/admin/users`,
    `${ORIGIN}/rest/v1/../../storage/v1/object/private`,
  ])('rejects unexpected endpoint %s before invoking fetch', async target => {
    seam.target = target;
    expect(await complete()).toMatchObject({ status: 'unavailable' });
    expect(seam.responseStatus).toBe(503); expect(provider).not.toHaveBeenCalled();
  });

  it.each(['/auth/v1/token', '/auth/v1/user', '/rest/v1/family_members'])('permits configured %s while forcing manual redirects', async path => {
    seam.target = `${ORIGIN}${path}`;
    await complete();
    expect(seam.responseStatus).toBe(200); expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][0]).toBe(seam.target);
    expect(provider.mock.calls[0][1]).toMatchObject({ redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal) });
  });
});
