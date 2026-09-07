import { describe, expect, it } from 'vitest';
import {
  describeKey, projectScheme, schemeMismatch, isCredentialRejection,
} from '../scripts/lib/service-key-format.mjs';

// Every fixture below is a SHAPE, never a real credential: the payloads are
// obvious filler. Format is all these helpers inspect.
const SECRET = 'sb_secret_' + 'x'.repeat(32);
const PUBLISHABLE = 'sb_publishable_' + 'x'.repeat(32);
const LEGACY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig';

describe('describeKey', () => {
  it('tells the two new-format keys apart — the easiest wrong paste to make', () => {
    expect(describeKey(SECRET).format).toBe('secret');
    expect(describeKey(PUBLISHABLE).format).toBe('publishable');
  });

  it('recognises a legacy JWT', () => {
    expect(describeKey(LEGACY_JWT).format).toBe('legacy-jwt');
  });

  it('flags a quoted value, which looks correct in a dashboard and is not', () => {
    expect(describeKey(`"${SECRET}"`).format).toBe('quoted');
    expect(describeKey(`'${SECRET}'`).format).toBe('quoted');
  });

  it('flags stray whitespace, the classic copy-paste failure', () => {
    expect(describeKey(`  ${SECRET}\n`).untrimmed).toBe(true);
    expect(describeKey(SECRET).untrimmed).toBe(false);
  });

  it('reports length so a truncated paste is visible', () => {
    expect(describeKey(`  ${SECRET}  `).length).toBe(SECRET.length);
  });

  it('calls a placeholder unrecognised — .env.example ships one', () => {
    expect(describeKey('your-service-role-secret-key').format).toBe('unrecognised');
  });

  it('never returns the key itself', () => {
    expect(JSON.stringify(describeKey(SECRET))).not.toContain('xxxx');
  });
});

describe('projectScheme', () => {
  it('reads the scheme from the public publishable key', () => {
    expect(projectScheme(PUBLISHABLE)).toBe('new-format');
    expect(projectScheme(LEGACY_JWT)).toBe('legacy-jwt');
    expect(projectScheme(undefined)).toBeNull();
  });
});

describe('schemeMismatch', () => {
  // The state bubaly.com is in: the bundle serves an sb_publishable_ key, so the
  // project is on new-format keys, and a legacy JWT service key is no longer
  // registered — which is precisely "Unregistered API key" on every read.
  it('catches a legacy service key on a new-format project', () => {
    expect(schemeMismatch(PUBLISHABLE, 'legacy-jwt')).toEqual({ project: 'new-format', key: 'legacy-jwt' });
  });

  it('catches the reverse', () => {
    expect(schemeMismatch(LEGACY_JWT, 'secret')).toEqual({ project: 'legacy-jwt', key: 'new-format' });
  });

  it('is quiet when the schemes agree', () => {
    expect(schemeMismatch(PUBLISHABLE, 'secret')).toBeNull();
    expect(schemeMismatch(LEGACY_JWT, 'legacy-jwt')).toBeNull();
  });

  it('does not guess when the key is unrecognised or quoted', () => {
    expect(schemeMismatch(PUBLISHABLE, 'unrecognised')).toBeNull();
    expect(schemeMismatch(PUBLISHABLE, 'quoted')).toBeNull();
  });
});

describe('isCredentialRejection', () => {
  it('recognises what production actually returned', () => {
    expect(isCredentialRejection(['{"message":"Unregistered API key"}'])).toBe(true);
    expect(isCredentialRejection(['Invalid Compact JWS'])).toBe(true);
    expect(isCredentialRejection(['JWSError JWSInvalidSignature'])).toBe(true);
  });

  it('does not claim a credential fault for an ordinary error', () => {
    expect(isCredentialRejection(['relation "public.families" does not exist'])).toBe(false);
    expect(isCredentialRejection([''])).toBe(false);
  });
});
