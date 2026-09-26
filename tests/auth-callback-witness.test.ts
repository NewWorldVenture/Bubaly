import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stringToBase64URL } from '@supabase/ssr';
import { callbackAdmissionMaterial, encodeCallbackAdmissionWitness, parseCallbackAdmissionCookies, parseCallbackAdmissionWitness, type CallbackAdmissionWitness } from '@/lib/auth/callback-witness';

const key = 'sb-witness-project-auth-token';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId = '11111111-1111-4111-8111-111111111111';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = (name: string, value: string) => ({ name, value });
function session(rotation: string, owner = userId, sid = sessionId) {
  const token = `header.${stringToBase64URL(JSON.stringify({ sub: owner, session_id: sid, rotation }))}.signature`;
  return `base64-${stringToBase64URL(JSON.stringify({ access_token: token, refresh_token: rotation, user: { id: owner } }))}`;
}
function witness(cookies: Array<{ name: string; value: string }> = []): CallbackAdmissionWitness {
  const material = callbackAdmissionMaterial(cookies, key)!;
  return { v: 1, project: hash(material.project), generation: hash(material.generation), verifier: hash(material.verifier), session: hash(material.session) };
}
describe('request-time callback comparison witness', () => {
  it('retains same-name cookies on different paths so ambiguity cannot be hashed away', () => {
    const cookies = parseCallbackAdmissionCookies(`${key}=one; unrelated=a%20b; ${key}=two`)!;
    expect(cookies).toEqual([cookie(key, 'one'), cookie('unrelated', 'a b'), cookie(key, 'two')]);
    expect(callbackAdmissionMaterial(cookies, key)).toBeNull();
  });
  it('bounds raw header parsing before splitting and hashing', () => {
    expect(parseCallbackAdmissionCookies('x'.repeat(1024 * 1024 + 1))).toBeNull();
    expect(parseCallbackAdmissionCookies('a=b;'.repeat(4096))).toBeNull();
    expect(parseCallbackAdmissionCookies(null)).toEqual([]);
  });
  it('contains only hashes and round-trips the canonical bounded contract', () => {
    const original = witness([cookie(key, session('sensitive-refresh')), cookie(`${key}-code-verifier`, 'sensitive-verifier')]);
    const encoded = encodeCallbackAdmissionWitness(original);
    expect(encoded.length).toBeLessThanOrEqual(512);
    expect(parseCallbackAdmissionWitness(encoded)).toEqual(original);
    expect(Buffer.from(encoded, 'base64url').toString()).not.toMatch(/sensitive|aaaa|1111/);
  });
  it('treats token rotation and chunk layouts for the same session as the same owner', () => {
    const value = session('rotated');
    const first = witness([cookie(key, session('original'))]);
    const second = witness([cookie(`${key}.1`, value.slice(40)), cookie(`${key}.0`, value.slice(0, 40))]);
    expect(second.session).toBe(first.session);
    expect(witness([cookie(key, session('new-login', userId, '22222222-2222-4222-8222-222222222222'))]).session).not.toBe(first.session);
  });
  it('distinguishes empty, malformed and legacy storage by exact bounded cookies', () => {
    const empty = witness().session;
    const bad = witness([cookie(key, '{malformed')]).session;
    expect(bad).not.toBe(empty);
    expect(witness([cookie(key, '{changed')]).session).not.toBe(bad);
    expect(witness([cookie(`${key}-user`, 'legacy-user')]).session).not.toBe(empty);
  });
  it('includes empty-slot logout and exact verifier changes, excluding other projects', () => {
    const empty = witness();
    expect(witness([cookie(`${key}-logout-generation`, 'new-decision')]).generation).not.toBe(empty.generation);
    expect(witness([cookie(`${key}-code-verifier`, 'pending')]).verifier).not.toBe(empty.verifier);
    expect(witness([cookie('sb-other-auth-token', 'foreign'), cookie('unrelated', 'value')])).toEqual(empty);
  });
  for (const cookies of [
    [cookie(`${key}-logout-generation`, 'a'), cookie(`${key}-logout-generation`, 'b')],
    [cookie(key, 'a'), cookie(key, 'b')],
    [cookie(`${key}-code-verifier`, 'whole'), cookie(`${key}-code-verifier.0`, 'chunk')],
    [cookie(`${key}-code-verifier.1`, 'gap')],
    [cookie(`${key}-code-verifier`, '')],
    [cookie(`${key}-code-verifier`, 'x'.repeat(256 * 1024 + 1))],
    [cookie(`${key}-logout-generation`, 'x'.repeat(1025))],
  ]) it('rejects ambiguous or oversized comparison material', () => { expect(callbackAdmissionMaterial(cookies, key)).toBeNull(); });
  for (const value of [null, undefined, '', 'bad', 'x'.repeat(513), {}, [],
    stringToBase64URL(JSON.stringify({ ...witness(), v: 2 })),
    stringToBase64URL(JSON.stringify({ ...witness(), extra: 'value' })),
    stringToBase64URL(JSON.stringify({ ...witness(), generation: 'raw-generation' })),
    stringToBase64URL(' ' + JSON.stringify(witness())),
  ]) it('rejects malformed, noncanonical or unsupported supplied witnesses', () => { expect(parseCallbackAdmissionWitness(value)).toBeNull(); });
});
