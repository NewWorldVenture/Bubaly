import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stringToBase64URL } from '@supabase/ssr';
import { callbackAdmissionMaterial } from '../lib/auth/callback-witness';
import { encodePkceInitiationRecord, isPkceInitiationNonce, parsePkceInitiationRecord, pkceInitiationCookieName,
  readPkceInitiationSlot, type PkceInitiationKind, type PkceInitiationRecord } from '../lib/auth/pkce-initiation';

const key = 'sb-initiation-project-auth-token';
const name = `${key}-pkce-initiation`;
const nonce = '0123456789abcdef0123456789abcdef';
const cookie = (name: string, value: string) => ({ name, value });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function record(cookies: Array<{ name: string; value: string }> = [], kind: PkceInitiationKind = 'oauth'): PkceInitiationRecord {
  const material = callbackAdmissionMaterial(cookies, key)!;
  return { v: 1, project: hash(material.project), generation: hash(material.generation), verifier: hash(material.verifier),
    session: hash(material.session), nonce, kind };
}
function session(rotation: string, sessionId = 'owned-session') {
  const token = `header.${stringToBase64URL(JSON.stringify({ sub: 'owned-user', session_id: sessionId, rotation }))}.signature`;
  return `base64-${stringToBase64URL(JSON.stringify({ access_token: token, refresh_token: rotation, user: { id: 'owned-user' } }))}`;
}
const encodeRaw = (value: unknown) => stringToBase64URL(JSON.stringify(value));

describe('PKCE initiation comparison record', () => {
  for (const kind of ['signup', 'oauth', 'recovery'] as const) it(`round-trips a bounded canonical ${kind} record containing no raw credentials`, () => {
    const original = record([cookie(key, session('sensitive-refresh')), cookie(`${key}-code-verifier`, 'sensitive-verifier')], kind);
    const encoded = encodePkceInitiationRecord(original);
    expect(encoded.length).toBeLessThanOrEqual(1024);
    expect(parsePkceInitiationRecord(encoded)).toEqual(original);
    expect(Buffer.from(encoded, 'base64url').toString()).not.toMatch(/sensitive|owned-user|owned-session/);
    expect(readPkceInitiationSlot([cookie(name, encoded)], key)).toEqual({ raw: encoded, record: original });
  });

  it('keeps stable session identity through token rotation while preserving other ownership hashes', () => {
    const before = record([cookie(key, session('first')), cookie(`${key}-code-verifier`, 'original')]);
    const rotated = session('rotated');
    const after = record([cookie(`${key}.1`, rotated.slice(45)), cookie(`${key}.0`, rotated.slice(0, 45)), cookie(`${key}-code-verifier`, 'original')]);
    expect(parsePkceInitiationRecord(encodePkceInitiationRecord(after))).toEqual(before);
    expect(record([cookie(key, session('new-login', 'new-session'))]).session).not.toBe(before.session);
    expect(record([cookie(`${key}-logout-generation`, 'decision')]).generation).not.toBe(before.generation);
    expect(record([cookie(`${key}-code-verifier`, 'replacement')]).verifier).not.toBe(before.verifier);
    expect(encodePkceInitiationRecord({ ...before, nonce: 'f'.repeat(32) })).not.toBe(encodePkceInitiationRecord(before));
  });

  it('does not accept additional raw credentials or silently discard unexpected fields', () => {
    const invalid = { ...record(), access_token: 'sensitive-token' };
    expect(parsePkceInitiationRecord(encodeRaw(invalid))).toBeNull();
    expect(() => encodePkceInitiationRecord(invalid)).toThrow('Invalid PKCE initiation record');
  });

  for (const field of ['v', 'project', 'generation', 'verifier', 'session', 'nonce', 'kind']) it(`requires the exact ${field} field`, () => {
    const partial: Record<string, unknown> = { ...record() };
    delete partial[field];
    expect(parsePkceInitiationRecord(encodeRaw(partial))).toBeNull();
  });
  for (const field of ['project', 'generation', 'verifier', 'session']) {
    for (const value of ['A'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), 'f'.repeat(64) + '\n', 'raw-credential', 123, null]) {
      it(`rejects an invalid ${field} hash (${typeof value === 'string' ? value.length : typeof value})`, () => {
        expect(parsePkceInitiationRecord(encodeRaw({ ...record(), [field]: value }))).toBeNull();
      });
    }
  }
  for (const value of [null, undefined, '', [], {}, 1, 'f'.repeat(31), 'f'.repeat(33), 'A'.repeat(32), 'g'.repeat(32), nonce + '\n']) {
    it('rejects unsupported nonce values', () => {
      expect(isPkceInitiationNonce(value)).toBe(false);
      expect(parsePkceInitiationRecord(encodeRaw({ ...record(), nonce: value }))).toBeNull();
    });
  }
  it('accepts only exact lowercase hexadecimal nonces', () => { expect(isPkceInitiationNonce(nonce)).toBe(true); });
  for (const value of [null, undefined, '', {}, [], 'bad', 'x'.repeat(1025),
    encodeRaw(null), encodeRaw([]), encodeRaw({ ...record(), v: 2 }), encodeRaw({ ...record(), v: '1' }),
    encodeRaw({ ...record(), kind: 'password' }), encodeRaw({ ...record(), kind: 'OAuth' }),
    encodeRaw(Object.fromEntries(Object.entries(record()).reverse())),
    stringToBase64URL(' ' + JSON.stringify(record())),
    stringToBase64URL(JSON.stringify(record(), null, 2)),
    stringToBase64URL(JSON.stringify(record()).replace('{', '{"v":1,')),
    encodePkceInitiationRecord(record()) + '=',
  ]) it('rejects malformed, reordered, duplicate-key or unsupported encoded records', () => {
    expect(parsePkceInitiationRecord(value)).toBeNull();
  });
});

