import { afterEach, describe, expect, it, vi } from 'vitest';

// The status probe behind the Connect Outlook control.
//
// It exists so a surface can render the right control without knowing anything
// about a provider, and its whole job is to NEVER be the reason a page breaks.
// Every failure it can meet — unknown provider, signed out, no family, a failed
// read — answers with booleans rather than throwing, because the control it
// drives is a link that is safe in every one of those states. A probe that 500s
// would turn a working link into a missing one.

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServiceClient: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/sync/registry', () => ({ getAdapter: mocks.getAdapter }));

import { GET } from '@/app/api/sync/[provider]/status/route';

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });
const req = () => ({}) as never;

/** A Postgrest-ish builder whose maybeSingle settles however the test says. */
function db(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null });
  return { from: () => chain };
}

function signedIn() {
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'u1' }, active: { familyId: 'f1' } });
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/sync/[provider]/status', () => {
  it('reports connected when the user holds an account row', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    signedIn();
    mocks.createServiceClient.mockReturnValue(db({ data: { id: 'acct-1' } }));

    const body = await (await GET(req(), params('microsoft'))).json();
    expect(body).toEqual({ configured: true, connected: true });
  });

  it('reports not connected when there is no account row', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    signedIn();
    mocks.createServiceClient.mockReturnValue(db({ data: null }));

    const body = await (await GET(req(), params('microsoft'))).json();
    expect(body).toEqual({ configured: true, connected: false });
  });

  // The production default: the adapter is registered, but no Entra app has
  // been created, so no OAuth can complete. Still a 200 with usable booleans —
  // the caller renders Connect, and /auth explains the rest.
  it('reports configured:false rather than failing when credentials are absent', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => false });
    signedIn();
    mocks.createServiceClient.mockReturnValue(db({ data: null }));

    const res = await GET(req(), params('microsoft'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, connected: false });
  });

  it('never claims connected for a provider with no adapter', async () => {
    mocks.getAdapter.mockReturnValue(null);

    const res = await GET(req(), params('doesnotexist'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, connected: false, reason: 'unknown_provider' });
    // No session or database work attempted for a provider that cannot exist.
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('answers rather than throwing when the caller has no session', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    mocks.requireUserContext.mockRejectedValue(new Error('not signed in'));

    const res = await GET(req(), params('microsoft'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, connected: false, reason: 'no_session' });
  });

  it('answers rather than throwing when the account read errors', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    signedIn();
    mocks.createServiceClient.mockReturnValue(db({ error: { message: 'Unregistered API key' } }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(req(), params('microsoft'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, connected: false, reason: 'read_failed' });
    // The failure is still recorded — degraded, not silent.
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('answers rather than throwing when the client cannot be built at all', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    signedIn();
    mocks.createServiceClient.mockImplementation(() => { throw new Error('no service key'); });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(req(), params('microsoft'));
    expect(res.status).toBe(200);
    // Reported as `unavailable`, NOT `no_session`: the caller was signed in,
    // and blaming the session would send the next reader to the wrong place.
    expect(await res.json()).toEqual({ configured: true, connected: false, reason: 'unavailable' });
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('scopes the lookup to this user AND this family', async () => {
    mocks.getAdapter.mockReturnValue({ isConfigured: () => true });
    signedIn();
    const eq = vi.fn();
    const chain: Record<string, unknown> = {};
    chain.from = () => chain; chain.select = () => chain;
    chain.eq = (col: string, val: string) => { eq(col, val); return chain; };
    chain.maybeSingle = async () => ({ data: null, error: null });
    mocks.createServiceClient.mockReturnValue({ from: () => chain });

    await GET(req(), params('microsoft'));
    expect(eq).toHaveBeenCalledWith('family_id', 'f1');
    expect(eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(eq).toHaveBeenCalledWith('provider', 'microsoft');
  });
});
