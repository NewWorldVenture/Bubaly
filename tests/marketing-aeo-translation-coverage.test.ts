import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/lib/i18n/locales';
import { localeFallbackChain } from '@/lib/i18n/messages';

// verify-marketing-coverage-remote is a plain script with no TypeScript loader,
// so the locales it requires Knowledge Center rows for are a literal. This is
// what stops that literal from drifting away from the product: add a locale to
// the picker without deciding how its answers resolve and this fails, rather
// than that reader quietly getting a page with no Knowledge Center on it.
const SCRIPT = readFileSync(
  join(__dirname, '..', 'scripts/verify-marketing-coverage-remote.mjs'),
  'utf8',
);

const declared = (() => {
  const literal = /const TRANSLATED_LOCALES = \[([^\]]*)\]/.exec(SCRIPT)?.[1];
  expect(literal, 'TRANSLATED_LOCALES literal not found in the verifier').toBeTruthy();
  return [...literal!.matchAll(/'([a-z]{2}-[A-Z]{2})'/g)].map((m) => m[1]);
})();

describe('every locale the site ships can reach a Knowledge Center answer', () => {
  it('requires a translation for each non-English root locale', () => {
    expect(declared).toEqual(['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']);
  });

  // The real assertion: not that the list matches today's spelling, but that
  // nothing we ship falls outside it.
  it('leaves no shipped locale without a language to fall back to', () => {
    const covered = new Set(declared);
    const stranded = LOCALES.filter((locale) => {
      if (locale.language === 'en') return false; // English is the stored source
      return !localeFallbackChain(locale.code).some((step) => covered.has(step));
    });
    expect(stranded.map((l) => l.code)).toEqual([]);
  });

  // The three overlay locales are the reason localizeAeoQuestions walks a chain
  // at all, so name them: if one ever stops resolving through its parent, this
  // says which, instead of the previous test reporting a bare list.
  it('resolves the overlay locales through their parent language', () => {
    expect(localeFallbackChain('fr-CA')).toEqual(['fr-CA', 'fr-FR']);
    expect(localeFallbackChain('es-MX')).toEqual(['es-MX', 'es-ES']);
    expect(localeFallbackChain('es-US')).toEqual(['es-US', 'es-MX', 'es-ES']);
  });

  it('reports a translation gap per locale rather than per row', () => {
    // 60 questions x 6 locales is 360 lines of the same finding; the verifier
    // has a 100-line cap, so per-row reporting would bury every other failure.
    expect(SCRIPT).toMatch(/has no Knowledge Center translation for \$\{missing\.length\} of \$\{aeoRows\.length\}/);
    expect(SCRIPT).toMatch(/marketing_aeo_question_translations\?select=question_id,locale/);
  });
});
