import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ headers: vi.fn(), current: [] as { name: string; value: string }[] }));
vi.mock('next/headers', () => ({ headers: seam.headers }));
vi.mock('@/components/auth/callback-completion', () => ({ CallbackCompletion: () => null }));
import { GET } from '@/app/auth/callback/route';
import Page from '@/app/(auth)/auth/complete/page';
import { captureCallbackAdmissionWitness, captureCallbackRequestWitness } from '@/lib/auth/callback-witness-server';
import { parseCallbackAdmissionWitness } from '@/lib/auth/callback-witness';

const ORIGIN = 'https://admission-witness.supabase.co', KEY = 'sb-admission-witness-auth-token';
const USER = '11111111-1111-4111-8111-111111111111', SID = '22222222-2222-4222-8222-222222222222';
const encode = (value: unknown) => `base64-${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
function session(rotation: string, identity = true) {
  const claims = Buffer.from(JSON.stringify({ sub: USER, ...(identity ? { session_id: SID } : {}), rotation })).toString('base64url');
  return encode({ access_token: `e30.${claims}.synthetic-signature`, refresh_token: `private-refresh-${rotation}`,
    user: { id: USER, user_metadata: { private: 'private-profile' } } });
}
function request(generation = 'original-generation', query = '?code=synthetic-code', saved = session('old')) {
  return new Request(`https://app.example.invalid/auth/callback${query}`, { headers: { cookie:
    `${KEY}=${saved}; ${KEY}-code-verifier=private-verifier; ${KEY}-logout-generation=${generation}` } });
}
function witness(response: Response): string {
  const value = new URL(response.headers.get('location')!).searchParams.get('admission');
  expect(value).toBeTypeOf('string'); expect(value).not.toBe('invalid');
  return value!;
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Admission cannot contact a provider'); }));
  seam.current = [{ name: `${KEY}-logout-generation`, value: 'original-generation' }];
  seam.headers.mockReset().mockImplementation(async () => {
    const captured = seam.current.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
    return new Headers({ cookie: captured });
  });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('callback ownership starts at the original request', () => {
  it.each(['?code=synthetic-code', '?error=denied', ''])('retains original ownership through a held admission %s', async query => {
    const original = request('original-generation', query), expected = witness(await GET(request('original-generation', query)));
    const pending = GET(original);
    original.headers.set('cookie', `${KEY}-logout-generation=after-logout`);
    const response = await pending;
    expect(witness(response)).toBe(expected);
    expect(witness(await GET(request('after-logout', query)))).not.toBe(expected);
    expect(response.headers.get('set-cookie')).toBeNull(); expect(response.cookies.getAll()).toEqual([]);
    const decoded = Buffer.from(expected, 'base64url').toString('utf8');
    for (const privateValue of ['private-verifier', 'private-refresh', 'private-profile', USER, SID, 'original-generation']) {
      expect(decoded).not.toContain(privateValue);
    }
  });

  it('preserves the same provider session through ordinary token rotation', async () => {
    expect(witness(await GET(request('same', '?code=synthetic-code', session('old')))))
      .toBe(witness(await GET(request('same', '?code=synthetic-code', session('rotated')))));
  });

  it('compares exact bytes when the existing session has no stable provider session identity', async () => {
    expect(witness(await GET(request('same', '?code=synthetic-code', session('old', false)))))
      .not.toBe(witness(await GET(request('same', '?code=synthetic-code', session('rotated', false)))));
  });

  it('ignores unrelated project cookies while retaining this project ownership', async () => {
    const original = request(), unrelated = request();
    unrelated.headers.set('cookie', `${unrelated.headers.get('cookie')}; sb-other-auth-token=unrelated; sb-other-auth-token-code-verifier=other`);
    expect(witness(await GET(unrelated))).toBe(witness(await GET(original)));
  });

  it('forwards a supplied witness unchanged despite newer request cookies', async () => {
    const admission = witness(await GET(request()));
    seam.current = [{ name: `${KEY}-logout-generation`, value: 'newer-generation' }];
    const tree = await Page({ searchParams: Promise.resolve({ code: 'synthetic-code', admission }) });
    expect(tree.props.admission).toBe(admission); expect(seam.headers).toHaveBeenCalledOnce();
  });

  it('preserves an existing witnessed URL through callback rescue without reissuing ownership', async () => {
    const admission = witness(await GET(request()));
    const redirected = await GET(request('newer-generation', `?code=synthetic-code&admission=${admission}`));
    expect(witness(redirected)).toBe(admission); expect(redirected.cookies.getAll()).toEqual([]);
  });

  it.each(['admission=malformed', 'admission=', 'admission=first&admission=second'])('refuses invalid supplied callback ownership without recapture: %s', async query => {
    const response = await GET(request('newer-generation', `?code=synthetic-code&${query}`));
    expect(new URL(response.headers.get('location')!).searchParams.get('admission')).toBe('invalid');
    expect(response.cookies.getAll()).toEqual([]);
  });

  it.each(['', 'malformed', 'x'.repeat(513), ['first', 'second']])('refuses supplied invalid witness without recapturing current cookies', async admission => {
    const tree = await Page({ searchParams: Promise.resolve({ code: 'synthetic-code', admission }) });
    expect(tree.props.admission).toBeNull(); expect(seam.headers).toHaveBeenCalledOnce();
  });

  it('starts one original cookie-header read before a held direct-page query resolves', async () => {
    let release!: (query: Record<string, string>) => void;
    const held = new Promise<Record<string, string>>(resolve => { release = resolve; });
    const pending = Page({ searchParams: held });
    expect(seam.headers).toHaveBeenCalledOnce();
    seam.current = [{ name: `${KEY}-logout-generation`, value: 'newer-generation' }];
    release({ code: 'synthetic-code' });
    const old = await pending;
    const fresh = await Page({ searchParams: Promise.resolve({ code: 'synthetic-code' }) });
    expect(old.props.admission).toBeTypeOf('string'); expect(old.props.admission).not.toBe(fresh.props.admission);
    expect(seam.headers).toHaveBeenCalledTimes(2);
  });

  it('hashes decoded request cookies exactly like the original cookie-store snapshot', () => {
    const cookies = [{ name: `${KEY}-code-verifier`, value: 'private/value with unicode 家族' },
      { name: `${KEY}-logout-generation`, value: 'a generation' }];
    const header = cookies.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
    expect(captureCallbackRequestWitness(header)).toBe(captureCallbackAdmissionWitness(cookies));
    const encoded = captureCallbackRequestWitness(header)!;
    expect(encoded.length).toBeLessThanOrEqual(512); expect(parseCallbackAdmissionWitness(encoded)).not.toBeNull();
  });

  it.each(['configuration', 'header-limit', 'duplicate-verifier', 'duplicate-generation'])('fails closed on invalid %s without credential publication', async failure => {
    const input = request();
    if (failure === 'configuration') vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'invalid-configuration');
    if (failure === 'header-limit') input.headers.set('cookie', 'x'.repeat(1024 * 1024 + 1));
    if (failure === 'duplicate-verifier') input.headers.set('cookie', `${input.headers.get('cookie')}; ${KEY}-code-verifier=second-private-verifier`);
    if (failure === 'duplicate-generation') input.headers.set('cookie', `${input.headers.get('cookie')}; ${KEY}-logout-generation=newer-generation`);
    const response = await GET(input), location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('admission')).toBe('invalid');
    expect(response.cookies.getAll()).toEqual([]); expect(response.headers.get('set-cookie')).toBeNull();
    expect(location.search).not.toContain('private-verifier');
  });

  it('rejects duplicate copies of a canonical witness without replacing it', async () => {
    const admission = witness(await GET(request()));
    const tree = await Page({ searchParams: Promise.resolve({ code: 'synthetic-code', admission: [admission, admission] }) });
    expect(tree.props.admission).toBeNull();
  });

  it('preserves a provided witness even if reading the newer request cookies fails', async () => {
    const admission = witness(await GET(request()));
    seam.headers.mockRejectedValue(new Error('Synthetic request store failure'));
    expect((await Page({ searchParams: Promise.resolve({ code: 'synthetic-code', admission }) })).props.admission).toBe(admission);
    expect((await Page({ searchParams: Promise.resolve({ code: 'synthetic-code' }) })).props.admission).toBeNull();
  });

  it('rejects duplicate configured cookies on direct completion without collapsing their ambiguity', async () => {
    seam.current = [{ name: `${KEY}-logout-generation`, value: 'older' }, { name: `${KEY}-logout-generation`, value: 'newer' }];
    const tree = await Page({ searchParams: Promise.resolve({ code: 'synthetic-code' }) });
    expect(tree.props.admission).toBeNull();
  });
});
