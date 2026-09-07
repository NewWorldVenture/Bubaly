import { describe, expect, it, vi, beforeEach } from 'vitest';

// A credential pasted into a hosting dashboard picks up a trailing newline or a
// wrapping pair of quotes routinely, and Supabase then rejects it with
// "Unregistered API key" / "Invalid Compact JWS" — errors that name nothing the
// operator can act on. These assert the value actually handed to the client.

const createAdmin = vi.fn(() => ({ from: () => ({}) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createAdmin }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

const KEY = 'sb_secret_' + 'x'.repeat(32);
const URL = 'https://example.supabase.co';

async function build(key: string, url = URL) {
  vi.resetModules();
  createAdmin.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  const { createServiceClient } = await import('../lib/supabase/server');
  createServiceClient();
  return { url: createAdmin.mock.calls[0][0], key: createAdmin.mock.calls[0][1] };
}

describe('createServiceClient normalises its credentials', () => {
  beforeEach(() => vi.resetModules());

  it('strips a trailing newline', async () => {
    expect((await build(`${KEY}\n`)).key).toBe(KEY);
  });

  it('strips surrounding whitespace', async () => {
    expect((await build(`   ${KEY}  `)).key).toBe(KEY);
  });

  it('strips wrapping double and single quotes', async () => {
    expect((await build(`"${KEY}"`)).key).toBe(KEY);
    expect((await build(`'${KEY}'`)).key).toBe(KEY);
  });

  it('strips quotes that also carry whitespace', async () => {
    expect((await build(`  "${KEY}"  `)).key).toBe(KEY);
  });

  it('cleans the URL too — a trailing newline breaks every request', async () => {
    expect((await build(KEY, `${URL}\n`)).url).toBe(URL);
  });

  it('leaves a clean key exactly as it is', async () => {
    const built = await build(KEY);
    expect(built.key).toBe(KEY);
    expect(built.url).toBe(URL);
  });

  it('does not mangle a key containing quote-like characters inside it', async () => {
    const odd = 'sb_secret_ab"cd';
    expect((await build(odd)).key).toBe(odd);
  });

  it('passes an empty string rather than the literal "undefined" when unset', async () => {
    vi.resetModules();
    createAdmin.mockClear();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL;
    const { createServiceClient } = await import('../lib/supabase/server');
    createServiceClient();
    expect(createAdmin.mock.calls[0][1]).toBe('');
  });
});
