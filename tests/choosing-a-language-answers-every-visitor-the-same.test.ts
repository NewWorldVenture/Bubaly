// Call-level tests for lib/i18n/actions.ts (audit Register B, group 8).
//
// setLocale is the language picker. It is a display preference for whoever is
// holding the browser, signed in or not: it reads no session, household or
// role (createServer and the service client throw if called) and writes one
// thing, the locale cookie. Every caller therefore gets the same answer: a code
// in the catalogue is stored, anything else is refused and the existing
// preference is left alone.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.set }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => { throw new Error('must not read the session'); },
  createServiceClient: () => { throw new Error('must not reach the database'); },
}));

const { setLocale } = await import('@/lib/i18n/actions');

beforeEach(() => { h.set.mockReset(); });

describe('setLocale', () => {
  it.each(['en-US', 'de-DE', 'fr-CA'])('ACTION-BA359E31039E any visitor can choose %s, stored as a lax cookie', async (code) => {
    await expect(setLocale(code)).resolves.toEqual({ ok: true });
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set).toHaveBeenCalledWith('bubaly-locale', code, expect.objectContaining({ path: '/', sameSite: 'lax' }));
  });

  it.each(['xx-XX', 'en', 'en-US; Path=/admin', ''])('ACTION-BA359E31039E %j is refused and no cookie is written', async (code) => {
    await expect(setLocale(code)).resolves.toEqual({ ok: false });
    expect(h.set).not.toHaveBeenCalled();
  });
});
