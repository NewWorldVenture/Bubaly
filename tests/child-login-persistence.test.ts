import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

describe('child login persistence boundaries', () => {
  it('fails closed when a failed-attempt counter cannot be saved', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');

    // The counter write moved to lib/auth/child-throttle-store.ts so it could
    // carry the observed state as a predicate (a blind upsert let N parallel
    // guesses cost one failure). The property asserted here is unchanged: a
    // write that does not land must refuse the sign-in.
    const store = readFileSync('lib/auth/child-throttle-store.ts', 'utf8');

    expect(store).toContain("console.error('[child-login] failed-attempt counter write failed', error)");
    expect(store).toContain('return false;');
    expect(source).toContain('if (!(await recordFailure())) return { ok: false, error:');
  });

  it('counts a failed attempt against the state it was computed from', () => {
    // Without these predicates the counter measures rounds of parallel guessing
    // rather than guesses, which is no bound at all on a 4-digit PIN.
    const store = readFileSync('lib/auth/child-throttle-store.ts', 'utf8');

    expect(store).toContain(".eq('fails', current.fails)");
    expect(store).toContain(".eq('window_start', current.window_start)");
    expect(readFileSync('app/(auth)/actions.ts', 'utf8'))
      .not.toContain("admin.from('child_login_throttle').upsert(\n      { username, ...next }");
  });

  it('records failed attempts for both unknown-user and bad-password paths', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');

    expect(source.match(/await recordFailure\(\)/g)?.length).toBe(2);
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
