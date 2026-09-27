// P-19, B7 kid-login pass (2026-09-27 page audit). /dashboard/family-access opens its
// "create a login" form only after "Create login" is pressed, so no page sweep
// ever rendered it: the submit was a bare check-mark icon with no name, the
// username and PIN fields had only English placeholders for labels, the reset
// form's field had none and its button said a literal "Save", and the success
// toast was an English template. Each now carries a catalogue string.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('components/family/child-access-manager.tsx', 'utf8');
const catalogues = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']
  .map((l) => [l, JSON.parse(readFileSync(`lib/i18n/messages/${l}.json`, 'utf8')) as Record<string, string>] as const);

describe('the kid-login form', () => {
  it('names the icon-only create button', () => {
    expect(src).toMatch(/<Button onClick=\{create\}[^>]*aria-label=\{t\('childAccessManager\.createLogin'\)\}/);
  });

  it('labels the username and PIN fields, and the reset field', () => {
    expect(src).toMatch(/aria-label=\{t\('childAccessManager\.usernameLabel'\)\}/);
    expect(src).toMatch(/aria-label=\{t\('childAccessManager\.pinLabel'\)\}/);
    expect(src).toMatch(/placeholder=\{t\('childAccessManager\.newPin'\)\}\s*aria-label=\{t\('childAccessManager\.newPin'\)\}/);
  });

  it('carries no English literal for the save button or the success toast', () => {
    expect(src).not.toMatch(/: 'Save'\}/);
    expect(src).not.toMatch(/success\(`Login created for/);
  });

  it('has every new string in every full translation', () => {
    for (const [locale, messages] of catalogues) {
      for (const key of ['usernameLabel', 'pinLabel', 'savePin', 'loginCreatedFor']) {
        expect(messages[`childAccessManager.${key}`], `${locale} ${key}`).toBeTruthy();
      }
      expect(messages['childAccessManager.loginCreatedFor']).toContain('{name}');
    }
  });
});
