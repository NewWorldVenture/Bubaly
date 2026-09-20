import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidUsername, normalizeUsername } from '@/lib/onboarding/child-login';
import { DEFAULT_POLICY } from '@/lib/auth/child-throttle';

/**
 * A child's username is looked up as a VALUE, never as a LIKE pattern.
 *
 * Traced on 2026-09-13. Sign-in resolved the account with
 * `.ilike('username', username)`, and `_` is a single-character wildcard in
 * LIKE. `USERNAME_RE` anchors both ends to `[a-z0-9]` — so `%` and an edge `_`
 * are refused — but it permits `_` in between. `a_ice` therefore matched
 * `alice`, and the code then signed in as `row.username`: the real account.
 *
 * On its own that is not a bypass — the attacker still needs the PIN. What it
 * broke is the thing that makes a 4-digit PIN survivable at all. The throttle
 * is keyed on the username as TYPED (`child_login_throttle.username`), while
 * the lookup treated that same string as a pattern. So every wildcard spelling
 * was a separate throttle key with its own budget, against one real account:
 *
 *   alice → a_ice, al_ce, ali_e, a__ce, a_i_e, al__e, a___e   (7 spellings)
 *
 * 8 keys × 5 failures = 40 attempts per 15 minutes instead of 5. An
 * eight-character username yields 63 spellings — 320 per window. The per-IP
 * limiter is then the only bound, and it is per-IP, not per-account.
 *
 * `lib/auth/child-throttle.ts` states the stakes in its own header: "kid
 * usernames are guessable (suggested from the display name), so unthrottled
 * sign-in is a real account-takeover risk."
 *
 * The fix is `eq`, not an escape: both sides are already lowercased by
 * `normalizeUsername`, so the case-insensitive match was buying nothing.
 */

const wildcardSpellings = (name: string): string[] => {
  const middle = name.slice(1, -1);
  const out: string[] = [];
  for (let mask = 1; mask < 1 << middle.length; mask++) {
    const chars = [...middle].map((c, i) => ((mask >> i) & 1 ? '_' : c));
    out.push(name[0] + chars.join('') + name[name.length - 1]);
  }
  return out;
};

describe('the username grammar admits LIKE wildcards', () => {
  it('refuses % and an edge underscore, but allows one in the middle', () => {
    // This is why the bug was narrow rather than absent — and why reading the
    // regex alone could talk you out of it.
    expect(isValidUsername('a%ice')).toBe(false);
    expect(isValidUsername('_lice')).toBe(false);
    expect(isValidUsername('alic_')).toBe(false);
    expect(isValidUsername('a_ice')).toBe(true);
    expect(isValidUsername('a___e')).toBe(true);
  });

  it('gives a five-character name seven spellings and an eight-character name sixty-three', () => {
    expect(wildcardSpellings('alice')).toHaveLength(7);
    expect(wildcardSpellings('alice').every(isValidUsername)).toBe(true);
    expect(wildcardSpellings('samantha')).toHaveLength(63);
  });

  it('multiplies the throttle budget by one key per spelling', () => {
    // The policy allows five failures per key per window. The spellings are
    // separate keys, so the real budget against one account is 8 × 5, not 5.
    expect(DEFAULT_POLICY.maxFails).toBe(5);
    const keys = wildcardSpellings('alice').length + 1;
    expect(keys * DEFAULT_POLICY.maxFails).toBe(40);
  });
});

describe('both child-login lookups match on value, not pattern', () => {
  const signIn = readFileSync('app/(auth)/actions.ts', 'utf8');
  const create = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

  it('resolves the account for sign-in with eq', () => {
    expect(signIn).toContain(".from('child_logins').select('username,user_id').eq('username', username)");
    expect(signIn).not.toContain(".ilike('username'");
  });

  it('checks the username is free with eq too', () => {
    // Over-strict rather than under-strict, but still wrong: with ilike this
    // answered about a different login than the one being created.
    expect(create).toContain(".from('child_logins').select('id').eq('username', username)");
    expect(create).not.toContain(".ilike('username'");
  });

  it('is safe as eq because both sides are normalized the same way', () => {
    // eq would be a REGRESSION if the stored value could differ in case. It
    // cannot: the create path normalizes before inserting, and sign-in
    // normalizes before looking up.
    expect(create).toContain('const username = normalizeUsername(input.username)');
    expect(signIn).toContain('const username = normalizeUsername(');
    expect(normalizeUsername('  AlIcE ')).toBe('alice');
  });
});
