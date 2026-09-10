import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A signed-out visitor makes supabase.auth.getUser() return
// AuthSessionMissingError; public pages call getUser() on every render, so
// logging that as "[auth] user lookup failed" filled the server log with a
// stack trace per anonymous request (seen on /contact in the E2E run).
const src = readFileSync('lib/supabase/auth.ts', 'utf8');

describe('anonymous visitors are not logged as auth failures', () => {
  it('recognises the session-missing error by name, code and message', () => {
    expect(src).toContain("e.name === 'AuthSessionMissingError'");
    expect(src).toContain("e.code === 'session_missing'");
    expect(src).toMatch(/auth session missing/i);
  });
  it('getUser and isSuperAdmin only log genuine lookup failures', () => {
    expect(src).toContain("if (error && !isSessionMissing(error)) {");
    expect(src).toContain("console.error('[auth] user lookup failed', error);");
    expect(src).toContain("if (!isSessionMissing(authError)) console.error('[auth] super-admin user lookup failed', authError);");
  });

  // Not logging a signed-out visitor is one half. The other is not REPORTING a
  // failed lookup as a signed-out visitor: null is what every caller redirects
  // or 401s on, so a network blip returning null is a logout.
  it('raises on a transient lookup failure rather than reporting no user', () => {
    expect(src).toContain('if (isRetryableAuthError(error)) throwContextUnavailable');
  });
});
