import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bearerMatches, secretsMatch } from '@/lib/server/secret-compare';
import { hasCronAuthorization, hasInternalSecret } from '@/lib/server/cron-auth';

// F-E08. `provided === expected` on a shared secret returns in a number of
// steps proportional to how many leading characters match, so a caller who can
// time the answer learns the secret one character at a time. The four call
// sites authorize a cron run, an internal server-to-server call, an emergency
// SMS and voice blast to every parent, and an inbound-email ingress.
//
// The property that must survive the change is the OTHER one these functions
// have always had: an unset secret means disabled, never "everything matches".
// A constant-time compare that returns true for two empty strings would be a
// worse bug than the one it fixed.

const SECRET = 'a-long-shared-secret-value';

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/api/cron/x', { headers });
}

describe('comparing a presented secret to the real one', () => {
  it('matches only an exact value', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretsMatch(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretsMatch(SECRET.toUpperCase(), SECRET)).toBe(false);
    // A long shared prefix is the case a timing attack builds toward, and it
    // must be as false as a value sharing nothing at all.
    expect(secretsMatch(`${SECRET.slice(0, -1)}!`, SECRET)).toBe(false);
  });

  it('never treats an absent secret as a match', () => {
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(undefined, undefined)).toBe(false);
    expect(secretsMatch(null, SECRET)).toBe(false);
    expect(secretsMatch(SECRET, '')).toBe(false);
    expect(secretsMatch(SECRET, undefined)).toBe(false);
  });

  it('does not throw on a length mismatch, which is what timingSafeEqual does', () => {
    expect(() => secretsMatch('short', 'a-much-longer-secret')).not.toThrow();
    expect(secretsMatch('short', 'a-much-longer-secret')).toBe(false);
  });

  it('handles multi-byte values by their bytes, not their code points', () => {
    expect(secretsMatch('sécret—π', 'sécret—π')).toBe(true);
    expect(secretsMatch('sécret—π', 'secret—π')).toBe(false);
  });

  it('builds the bearer form itself, so "Bearer undefined" can never be minted', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
    expect(bearerMatches('Bearer undefined', undefined)).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
  });
});

describe('the callbacks these protect', () => {
  it('admits the right Authorization header and nothing else', () => {
    expect(hasCronAuthorization(req({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe(true);
    expect(hasCronAuthorization(req({ authorization: `Bearer ${SECRET}x` }), SECRET)).toBe(false);
    expect(hasCronAuthorization(req({ authorization: SECRET }), SECRET)).toBe(false);
    expect(hasCronAuthorization(req({}), SECRET)).toBe(false);
  });

  it('is disabled, not open, when the secret is unset', () => {
    expect(hasCronAuthorization(req({ authorization: 'Bearer undefined' }), undefined)).toBe(false);
    expect(hasCronAuthorization(req({ authorization: 'Bearer ' }), '')).toBe(false);
    expect(hasInternalSecret(req({ 'x-internal-secret': '' }), '')).toBe(false);
    expect(hasInternalSecret(req({ 'x-internal-secret': 'anything' }), undefined)).toBe(false);
  });

  it('admits the right internal-secret header and nothing else', () => {
    expect(hasInternalSecret(req({ 'x-internal-secret': SECRET }), SECRET)).toBe(true);
    expect(hasInternalSecret(req({ 'x-internal-secret': SECRET.slice(0, -1) }), SECRET)).toBe(false);
    expect(hasInternalSecret(req({}), SECRET)).toBe(false);
  });
});

describe('no shared-secret call site compares with ===', () => {
  // The fix is only worth anything if the next one does not go back to `===`.
  // Each of these files authorizes on a shared secret; none may decide it by
  // string equality.
  const SITES = [
    'lib/server/cron-auth.ts',
    'app/api/guardian/escalate/route.ts',
    'app/api/contact-center/email/route.ts',
  ];

  it('each reaches the constant-time comparison', () => {
    for (const file of SITES) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/secretsMatch\(|bearerMatches\(/);
    }
  });

  it('none of them compares a secret with === any more', () => {
    const offenders: string[] = [];
    for (const file of SITES) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
      // A secret named on either side of an equality, in code rather than prose.
      if (/(===|!==)\s*(`?Bearer|secret\b|SECRET\b)|\b(secret|provided|authHeader)\s*(===|!==)/i.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders, `shared-secret comparison by string equality:\n${offenders.join('\n')}`).toEqual([]);
  });
});
