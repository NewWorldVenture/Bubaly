// Child sign-in spends the same work on a username that exists and one that
// does not (audit N8).
//
// The wording was already identical ("that username or PIN isn't right"), but an
// unknown username — or a removed child's — returned after two service-role
// reads, while an existing one went on to the GoTrue password round trip and
// its bcrypt verification. Response time therefore said which child usernames
// exist, at 30 guesses a minute per address. Driven through the real action
// with the provider replaced: a miss now makes the same password request, for
// the typed username with a password no account holds, and stays a miss
// whatever the provider answers; a read failure still makes no request (fail
// closed); a real child still signs in with the real derivation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';

const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'synthetic-child-secret';
const state = vi.hoisted(() => ({
  known: true, memberActive: true, failReads: new Set<string>(),
  signIns: [] as Array<{ email: string; password: string }>, clears: 0,
}));

vi.mock('next/headers', () => ({
  cookies: async () => { throw new Error('cookies must not be touched'); },
  headers: async () => new Headers({ 'x-forwarded-for': '192.0.2.10' }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: vi.fn(), isSuperAdmin: vi.fn() }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/auth/child-throttle-store', () => ({ reserveChildLoginAttempt: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => { throw new Error('Cookie-bound auth must not run'); },
  createServiceClient: () => ({ from: (table: string) => {
    const failure = () => ({ data: null, error: { message: `synthetic ${table} read failure` } });
    const chain = {
      select: () => chain,
      eq: () => chain,
      // child_logins: the username lookup.
      limit: async () => (state.failReads.has(table) ? failure()
        : { data: state.known ? [{ username: 'emma', user_id: CHILD, member_id: 'member-emma' }] : [], error: null }),
      // family_members: the membership liveness check.
      maybeSingle: async () => (state.failReads.has(table) ? failure()
        : { data: state.memberActive ? { id: 'member-emma' } : null, error: null }),
      // child_login_throttle: the clear on success.
      upsert: async () => { state.clears += 1; return { error: null }; },
    };
    return chain;
  } }),
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: () => ({
      auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          state.signIns.push({ email, password });
          // A provider that answers EVERY request with a valid receipt for the
          // real child — the harshest case for a miss, which must stay a miss.
          const token = [
            Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
            Buffer.from(JSON.stringify({ sub: CHILD })).toString('base64url'),
            'sig',
          ].join('.');
          const user = { id: CHILD, email };
          return { data: { user, session: { access_token: token, refresh_token: 'synthetic-refresh', user } }, error: null };
        },
        dispose: async () => {},
      },
    }),
  };
});

import { childSignInAction } from '@/app/(auth)/actions';

const REAL = deriveChildPassword(SECRET, 'emma', '1234');

beforeEach(() => {
  state.known = true; state.memberActive = true; state.failReads = new Set(); state.signIns = []; state.clears = 0;
  vi.stubEnv('CHILD_LOGIN_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://child-timing.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('a miss costs the provider round trip too', () => {
  it('an unknown username makes one password request, for that username, and is still refused', async () => {
    state.known = false;
    expect(await childSignInAction({ username: 'nobody', pin: '1234' })).toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(state.signIns).toHaveLength(1);
    expect(state.signIns[0].email).toBe(syntheticChildEmail('nobody'));
    // Never the typed PIN's real derivation: the request is work, not a guess.
    expect(state.signIns[0].password).not.toBe(deriveChildPassword(SECRET, 'nobody', '1234'));
    expect(state.clears).toBe(0);
  });

  it('a removed child\'s username makes the same request, without their real credentials, and is still refused', async () => {
    state.memberActive = false;
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(state.signIns).toHaveLength(1);
    expect(state.signIns[0].email).toBe(syntheticChildEmail('emma'));
    expect(state.signIns[0].password).not.toBe(REAL);
    expect(state.clears).toBe(0);
  });

  it('the decoy is deterministic for one username and PIN, and differs from the real derivation for every PIN', async () => {
    state.known = false;
    await childSignInAction({ username: 'nobody', pin: '1234' });
    await childSignInAction({ username: 'nobody', pin: '1234' });
    expect(state.signIns[0].password).toBe(state.signIns[1].password);
    for (const pin of ['0000', '1234', '9999']) expect(state.signIns[0].password).not.toBe(deriveChildPassword(SECRET, 'nobody', pin));
  });
});

describe('what does not change', () => {
  it.each(['child_logins', 'family_members'])('a %s read failure makes no request and fails closed (control)', async (table) => {
    state.failReads.add(table);
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(state.signIns).toEqual([]);
  });

  it('a child who is in the family signs in with the real derivation (control)', async () => {
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toMatchObject({ ok: true });
    expect(state.signIns).toEqual([{ email: syntheticChildEmail('emma'), password: REAL }]);
    expect(state.clears).toBe(1);
  });
});
