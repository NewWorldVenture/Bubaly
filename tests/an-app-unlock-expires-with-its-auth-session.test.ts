// Exercise the real App Lock actions, cookie signer and durable limiter. The
// database is local and the Auth boundary answers independently for user and
// session, so a new sign-in cannot accidentally mean merely changing a user id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { buildAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';
import { PUBLISHED_SECRET_PLACEHOLDERS } from '@/lib/server/configured-secret';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const ANA = '00000000-0000-4000-8000-0000000000a1';
const SESSION_A = '00000000-0000-4000-8000-000000000051';
const SESSION_B = '00000000-0000-4000-8000-000000000052';
const PIN = '4071';
type LockRecord = { userId: string; config: AppLockConfig | null; revision: string };

const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  sessionId: null as string | null,
  tokenRevision: 0,
  authError: false,
  rpcReply: undefined as unknown,
  rpcThrows: false,
  rpcCalls: [] as Record<string, unknown>[],
  record: null as LockRecord | null,
  readError: false,
  reads: 0,
  writes: 0,
  beforeRead: null as (() => void) | null,
  beforeWrite: null as (() => void) | null,
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => state.jar.get(name),
    getAll: () => [...state.jar].map(([name, cookie]) => ({ name, value: cookie.value })),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => { state.jar.set(name, { value, options }); },
    delete: (cookie: string | { name: string }) => { state.jar.delete(typeof cookie === 'string' ? cookie : cookie.name); },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!state.userId || state.authError) throw new Error('NEXT_REDIRECT /login');
    return { user: { id: state.userId } };
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/security/app-lock-store', () => ({
  readAppLockRecord: async () => {
    state.reads++;
    state.beforeRead?.();
    if (state.readError) return { ok: false, error: new Error('preferences unavailable') };
    return { ok: true, record: structuredClone(state.record) };
  },
  replaceAppLockRecord: async (userId: string, expectedRevision: string | null, config: AppLockConfig | null) => {
    state.beforeWrite?.();
    if ((state.record?.revision ?? null) !== expectedRevision) return { ok: false, reason: 'conflict' };
    state.writes++;
    state.record = { userId, config, revision: crypto.randomUUID() };
    return { ok: true, record: structuredClone(state.record) };
  },
}));

type Db = ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let db: Db;
let lock: AppLockConfig;
const actions = () => import('@/app/(app)/settings/app-lock-actions');
const prefs = () => db.table('user_preferences')[0].notification_prefs as Record<string, unknown>;

function claims() {
  return { sub: state.userId, session_id: state.sessionId, exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) + state.tokenRevision };
}

function token() {
  return `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.fixture-signature`;
}

function replaceLock(next: AppLockConfig) {
  state.record = { userId: ANA, config: next, revision: crypto.randomUUID() };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INTERNAL_SECRET', 'app-lock-adversarial-test-secret');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
  state.userId = ANA;
  state.sessionId = SESSION_A;
  state.tokenRevision = 0;
  state.authError = false;
  state.rpcReply = undefined;
  state.rpcThrows = false;
  state.rpcCalls = [];
  state.readError = false;
  state.reads = 0;
  state.writes = 0;
  state.beforeRead = null;
  state.beforeWrite = null;
  state.jar.clear();
  lock = await buildAppLockConfig(PIN);
  replaceLock(lock);
  db = createInMemorySupabase<SupabaseClient<Database>>({
    userId: ANA,
    rpc: { rate_limit_hit: (args, fake) => {
      state.rpcCalls.push(args);
      if (state.rpcThrows) throw new Error('rate limit database unavailable');
      return state.rpcReply === undefined ? rateLimitHit(args, fake) : state.rpcReply;
    } },
  });
  Object.assign(db.auth, {
    getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null }, error: state.authError ? new Error('Auth unavailable') : null }),
    getClaims: async () => ({ data: state.userId ? { claims: claims() } : null, error: state.authError ? new Error('Auth unavailable') : null }),
    getSession: async () => ({ data: { session: state.userId ? { access_token: token(), user: { id: state.userId } } : null }, error: state.authError ? new Error('Auth unavailable') : null }),
  });
  db.seed('user_preferences', [{ user_id: ANA, notification_prefs: { email: true }, updated_at: '2026-10-25T12:00:00.000Z' }]);
  state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('App Lock uses the shared signing-key configuration policy', () => {
  it.each([...PUBLISHED_SECRET_PLACEHOLDERS])('does not report production readiness for the example value %s', async (value) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_SECRET', value);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', value);
    const { canSignAppUnlock } = await import('@/lib/security/app-lock-server');
    expect(canSignAppUnlock()).toBe(false);
    expect(state.reads).toBe(0);
    expect(state.writes).toBe(0);
  });

  it.each(['INTERNAL_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'])('remains ready when %s has an independently configured value', async (name) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_SECRET', 'generate_a_random_string');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'your-service-role-secret-key');
    vi.stubEnv(name, 'app-lock-configured-key-fixture');
    const { canSignAppUnlock } = await import('@/lib/security/app-lock-server');
    expect(canSignAppUnlock()).toBe(true);
  });

  it('retains the development fallback outside production', async () => {
    vi.stubEnv('INTERNAL_SECRET', undefined);
    const { canSignAppUnlock } = await import('@/lib/security/app-lock-server');
    expect(canSignAppUnlock()).toBe(true);
  });
});

