import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    expect(source).toContain("Kid sign-in is temporarily unavailable. Try again shortly.");
  });

  it('rolls back child provisioning when active-family preference persistence fails', () => {
    const source = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

    expect(source).toContain("const { error: prefErr } = await admin.from('user_preferences').upsert(");
    expect(source).toContain("await admin.from('child_logins').delete().eq('user_id', childUserId)");
    expect(source).toContain("await admin.from('family_members').update({ user_id: null }).eq('id', member.id)");
    expect(source).toContain('await admin.auth.admin.deleteUser(childUserId)');
  });
});
