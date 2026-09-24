import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

describe('child login persistence boundaries', () => {
  it('counts the attempt before the account is looked up or the PIN is checked', () => {
    // SEC-019: a failure written AFTER the check let a concurrent burst read one
    // count and all pass. Behaviour: tests/a-burst-of-guesses-meets-the-lock.
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');
    const body = source.slice(source.indexOf('export async function childSignInAction'));
    const reserved = body.indexOf('await reserveChildLoginAttempt(admin, username');
    expect(reserved).toBeGreaterThan(-1);
    expect(reserved).toBeLessThan(body.indexOf(".from('child_logins')"));
    expect(reserved).toBeLessThan(body.indexOf('signInWithPassword('));
    expect(body).toContain("console.error('[child-login] failed-attempt counter write failed'");
  });

  it('writes the throttle after the check only to clear it on success', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');
    const body = source.slice(source.indexOf('export async function childSignInAction'));
    const writes = [...body.matchAll(/\.from\('child_login_throttle'\)\s*\.(\w+)\(/g)].map(m => m[1]);
    expect(writes).toEqual(['upsert']);
    expect(body).toMatch(/\.from\('child_login_throttle'\)\.upsert\(\s*\{ username, \.\.\.clearedState\(now\) \}/);
    expectTranslates(source, 'actions.kidSignInIsTemporarily', "Kid sign-in is temporarily unavailable. Try again shortly.");
  });

  it('rolls back child provisioning when active-family preference persistence fails', () => {
    const source = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

    expect(source).toContain("const { error: prefErr } = await admin.from('user_preferences').upsert(");
    expect(source).toContain("await admin.from('child_logins').delete().eq('user_id', childUserId)");
    expect(source).toContain("await admin.from('family_members').update({ user_id: null }).eq('id', member.id)");
    expect(source).toContain('await admin.auth.admin.deleteUser(childUserId)');
  });
});