describe('an unlock belongs to the sign-in that earned it', () => {
  it('cannot remove the lock after logout and a new sign-in by the same user', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const oldUnlock = [...state.jar.values()][0].value;
    // Keep the old cookie deliberately: sign-out cleanup is not evidence that
    // a later request presenting it belongs to the session that entered a PIN.
    state.sessionId = SESSION_B;
    expect(await saveAppLockConfig(null)).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual(lock);
    expect([...state.jar.values()][0].value).toBe(oldUnlock);
  });

  it('survives normal access-token renewal inside the same auth session', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const oldToken = token();
    state.tokenRevision++;
    expect(token()).not.toBe(oldToken);
    expect(await saveAppLockConfig({ enabled: false })).toEqual({ ok: true });
    expect(state.record?.config).toMatchObject({ enabled: false });
    expect(prefs()).toEqual({ email: true });
  });

  it('does not issue an unlock when the authenticated session has no session id', async () => {
    state.sessionId = null;
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.jar.size).toBe(0);
  });

  it('Lock now revokes a copied cookie even if somebody restores it afterward', async () => {
    const { unlockAppAction, lockAppAction, saveAppLockConfig } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const copied = new Map(state.jar);
    expect(await lockAppAction()).toEqual({ ok: true });
    for (const [name, value] of copied) state.jar.set(name, value);
    expect(await saveAppLockConfig(null)).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual(lock);
  });
});

describe('the server validates the complete unlock proof', () => {
  it('binds the proof to its user, verified session and private credential revision', async () => {
    const { sealAppUnlock, isAppUnlocked } = await import('@/lib/security/app-lock-server');
    const record = state.record!;
    const proof = sealAppUnlock(ANA, record, SESSION_A);
    expect(proof).not.toBeNull();
    expect(isAppUnlocked(ANA, record, SESSION_A, proof)).toBe(true);
    expect(isAppUnlocked(ANA, record, SESSION_B, proof)).toBe(false);
    expect(isAppUnlocked(ANA, { ...record, revision: crypto.randomUUID() }, SESSION_A, proof)).toBe(false);
    const other = '00000000-0000-4000-8000-0000000000b2';
    expect(isAppUnlocked(other, { ...record, userId: other }, SESSION_A, proof)).toBe(false);
    expect(isAppUnlocked(other, { ...record, userId: other }, SESSION_A, proof!.replace(ANA, other))).toBe(false);
    expect(proof).not.toContain(lock.salt);
    expect(proof).not.toContain(lock.hash);
    expect(proof).not.toContain(PIN);
  });

  it('rejects expired proof even when the browser restores a session cookie', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const { sealAppUnlock, isAppUnlocked, APP_UNLOCK_LIFETIME_MS } = await import('@/lib/security/app-lock-server');
    const record = state.record!;
    const proof = sealAppUnlock(ANA, record, SESSION_A);
    vi.setSystemTime(Date.now() + APP_UNLOCK_LIFETIME_MS - 1);
    expect(isAppUnlocked(ANA, record, SESSION_A, proof)).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect(isAppUnlocked(ANA, record, SESSION_A, proof)).toBe(false);
  });

  it('rejects a modified expiry or signature and malformed cookie bytes', async () => {
    const { sealAppUnlock, isAppUnlocked } = await import('@/lib/security/app-lock-server');
    const record = state.record!;
    const proof = sealAppUnlock(ANA, record, SESSION_A)!;
    const parts = proof.split('.');
    parts[4] = String(Number(parts[4]) + 1);
    for (const candidate of [parts.join('.'), `${proof}.extra`, proof.slice(0, -1), '', 'x'.repeat(401), null, undefined]) {
      expect(isAppUnlocked(ANA, record, SESSION_A, candidate)).toBe(false);
    }
  });

  it('refuses an existing proof after its production signing key becomes unavailable', async () => {
    const { sealAppUnlock, isAppUnlocked } = await import('@/lib/security/app-lock-server');
    const record = state.record!;
    const proof = sealAppUnlock(ANA, record, SESSION_A);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_SECRET', undefined);
    expect(isAppUnlocked(ANA, record, SESSION_A, proof)).toBe(false);
  });

  it('verifies the exact token whose session id is read', async () => {
    const { readAppLockSessionId } = await import('@/lib/security/app-lock-server');
    const expected = token();
    const verified = vi.spyOn(db.auth, 'getUser');
    expect(await readAppLockSessionId(db, ANA)).toBe(SESSION_A);
    expect(verified).toHaveBeenCalledWith(expected);
  });

  it('rejects a session token that Auth attributes to a different user', async () => {
    const { readAppLockSessionId } = await import('@/lib/security/app-lock-server');
    vi.spyOn(db.auth, 'getUser').mockResolvedValue({ data: { user: { id: '00000000-0000-4000-8000-0000000000b2' } }, error: null } as never);
    expect(await readAppLockSessionId(db, ANA)).toBeNull();
  });
});

