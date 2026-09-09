import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The admin LAYOUT is where the rejected-key explanation lives, and that choice
// is load-bearing: 69 of the 79 admin pages bail to their own generic "could
// not load X" state, so the layout is the only place able to explain all of
// them at once. If this stops being computed, every one of those pages goes
// back to a dead end with no cause — and nothing else in the suite would
// notice, because each of those pages is behaving exactly as designed.
//
// Asserted on the PROP the layout hands the shell rather than on rendered HTML.
// That is the layout's actual decision, and it avoids react-dom/server: a full
// render here costs enough CPU to push tests/ai-loop-end-to-end.test.ts (a
// plan→execute→follow-up loop on vitest's 5s default) past its budget on a
// loaded machine. Cheap here beats destabilising a neighbour.

let failing = false;

function builder(): Record<string, unknown> {
  const settle = () =>
    failing
      ? Promise.resolve({ data: null, count: null, error: { message: 'Unregistered API key' } })
      : Promise.resolve({ data: [], count: 0, error: null });
  const chain: Record<string, unknown> = {
    then: (...a: unknown[]) => (settle() as Promise<unknown>).then(...(a as [])),
    catch: (...a: unknown[]) => (settle() as Promise<unknown>).catch(...(a as [])),
    finally: (...a: unknown[]) => (settle() as Promise<unknown>).finally(...(a as [])),
  };
  // A Proxy, not a fixed method list, so a query gaining a `.not()` or `.range()`
  // never silently turns this into a false pass. Unknown methods return the
  // PROXY — returning the bare target breaks the chain at the second call.
  const proxy: Record<string, unknown> = new Proxy(chain, {
    get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : () => proxy),
  });
  return proxy;
}

vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'u1', email: 'admin@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('next/navigation', () => ({
  redirect: () => { throw new Error('unexpected redirect'); },
}));
// Mocked at the SDK layer so createServiceClient, describeConfiguredServiceKey
// and serviceKeyRemedy all run for real — the test covers the wiring rather
// than restating it.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => builder() }),
}));

async function credentialFault(): Promise<string | null> {
  const { default: Layout } = await import('@/app/(app)/admin/layout');
  const element = await Layout({ children: null }) as { props: { credentialFault: string | null } };
  return element.props.credentialFault;
}

describe('the admin layout explains a rejected service-role key', () => {
  beforeEach(() => {
    failing = false;
    // vi.stubEnv is tracked and restored exactly; hand-rolled process.env
    // save/restore leaks whenever a worker is reused for another file.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ltcxlbipiihclxwioyqj.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_publishable_test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_fromsomeotherproject');
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('says nothing when the reads succeed', async () => {
    expect(await credentialFault()).toBeNull();
  });

  it('names the mistake when the key is rejected', async () => {
    failing = true;
    const fault = await credentialFault();
    // The production case: right shape, wrong project.
    expect(fault).toContain('sb_secret_');
    expect(fault).toContain('different project');
  });

  it('names the variable to change', async () => {
    failing = true;
    expect(await credentialFault()).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('links to THIS project, which is the fact that closes the loop', async () => {
    failing = true;
    expect(await credentialFault()).toContain('supabase.com/dashboard/project/ltcxlbipiihclxwioyqj');
  });

  it('never leaks the key value itself', async () => {
    failing = true;
    expect(await credentialFault()).not.toContain('fromsomeotherproject');
  });

  it('identifies a legacy JWT differently from a wrong-project key', async () => {
    failing = true;
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig');
    expect(await credentialFault()).toContain('legacy JWT');
  });
});
