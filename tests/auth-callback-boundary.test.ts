import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/auth/callback/route.ts', 'utf8');

describe('auth callback boundary', () => {
  it('still sends a visitor with no session to the login page', () => {
    expect(source).toContain('error: userError');
    expect(source).toContain('if (!user) {');
    expect(source).toContain("return NextResponse.redirect(new URL('/login?error=auth', url.origin));");
  });

  it('does not bounce a just-signed-in user to /login over a transient read', () => {
    // `exchangeCodeForSession` has already written the session cookies by this
    // point, so the visitor IS signed in. Sending them to /login because the
    // read-back failed shows the login page to someone who just signed in.
    expect(source).toContain('isRetryableAuthError(userError)');
    expect(source).toContain('return NextResponse.redirect(new URL(next, url.origin));');
    // And the fallback is the ordinary destination, never the admin console:
    // that routing decision needs a user this branch could not read.
    const retryableBranch = source.slice(
      source.indexOf('if (!user) {'),
      source.indexOf("return NextResponse.redirect(new URL('/login?error=auth', url.origin));"),
    );
    expect(retryableBranch).not.toContain("'/admin'");
  });

  it('does not mistake a failed membership read for a new account', () => {
    expect(source).toContain('error: membershipError');
    expect(source).toContain("console.error('[auth-callback] membership lookup failed', membershipError);");
    // The onboarding detour is reached only on a read that actually succeeded —
    // provisioning a second family off a failed read is the worse outcome.
    expect(source).toContain("else if (membership.length === 0) destination = '/onboarding';");
  });

  it('never answers a signed-in visitor with a login redirect after a failed DB read', () => {
    // Exactly one /login redirect inside the successful-exchange branch: the
    // "there is genuinely no user" case. Any second one is a regression that
    // logs out somebody who is holding a valid session.
    // Scope to the SUCCESSFUL-exchange branch only. The trailing redirect at the
    // end of the handler covers "no code, or the exchange itself failed", where
    // there is no session and /login is the right answer.
    const start = source.indexOf('if (!error) {');
    const end = source.indexOf('return res;', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const exchanged = source.slice(start, end);
    const loginRedirects = exchanged.match(/\/login\?error=auth/g) ?? [];
    expect(loginRedirects).toHaveLength(1);
  });
});
