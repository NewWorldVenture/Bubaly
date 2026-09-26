import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { secretEquals } from '@/lib/server/secret-equals';
import { hasCronAuthorization, hasInternalSecret } from '@/lib/server/cron-auth';

// Every shared secret this server checks goes through one comparison.
//
// `===` on strings short-circuits at the first differing byte, so how long a
// check takes to fail is a function of how much of the secret the caller got
// right. Four places compared a secret that way — the cron header, the internal
// header, the Guardian escalation bearer and the contact-center inbound token —
// while `lib/guardian/twilio.ts` three files away already reached for
// `timingSafeEqual` on the Twilio signature.
//
// The practical risk is small and worth saying so rather than dressing up:
// extracting a secret by remote timing over HTTP against a serverless platform
// is not a real attack. The reason this is here is the shape, which is the same
// shape as every other finding in this sweep — the rule is written down
// somewhere in the repo and was not applied where it counts. These four gate
// every scheduled job, every internal callback, the emergency escalation
// fan-out, and inbound email.

describe('secretEquals', () => {
  it('matches only the exact secret', () => {
    expect(secretEquals('s3cret', 's3cret')).toBe(true);
    expect(secretEquals('s3cret', 's3crey')).toBe(false);
    expect(secretEquals('s3cret', 's3cre')).toBe(false);
    expect(secretEquals('s3cret', 's3cret ')).toBe(false);
    expect(secretEquals('Bearer abc', 'Bearer abc')).toBe(true);
  });

  // `timingSafeEqual` THROWS on a length mismatch, so a naive version needs a
  // length check first — which leaks the length. Hashing both sides first is
  // what makes a differing length answer `false` instead of exploding.
  it('survives a length mismatch instead of throwing', () => {
    expect(() => secretEquals('a', 'a-very-much-longer-secret')).not.toThrow();
    expect(secretEquals('a', 'a-very-much-longer-secret')).toBe(false);
    expect(secretEquals('a'.repeat(5000), 'b')).toBe(false);
  });

  // The property that matters most at all four call sites, and the one that was
  // already right: an unset secret must never turn a missing header into a
  // match, nor `"Bearer undefined"` into a credential.
  it('fails closed when either side is missing', () => {
    expect(secretEquals(null, 'secret')).toBe(false);
    expect(secretEquals(undefined, 'secret')).toBe(false);
    expect(secretEquals('', 'secret')).toBe(false);
    expect(secretEquals('secret', undefined)).toBe(false);
    expect(secretEquals('secret', '')).toBe(false);
    expect(secretEquals(null, null)).toBe(false);
    expect(secretEquals(undefined, undefined)).toBe(false);
  });
});

// The "Bearer undefined" hazard cron-auth.ts's own doc comment warns about
// cannot be tested on `secretEquals` — `` `Bearer ${undefined}` `` IS the string
// "Bearer undefined", so asking whether it equals itself is a tautology, not a
// guard. (That is what the first draft of this file asserted, and it failed for
// the right reason.) The property belongs to the CALL SITE, so test it there.
describe('an unset secret disables the endpoint rather than opening it', () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request('https://example.test/api/cron/x', { headers });

  it('refuses even the literal a missing secret would interpolate', () => {
    expect(hasCronAuthorization(withHeaders({ authorization: 'Bearer undefined' }), undefined)).toBe(false);
    expect(hasCronAuthorization(withHeaders({ authorization: 'Bearer undefined' }), '')).toBe(false);
    expect(hasCronAuthorization(withHeaders({}), undefined)).toBe(false);
    expect(hasInternalSecret(withHeaders({ 'x-internal-secret': 'undefined' }), undefined)).toBe(false);
  });

  it('still admits the real secret', () => {
    expect(hasCronAuthorization(withHeaders({ authorization: 'Bearer s3cret' }), 's3cret')).toBe(true);
    expect(hasCronAuthorization(withHeaders({ authorization: 'Bearer wrong' }), 's3cret')).toBe(false);
    expect(hasInternalSecret(withHeaders({ 'x-internal-secret': 's3cret' }), 's3cret')).toBe(true);
  });
});

/** Line-preserving comment strip, so a reported line number still points at
 *  the offending line. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Comparisons this rule deliberately does not claim.
 *
 * Each names a file and the substring that identifies the line, and each is
 * checked for NON-VACUITY below: an exemption whose line has gone away fails,
 * so the list cannot outlive the code it excuses.
 */
const NOT_A_SECRET_COMPARISON: { file: string; contains: string; why: string }[] = [
  {
    file: 'lib/auth/browser-session-storage.ts',
    contains: "=== `Bearer ${currentToken}`",
    why: 'Both sides are values this BROWSER already holds: the outgoing request\'s own '
      + 'Authorization header against the access token read from this tab\'s storage, to '
      + 'decide whether a logout call belongs to the current session. A timing side '
      + 'channel needs an attacker who can guess and measure; anything running here can '
      + 'read both values outright, so there is nothing to leak. `secretEquals` is '
      + 'server-only and importing it would not make this browser code safer.',
  },
];

describe('no secret is compared with ===', () => {
  it('each exemption still points at a real line', () => {
    // An exemption is a claim about code. When the code moves, the claim has to
    // be re-made rather than silently inherited.
    for (const { file, contains } of NOT_A_SECRET_COMPARISON) {
      const source = withoutComments(readFileSync(`${process.cwd()}/${file}`, 'utf8'));
      expect(source.includes(contains), `${file} no longer contains ${contains}; drop the exemption`).toBe(true);
    }
  });

  it('has no remaining byte-by-byte secret comparison', () => {
    const files = execSync("git ls-files 'app/*.ts' 'lib/*.ts'", { encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((f) => f !== 'lib/server/secret-equals.ts');
    expect(files.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of files) {
      // Comments are prose, not control flow. This is the FIFTH time in this
      // sweep that a scan has read an explanation as the thing it explains —
      // and this time it was my own: the doc comment added to cron-auth.ts
      // says "`secretEquals` rather than `===`", and that sentence failed this
      // test. It failed in the SAFE direction, which is the only reason it is
      // a footnote rather than a defect.
      withoutComments(readFileSync(`${process.cwd()}/${file}`, 'utf8')).split('\n').forEach((line, i) => {
        if (/\b(NODE_ENV|VERCEL_ENV)\b/.test(line)) return; // not secrets
        // A line that ALREADY compares in constant time is not the offender —
        // the `!==` beside it is doing something else. recovery-server.ts reads
        // `signature.toString('base64url') !== parts[1]`, which re-encodes the
        // decoded bytes to reject a non-canonical base64url spelling, and then
        // hands the same bytes to `timingSafeEqual`. Flagging that asked it to
        // replace the canonicalisation check with the comparison it already makes.
        if (/\b(timingSafeEqual|secretEquals)\s*\(/.test(line)) return;
        if (NOT_A_SECRET_COMPARISON.some((e) => e.file === file && line.includes(e.contains))) return;
        if (/(===|!==)[^;]*\b(SECRET|secret|Bearer)\b/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, 'Compare it with secretEquals() from lib/server/secret-equals.ts.').toEqual([]);
  });
});
