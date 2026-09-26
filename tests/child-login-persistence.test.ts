import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';
import { bodyOf } from './helpers/source-order';

describe('child login persistence boundaries', () => {
  it('fails closed when a failed-attempt counter cannot be saved', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');

    expect(source).toContain("const { error } = await admin.from('child_login_throttle').upsert(");
    expect(source).toContain("if (error) console.error('[child-login] failed-attempt counter write failed'");
    expect(source).toContain('if (!(await recordFailure())) return { ok: false, error:');
  });

  it('records failed attempts for both unknown-user and bad-password paths', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');

    expect(source.match(/await recordFailure\(\)/g)?.length).toBe(2);
    expectTranslates(source, 'actions.kidSignInIsTemporarily', "Kid sign-in is temporarily unavailable. Try again shortly.");
  });

  it('rolls back child provisioning when active-family preference persistence fails', () => {
    const source = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

    expect(source).toContain("const { error: prefErr } = await admin.from('user_preferences').upsert(");

    // This used to assert the three rollback statements as INLINE LITERALS. They
    // now live in `rollbackChildLogin`, which does the same three things and
    // additionally checks that each one worked (C1-S9-35) — so the guard went red
    // on a strict improvement, exactly as `dashboard-modules-keep-prior-read` and
    // `server-page-read-boundary` did under C1-S9-28. Re-pointed at the behaviour
    // it was always about: on this path, all three steps are undone.
    expect(source).toContain('removeLoginRow: true');
    const rollback = bodyOf(source, 'async function rollbackChildLogin', '\n  return complete;\n}');
    expect(rollback).toContain("from('child_logins')");
    expect(rollback).toContain("from('family_members')");
    expect(rollback).toContain("update({ user_id: null })");
    expect(rollback).toContain('admin.auth.admin.deleteUser(');
    // And the stronger property the rewrite added, so this cannot regress back to
    // three unchecked awaits without going red again.
    expect(rollback).toContain('wroteNoRows(');
  });
});
