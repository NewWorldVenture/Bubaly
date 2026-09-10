import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('lib/supabase/auth.ts', 'utf8');

describe('authenticated context error boundary', () => {
  it('does not treat failed context reads as a missing family', () => {
    expect(source).toContain('function throwContextUnavailable(scope: string, error: unknown): never');
    expect(source).toContain("throw new Error('Account context is temporarily unavailable.')");

    // The two reads that ESTABLISH tenant context must still fail closed. If
    // either is allowed to look like "no rows", the caller auto-provisions a
    // second family and buries the real failure.
    expect(source).toContain('const { data: members, error: membersError }');
    expect(source).toContain("if (membersError) throwContextUnavailable('family membership', membersError);");
    expect(source).toContain('const { data: families, error: familiesError }');
    expect(source).toContain("if (familiesError) throwContextUnavailable('family', familiesError);");
  });

  it('only reports needsFamily after a read that actually succeeded', () => {
    // The invariant the suite exists for: every `needsFamily` return is guarded
    // by an emptiness check on data that came back cleanly, never by an error
    // branch. Both error branches above throw before reaching one.
    const needsFamilyReturns = source.match(/return \{ needsFamily: true \}/g) ?? [];
    expect(needsFamilyReturns.length).toBeGreaterThan(0);
    for (const line of source.split('\n')) {
      if (!line.includes('return { needsFamily: true }')) continue;
      expect(line).toMatch(/\.length === 0/);
      expect(line).not.toMatch(/[Ee]rror/);
    }
  });

  it('sends an expired session to the login redirect, not to an error page', () => {
    // `auth.getUser()` reports a signed-out visitor as AuthSessionMissingError.
    // Throwing on it turned an expired cookie into a full-page error card on
    // every authenticated route; returning null routes it to /login instead.
    expect(source).toContain(
      "if (authError && !isSessionMissing(authError)) throwContextUnavailable('authenticated user', authError);",
    );
    expect(source).toContain('if (!auth.user) return null;');
    expect(source).toContain("if (!ctx) redirect('/login');");
  });

  it('keeps a failed preference read non-fatal', () => {
    // `user_preferences` only picks WHICH of the already-resolved memberships is
    // active. It is not tenant context, so a failure there falls back to the
    // first membership instead of taking every authenticated page down.
    expect(source).toContain(
      "if (prefsError) console.error('[auth] user preference query failed; using the first membership', prefsError);",
    );
    expect(source).toContain("memberships.find((m) => m.familyId === prefs?.active_family_id) ?? memberships[0]");
    expect(source).not.toContain("throwContextUnavailable('user preference'");
  });

  it('keeps shared auth failures observable while failing closed for privileged checks', () => {
    // A signed-out visitor (AuthSessionMissingError) is not a failure and must
    // not be logged; every other error stays observable — a transient one by
    // raising (throwContextUnavailable logs it), a definitive one by logging
    // and reporting no user, which is what it actually means.
    expect(source).toContain("if (error && !isSessionMissing(error)) {");
    expect(source).toContain("if (isRetryableAuthError(error)) throwContextUnavailable('authenticated user', error);");
    expect(source).toContain("console.error('[auth] user lookup failed', error);");
    expect(source).toContain("console.error('[auth] super-admin allowlist lookup failed', error);");
  });
});
