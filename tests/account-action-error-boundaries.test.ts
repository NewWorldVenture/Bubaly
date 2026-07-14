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
      expect(source).toContain('describeActionError');
    }
  });

  it('does not treat preference or profile writes as successful when Supabase reports an error', () => {
    const actions = readFileSync('app/(app)/actions.ts', 'utf8');
    const appLock = readFileSync('app/(app)/settings/app-lock-actions.ts', 'utf8');
    const profiles = readFileSync('lib/server/profiles.ts', 'utf8');

    expect(actions).toContain('if (error) return actionFailure(\'switch active family\', error);');
    expect(actions).toContain('if (error) return actionFailure(\'set the default dashboard\', error);');
    expect(appLock).toContain('if (prefsError) return actionFailure(\'load App Lock settings\', prefsError);');
    expect(appLock).toContain('if (error) return actionFailure(\'save App Lock settings\', error);');
    expect(profiles).toContain('if (memberError)');
  });
});