describe('a concurrent PIN change revokes permission to change the lock', () => {
  it('cannot remove a new PIN installed after the permission check', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const next = await buildAppLockConfig('9090');
    state.beforeWrite = () => { state.beforeWrite = null; replaceLock(next); };
    expect(await saveAppLockConfig(null)).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual(next);
    expect(state.writes).toBe(0);
  });

  it('rechecks the current PIN after losing the compare-and-set race', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const next = await buildAppLockConfig('9090');
    let raced = false;
    state.beforeWrite = () => {
      if (!raced) { raced = true; replaceLock(next); }
    };
    expect(await saveAppLockConfig({ enabled: true, pin: '1234' })).toMatchObject({ ok: false });
    expect(raced, 'the guarded write met a concurrent PIN rotation').toBe(true);
    expect(state.record?.config).toEqual(next);
    expect(state.writes).toBe(0);
  });

  it('does not issue an in-flight unlock after its PIN or lock revision changes', async () => {
    const next = await buildAppLockConfig('9090');
    state.beforeRead = () => { if (state.reads === 2) replaceLock(next); };
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.record?.config).toEqual(next);
    expect(state.jar.size).toBe(0);
  });
});

describe('the settings action accepts commands without exposing a verifier', () => {
  it('refuses a trailing newline in a new PIN before persisting a credential', async () => {
    replaceLock({ ...lock, enabled: false });
    const { saveAppLockConfig } = await actions();
    expect(await saveAppLockConfig({ enabled: true, pin: '4071\n' })).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual({ ...lock, enabled: false });
    expect(state.writes).toBe(0);
  });

  it('rejects a legacy browser-created verifier even when the existing lock is disabled', async () => {
    replaceLock({ ...lock, enabled: false });
    const { saveAppLockConfig } = await actions();
    expect(await saveAppLockConfig(lock)).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual({ ...lock, enabled: false });
    expect(state.writes).toBe(0);
  });

  it('returns only status to an unlocked browser and refuses a locked browser', async () => {
    const { unlockAppAction, getAppLockSettings } = await actions();
    expect(await getAppLockSettings()).toMatchObject({ ok: false });
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    expect(await getAppLockSettings()).toEqual({ ok: true, enabled: true, hasPin: true });
  });
});

describe('an unavailable unlock boundary stays closed', () => {
  it('does not check the PIN or mint an unlock when the durable limiter is unavailable', async () => {
    state.rpcThrows = true;
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toMatchObject({ ok: false });
    expect(state.rpcCalls).toHaveLength(1);
    expect(db.log).toEqual([]);
    expect(state.reads).toBe(0);
    expect(state.jar.size).toBe(0);
  });

  it.each([null, [], [{ allowed: 'yes' }], [{ allowed: true }, { allowed: true }]])('refuses a malformed limiter answer: %j', async (reply) => {
    state.rpcReply = reply;
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toMatchObject({ ok: false });
    expect(db.log).toEqual([]);
    expect(state.reads).toBe(0);
    expect(state.jar.size).toBe(0);
  });

  it('does not treat a failed preference read as an absent lock', async () => {
    state.readError = true;
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.jar.size).toBe(0);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(PIN);
  });

  it('refuses an unverified user before spending attempts or reading preferences', async () => {
    state.authError = true;
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.rpcCalls).toEqual([]);
    expect(db.log).toEqual([]);
    expect(state.jar.size).toBe(0);
  });

  it('does not use the public development key when production secrets are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_SECRET', '   ');
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.jar.size).toBe(0);
  });

  it('does not turn on an unusable lock when production cannot sign an unlock', async () => {
    replaceLock({ ...lock, enabled: false });
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_SECRET', undefined);
    const { saveAppLockConfig } = await actions();
    expect(await saveAppLockConfig({ enabled: true })).toMatchObject({ ok: false });
    expect(state.record?.config).toEqual({ ...lock, enabled: false });
    expect(state.writes).toBe(0);
    expect(state.jar.size).toBe(0);
  });

  it.each([null, 4071, {}, [], '', '4071\n', '４０７１'])('refuses a malformed PIN without issuing an unlock: %j', async (pin) => {
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(pin as string)).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(state.jar.size).toBe(0);
  });
});
