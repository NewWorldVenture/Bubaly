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
    expect(src).toContain("if (error && !isSessionMissing(error)) console.error('[auth] user lookup failed', error);");
    expect(src).toContain("if (!isSessionMissing(authError)) console.error('[auth] super-admin user lookup failed', authError);");
  });
});
