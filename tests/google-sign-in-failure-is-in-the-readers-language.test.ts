// ROLE-L03 (with the invite page): "Continue with Google" toasted the
// provider's own English wording on failure, or one of two English literals
// ("Google sign-in isn't enabled yet. Try email instead.", "Could not continue
// with Google"), whatever language the reader chose. The one case a person can
// act on is now a catalogue sentence; anything else is handled the way the
// email login form handles an auth error.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('components/auth/oauth-buttons.tsx', 'utf8');

describe('a failed Google sign-in speaks the reader\'s language', () => {
  it('shows no English literal and no provider message', () => {
    expect(source).not.toMatch(/isn't enabled yet|Could not continue with Google/);
    expect(source).not.toMatch(/:\s*msg\)/);
    expect(source).toContain("t('oauthButtons.googleSignInIsNotAvailable')");
    expect(source).toContain("describeDbError(err, t('loginForm.couldNotSignIn'))");
  });

  it('every full catalogue says it', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      expect(messages['oauthButtons.googleSignInIsNotAvailable'], code).toBeTruthy();
    }
  });
});
