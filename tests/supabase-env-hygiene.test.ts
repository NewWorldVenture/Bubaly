import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

// A credential pasted into a hosting dashboard picks up a trailing newline or a
// wrapping pair of quotes routinely, and Supabase then rejects it with
// "Unregistered API key" / "Invalid Compact JWS" — errors that name nothing the
// operator can act on. These assert the value actually handed to the client.

// Typed parameters so `mock.calls[0][0]` is the url and `[0][1]` the key —
// an untyped vi.fn() infers an empty tuple and tsc rejects both indexes.
const createAdmin = vi.fn((_url: string, _key: string, _options?: unknown) => ({ from: () => ({}) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createAdmin }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

const KEY = 'sb_secret_' + 'x'.repeat(32);
const URL = 'https://example.supabase.co';

// These tests must WRITE process.env to exercise the code under test, and the
// suite does not isolate every file into its own process — so anything left
// behind is read by whatever runs next in this worker. Restoring is not
// tidiness: leaking a fake URL here broke tests/privacy-export.test.ts in CI,
// in a file this change never touched.
const ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

afterAll(() => {
  restoreEnv();
  vi.resetModules();
});

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