describe('configured-project initiation cookie slot', () => {
  it('distinguishes a missing slot from a bounded malformed slot for guarded replacement', () => {
    expect(readPkceInitiationSlot([], key)).toEqual({ raw: null, record: null });
    for (const raw of ['', 'malformed', 'x'.repeat(1024)]) {
      expect(readPkceInitiationSlot([cookie(name, raw)], key)).toEqual({ raw, record: null });
    }
  });
  it('ignores other projects and ordinary cookie names', () => {
    expect(pkceInitiationCookieName(key)).toBe(name);
    expect(readPkceInitiationSlot([cookie('sb-other-auth-token-pkce-initiation', 'x'.repeat(1025)),
      cookie('sb-other-auth-token-pkce-initiation.0', 'chunk'), cookie(key, 'session'), cookie(`${name}-other`, 'unrelated')], key))
      .toEqual({ raw: null, record: null });
  });
  for (const cookies of [
    [cookie(name, 'same'), cookie(name, 'same')],
    [cookie(name, 'first'), cookie(name, 'second')],
    [cookie(`${name}.0`, 'chunk')],
    [cookie(`${name}.00`, 'unsupported')],
    [cookie(`${name}.x`, 'unsupported')],
    [cookie(`${name}.`, 'unsupported')],
    [cookie(name, encodePkceInitiationRecord(record())), cookie(`${name}.1`, 'chunk')],
    [cookie(name, 'x'.repeat(1025))],
    [{ name, value: null } as unknown as { name: string; value: string }],
  ]) it('rejects ambiguous, chunked, oversized or unsupported owned storage', () => {
    expect(readPkceInitiationSlot(cookies, key)).toBeNull();
  });
  for (const malformed of [null, [null], [{ name: null, value: 'invalid' }]]) it('fails closed on unsupported cookie entry shapes', () => {
    expect(readPkceInitiationSlot(malformed as unknown as Array<{ name: string; value: string }>, key)).toBeNull();
  });
  for (const invalid of ['', 'other', 'sb--auth-token', 'sb-project-auth-token; injected', 'sb-project-auth-token.0', key + '\n',
    `sb-${'p'.repeat(244)}-auth-token`, null as unknown as string]) it('rejects invalid or oversized storage keys', () => {
    expect(() => pkceInitiationCookieName(invalid)).toThrow('Invalid auth storage key');
    expect(readPkceInitiationSlot([], invalid)).toBeNull();
  });
  it('accepts a storage key at the shared maximum length', () => {
    const maxKey = `sb-${'p'.repeat(242)}-auth-token`;
    expect(maxKey.length).toBe(256);
    expect(pkceInitiationCookieName(maxKey)).toBe(`${maxKey}-pkce-initiation`);
  });
});
