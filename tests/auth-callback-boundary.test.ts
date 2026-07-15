import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/auth/callback/route.ts', 'utf8');

describe('auth callback boundary', () => {
  it('does not route users into the app when the authenticated-user read fails', () => {
    expect(source).toContain('error: userError');
    expect(source).toContain('if (userError || !user)');
    expect(source).toContain("return NextResponse.redirect(new URL('/login?error=auth', url.origin));");
  });

  it('does not mistake a failed membership read for a new account', () => {
    expect(source).toContain('error: membershipError');
    expect(source).toContain("console.error('[auth-callback] membership lookup failed', membershipError);");
    expect(source).toContain("if (membership.length === 0) destination = '/onboarding';");
  });
});
