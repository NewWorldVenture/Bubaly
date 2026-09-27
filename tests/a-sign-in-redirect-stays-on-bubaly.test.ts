import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { safeInternalRedirect } from '@/lib/auth/redirect';
import { resolveAuthSelection } from '@/lib/billing/review-selection';

/**
 * After signing in, a person lands on Bubaly — never on a page an attacker named.
 *
 * safeInternalRedirect checked the RAW input for `//`, backslashes and encoded
 * slashes, then parsed it and returned the parser's NORMALIZED path. Dot-segment
 * removal is part of that normalization, and it rebuilds exactly the thing the
 * raw check had just refused:
 *
 *     new URL('/.//evil.com', base).pathname   ===  '//evil.com'
 *
 * The origin check passed — the value was parsed as a path on our base, not as
 * a host — so `//evil.com` was returned as a safe internal path. It is not: a
 * browser resolves it against the page to https://evil.com.
 *
 * login-form and phone-auth take that value from a single pass and call
 * `router.push(destination)` after a SUCCESSFUL sign-in. So
 *
 *     https://www.bubaly.com/login?redirect=/.//evil.com
 *
 * let someone sign in on the real site and then delivered them to a lookalike
 * "session expired, sign in again" page. The auth-callback path happened to be
 * safe only because callback-completion re-validated the value a second time.
 *
 * The fix checks the normalized OUTPUT, which also covers encodings the raw
 * check never listed (`%2e` is a dot segment to the URL parser).
 */

const ORIGIN = 'https://www.bubaly.com';
/** Where a browser actually goes when it navigates to `value` from our page. */
const lands = (value: string) => new URL(value, `${ORIGIN}/login`).origin;

const ATTACKS = [
  '/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/%2E%2E//evil.com',
  '/././/evil.com', '/a/..//evil.com', '/.//evil.com/login?x=1',
  '//evil.com', '/\\evil.com', '/%2f%2fevil.com', 'https://evil.com', 'javascript:alert(1)',
];

describe('safeInternalRedirect keeps every destination on our origin', () => {
  for (const attack of ATTACKS) {
    it(`${JSON.stringify(attack)} cannot leave bubaly.com`, () => {
      const out = safeInternalRedirect(attack, '/home');
      expect(lands(out), `${attack} → ${out}`).toBe(ORIGIN);
    });
  }

  // The finding, stated as the concrete value that used to escape.
  it('no longer returns a protocol-relative path for a dot-segment input', () => {
    expect(safeInternalRedirect('/.//evil.com', '/home')).toBe('/home');
  });

  // Controls: legitimate internal destinations are untouched, including ones
  // whose normalization is benign.
  it('still passes ordinary internal paths, query and hash intact', () => {
    expect(safeInternalRedirect('/home', '/x')).toBe('/home');
    expect(safeInternalRedirect('/dashboard/settings?tab=billing#plan', '/x')).toBe('/dashboard/settings?tab=billing#plan');
    expect(safeInternalRedirect('/a/./b/../c', '/x')).toBe('/a/c');
  });
});

describe('the sign-in screens are protected by the same fix', () => {
  it('the login and signup selection returns no escaping destination', () => {
    for (const attack of ATTACKS) {
      const { next } = resolveAuthSelection(new URLSearchParams({ redirect: attack }));
      if (next !== null) expect(lands(next), `${attack} → ${next}`).toBe(ORIGIN);
    }
  });

  it('login-form and phone-auth push the single-pass value, so the source fix is what protects them', () => {
    // Recorded so a future change that adds a second validation at the call
    // site does not remove the reason the source must stay correct.
    expect(readFileSync('components/auth/login-form.tsx', 'utf8')).toMatch(/const redirectDest = selection\.next/);
    expect(readFileSync('components/auth/phone-auth.tsx', 'utf8')).toMatch(/const destination = safeInternalRedirect\(next/);
  });
});
