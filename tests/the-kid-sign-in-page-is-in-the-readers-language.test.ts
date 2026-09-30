// ROLE-L05: the kid sign-in page's link back to the grown-up form read
// "Grown-up?" in every language. The i18n scanner reports two-or-more-word
// prose and so never saw a one-word, hyphenated literal; this pins it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the kid sign-in page is in the reader\'s language', () => {
  it('asks "Grown-up?" through the catalogue', () => {
    const source = readFileSync('components/auth/kid-login-form.tsx', 'utf8');
    expect(source).not.toMatch(/>\s*Grown-up\?/);
    expect(source).toContain("t('kidLogin.grownUp')");
  });

  it('every full catalogue says it', () => {
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;
      expect(messages['kidLogin.grownUp'], code).toBeTruthy();
    }
  });
});
