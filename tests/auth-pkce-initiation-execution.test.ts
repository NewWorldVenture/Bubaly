import { createHash } from 'node:crypto';
import { serializeCookieHeader, stringToBase64URL } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ all: vi.fn(), header: vi.fn(), write: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: seam.all, set: seam.write }),
  headers: async () => ({ get: seam.header }),
}));
import { createPkceCookieExchange } from '@/lib/auth/recovery-cookies';
import { completeCallback } from '@/lib/auth/callback-server';
import type { CallbackInput } from '@/lib/auth/callback';
import { callbackAdmissionMaterial } from '@/lib/auth/callback-witness';
import { encodePkceInitiationRecord, pkceInitiationCookieName, type PkceInitiationKind, type PkceInitiationRecord } from '@/lib/auth/pkce-initiation';

const ORIGIN = 'https://initiation-execution.supabase.co';
const KEY = 'sb-initiation-execution-auth-token';
const VERIFIER = `${KEY}-code-verifier`;
const RECORD = pkceInitiationCookieName(KEY);
const NONCE = 'a'.repeat(32);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
type Cookie = { name: string; value: string };
let jar: Cookie[];
const provider = vi.fn<typeof fetch>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const encoded = (value: unknown) => `base64-${stringToBase64URL(JSON.stringify(value))}`;
function session(userId = A, sessionId = A, revision = 1) {
  const claims = stringToBase64URL(JSON.stringify({ sub: userId, session_id: sessionId, exp: 4_000_000_000, revision }));
  return encoded({ user: { id: userId }, access_token: `eyJhbGciOiJIUzI1NiJ9.${claims}.synthetic`, refresh_token: `refresh-${revision}` });
}
function set(name: string, value: string) { jar = jar.filter(cookie => cookie.name !== name).concat({ name, value }); }
function seal(kind: PkceInitiationKind = 'oauth'): PkceInitiationRecord {
  const material = callbackAdmissionMaterial(jar, KEY);
  if (!material) throw new Error('Invalid initiation fixture');
  const record: PkceInitiationRecord = { v: 1, nonce: NONCE, kind, project: digest(material.project),
    generation: digest(material.generation), verifier: digest(material.verifier), session: digest(material.session) };
  set(RECORD, encodePkceInitiationRecord(record));
  return record;
}
function options(attempt = NONCE, recovery = false) {
  const verifier = jar.filter(cookie => cookie.name === VERIFIER || cookie.name.startsWith(`${VERIFIER}.`))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { attempt, recovery, verifierFingerprint: digest(JSON.stringify(verifier)), fetch: provider };
}
async function expectRefusal(input = options()) {
  const outcome = await createPkceCookieExchange(input).then(value => ({ value, error: null }), error => ({ value: null, error }));
  await outcome.value?.dispose();
  expect(outcome.value !== null).toBe(false);
  expect(outcome.error).toMatchObject({ name: 'RecoveryError', key: 'authRecovery.sessionChanged' });
}
async function expectAdmission(input = options()) {
  const exchange = await createPkceCookieExchange(input);
  try { expect(exchange.origin).toBe(ORIGIN); }
  finally { await exchange.dispose(); }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.invalid');
  jar = [{ name: KEY, value: session() }, { name: VERIFIER, value: encoded('synthetic-verifier') }];
  seal();
  // Next's parsed cookie store collapses duplicate names. The raw request must
  // remain authoritative, including when these two request views disagree.
  seam.all.mockReset().mockImplementation(() => [...new Map(jar.map(cookie => [cookie.name, cookie.value]))]
    .map(([name, value]) => ({ name, value })));
  seam.header.mockReset().mockImplementation(name => name === 'cookie'
    ? jar.map(cookie => serializeCookieHeader(cookie.name, cookie.value, {})).join('; ') : null);
  seam.write.mockReset();
  provider.mockReset().mockImplementation(async () => { throw new Error('No provider request is expected while admitting a verifier'); });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => {
  expect(provider).not.toHaveBeenCalled(); expect(seam.write).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('PKCE exchange requires the original initiation owner before constructing authority', () => {
  it.each([undefined, null, 123, 'A'.repeat(32)])('rejects a missing or malformed action attempt %j before reading request cookies', async attempt => {
    const input = { code: 'synthetic-code', next: '/home', verifierFingerprint: options().verifierFingerprint, attempt };
    expect(await completeCallback(input as unknown as CallbackInput)).toMatchObject({ status: 'rejected' });
    expect(seam.header).not.toHaveBeenCalled(); expect(seam.all).not.toHaveBeenCalled();
  });
  it.each(['oauth', 'signup', 'recovery'] as const)('admits matching %s proof without cookie writes or ambient renewal', async kind => {
    seal(kind); const before = [...jar];
    await expectAdmission(options(NONCE, kind === 'recovery'));
    expect(jar).toEqual(before);
  });
  it.each(['missing', 'malformed', 'duplicate', 'chunked', 'oversized'] as const)('refuses %s initiation metadata', async kind => {
    if (kind === 'missing') jar = jar.filter(cookie => cookie.name !== RECORD);
    if (kind === 'malformed') set(RECORD, 'invalid');
    if (kind === 'duplicate') jar.push({ ...jar.find(cookie => cookie.name === RECORD)! });
    if (kind === 'chunked') { const value = jar.find(cookie => cookie.name === RECORD)!.value; jar = jar.filter(cookie => cookie.name !== RECORD); set(`${RECORD}.0`, value); }
    if (kind === 'oversized') set(RECORD, 'x'.repeat(1025));
    await expectRefusal();
  });
  it.each(['', 'b'.repeat(32), 'A'.repeat(32), 'a'.repeat(33)])('refuses invalid or different callback nonce %j', async attempt => {
    await expectRefusal(options(attempt));
  });
  it.each([['recovery', false], ['signup', true], ['oauth', true]] as const)('refuses %s proof with recovery=%s', async (kind, recovery) => {
    seal(kind); await expectRefusal(options(NONCE, recovery));
  });
  it.each(['project', 'generation', 'verifier', 'session'] as const)('checks the %s hash independently', async field => {
    const record = seal(); record[field] = '0'.repeat(64); set(RECORD, encodePkceInitiationRecord(record));
    await expectRefusal();
  });
  it('rejects a callback first arriving after logout even if old verifier deletion failed', async () => {
    set(`${KEY}-logout-generation`, 'newer-logout'); await expectRefusal();
  });
  it('rejects a callback first arriving after another account signs in', async () => {
    set(KEY, session(B, B)); await expectRefusal();
  });
  it('rejects a new session for the same user', async () => {
    set(KEY, session(A, B)); await expectRefusal();
  });
  it('permits token rotation within the original user and session identity', async () => {
    set(KEY, session(A, A, 2)); await expectAdmission();
  });
  it('binds the exact verifier even if the action captures the replacement fingerprint', async () => {
    set(VERIFIER, encoded('newer-verifier')); await expectRefusal();
  });
  it.each([KEY, VERIFIER, `${KEY}-logout-generation`])('rejects duplicate raw request cookies for %s even when parsed cookies collapse them', async name => {
    if (name.endsWith('-logout-generation')) { set(name, 'original'); seal(); }
    const captured = options();
    jar.push({ ...jar.find(cookie => cookie.name === name)! });
    await expectRefusal(captured);
  });
  it('compares exact bytes for identityless session storage', async () => {
    set(KEY, 'identityless-original'); seal(); await expectAdmission();
    set(KEY, 'identityless-replaced'); await expectRefusal();
  });
  it('admits an unchanged signed-out owner and ignores unrelated project cookies', async () => {
    jar = jar.filter(cookie => cookie.name !== KEY); seal();
    jar.push({ name: 'sb-other-auth-token', value: 'unrelated' }, { name: 'sb-other-auth-token', value: 'duplicate-unrelated' });
    await expectAdmission();
  });
});
