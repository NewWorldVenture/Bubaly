import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('account and device-security action boundaries', () => {
  const sources = [
    'app/(app)/account/actions.ts',
    'app/(app)/actions.ts',
    'app/(app)/settings/app-lock-actions.ts',
    'lib/server/profiles.ts',
  ];

  it('sanitizes database failures before returning them to the client', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/return\s*\{[^\n]*error:\s*(?:error|memberError|prefsError)\??\.message/);
      if (path.includes('app-lock-actions')) {
        expect(source).toContain("t('appLockActions.couldNotSaveAppLockSettings')");
        expect(source).not.toMatch(/error:\s*(?:saved|current)\.error/);
      } else expect(source).toContain('describeActionError(');
    }
  });

  it('does not treat preference or profile writes as successful when Supabase reports an error', () => {
    const actions = readFileSync('app/(app)/actions.ts', 'utf8');
    const appLock = readFileSync('app/(app)/settings/app-lock-actions.ts', 'utf8');
    const profiles = readFileSync('lib/server/profiles.ts', 'utf8');

    expect(actions).toContain("if (error) return actionFailure('switch active family', t('App.couldNotSwitchActiveFamily'), error);");
    expect(actions).toContain("if (error) return actionFailure('set the default dashboard', t('App.couldNotSetTheDefaultDashboard'), error);");
    // Private-store failures stay generic and writes are acknowledged only
    // after the revision compare-and-set succeeds.
    expect(appLock).toContain("if (!current.ok) return { ok: false, error: t('appLockActions.couldNotLoadAppLockSettings') }");
    expect(appLock).toContain("if (!saved.ok) return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') }");
    expect(appLock).toContain('replaceAppLockRecord(ctx.user.id, record?.revision ?? null, config)');
    expect(profiles).toContain('if (memberError)');
  });
});
