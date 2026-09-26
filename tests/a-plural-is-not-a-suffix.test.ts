import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pluralCategory, pluralize, type Messages } from '@/lib/i18n/translate';
import { pluralize as serverPluralize } from '@/lib/i18n/messages';
import { LOCALES } from '@/lib/i18n/locales';

/**
 * `${n} mission${n === 1 ? '' : 's'}` is English grammar compiled into the
 * source, and this file is the measurement that says so rather than the claim.
 *
 * Each case below is a real disagreement between that ternary and CLDR, taken
 * from `Intl.PluralRules` at run time rather than from memory — so if a runtime
 * ever disagrees with what is written here, the test says which.
 */
describe('a plural is not a suffix', () => {
  it('English and French disagree about ZERO', () => {
    // The suffix ternary is `n === 1 ? '' : 's'`, so it puts 0 in the plural for
    // every language. French puts it in the singular: `0 mission`, not
    // `0 missions`. A two-form language is not the same two forms.
    expect(pluralCategory('en-US', 0)).toBe('other');
    expect(pluralCategory('fr-FR', 0)).toBe('one');
    expect(pluralCategory('en-US', 1)).toBe('one');
    expect(pluralCategory('fr-FR', 1)).toBe('one');
  });

  it('some languages have more forms than a ternary has branches', () => {
    // Polish: 1 plik / 2 pliki / 5 plików. Three categories, and a two-branch
    // ternary cannot reach the third whatever the translation says.
    const polish = new Set([1, 2, 5, 22, 25].map((n) => pluralCategory('pl-PL', n)));
    expect(polish.size).toBeGreaterThanOrEqual(3);
    expect(pluralCategory('pl-PL', 1)).toBe('one');
    expect(pluralCategory('pl-PL', 2)).toBe('few');
    expect(pluralCategory('pl-PL', 5)).toBe('many');
    // Arabic uses all six, which is the reason `PluralCategory` has six members.
    const arabic = new Set([0, 1, 2, 3, 11, 100].map((n) => pluralCategory('ar', n)));
    expect(arabic.size).toBeGreaterThanOrEqual(5);
  });

  it('every populated locale in this product is covered by the rules', () => {
    // Non-vacuity: a locale the runtime does not know would silently take
    // `other` for everything, which is a real answer for English and a wrong one
    // for German. This asserts the runtime actually has data for each.
    for (const locale of LOCALES) {
      const categories = new Set([0, 1, 2, 5, 11, 100].map((n) => pluralCategory(locale.code, n)));
      expect(categories.size, `${locale.code} resolved to a single category`).toBeGreaterThan(1);
      expect(pluralCategory(locale.code, 1), `${locale.code} does not treat 1 as singular`).toBe('one');
    }
  });

  const CATALOGUE: Messages = {
    'missions.done.one': '{count} mission done',
    'missions.done.other': '{count} missions done',
    'files.count.one': '{count} plik',
    'files.count.few': '{count} pliki',
    'files.count.many': '{count} plików',
  };

  it('picks the form the language asks for', () => {
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', 1)).toBe('1 mission done');
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', 0)).toBe('0 missions done');
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', 7)).toBe('7 missions done');
    expect(pluralize(CATALOGUE, 'pl-PL', 'files.count', 1)).toBe('1 plik');
    expect(pluralize(CATALOGUE, 'pl-PL', 'files.count', 2)).toBe('2 pliki');
    expect(pluralize(CATALOGUE, 'pl-PL', 'files.count', 5)).toBe('5 plików');
  });

  it('falls back to `other` rather than to the wrong language', () => {
    // A language whose category this key has not been translated into yet takes
    // its OWN `other`, never English's form for that category. Asking Polish for
    // `missions.done` (which has only one/other) must give Polish `other`.
    expect(pluralize(CATALOGUE, 'pl-PL', 'missions.done', 5)).toBe('5 missions done');
    // And a key with no `other` at all is absent, not plural-less.
    expect(pluralize({ 'x.one': 'one x' }, 'en-US', 'x', 3)).toBe('x');
  });

  it('formats the count for the locale, and lets a caller override it', () => {
    // A phrase that translates its words and leaves its digits in American
    // order is only half translated.
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', 1234)).toBe('1,234 missions done');
    expect(pluralize(CATALOGUE, 'de-DE', 'missions.done', 1234)).toBe('1.234 missions done');
    expect(pluralize(CATALOGUE, 'fr-FR', 'missions.done', 1234).replace(/ | /g, ' '))
      .toBe('1 234 missions done');
    // An explicit value passes through verbatim: a caller formatting it
    // themselves has a reason, and the CATEGORY still comes from the real count.
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', 1, { count: 'one' })).toBe('one mission done');
  });

  it('a non-finite count, or a malformed locale, renders text rather than throwing', () => {
    expect(pluralCategory('en-US', Number.NaN)).toBe('other');
    expect(pluralCategory('en-US', Number.POSITIVE_INFINITY)).toBe('other');
    expect(pluralize(CATALOGUE, 'en-US', 'missions.done', Number.NaN)).toBe('NaN missions done');
    // A MALFORMED tag throws RangeError and is caught.
    for (const malformed of ['', 'en_US', '!!']) {
      expect(pluralCategory(malformed, 1), `${JSON.stringify(malformed)} did not fall back`).toBe('other');
    }
    expect(pluralize(CATALOGUE, 'en_US', 'missions.done', 1)).toBe('1 missions done');
  });

  it('a WELL-FORMED unknown tag silently gets English rules, which is why LOCALES is the guard', () => {
    // The first draft of pluralCategory's own comment claimed an unsupported
    // locale falls back to `other`. It does not: `Intl` resolves a well-formed
    // tag it has no data for to the runtime default and reports `en-US` from
    // `resolvedOptions().locale`. Nothing throws, so nothing is caught, and an
    // unknown language would quietly take ENGLISH plural boundaries.
    for (const unknown of ['zz', 'xx-YY', 'not-a-locale-at-all']) {
      expect(new Intl.PluralRules(unknown).resolvedOptions().locale).toBe('en-US');
      expect(pluralCategory(unknown, 1)).toBe('one');
      expect(pluralCategory(unknown, 0)).toBe('other');
    }
    // Which is exactly why the locale must come from LOCALES, asserted above,
    // rather than from anything a request can name.
  });

  it('the SERVER pluraliser falls back to English, and the client does not', () => {
    // The same split the whole of lib/i18n/translate.ts exists for: the server
    // may hold the English catalogue, the browser may not, because holding it
    // there costs 244 KB gzip on every page in the product.
    // A REAL key, so this asserts the catalogue wiring rather than a fixture:
    // `security.openAlerts` exists in en-US, and an empty catalogue stands in for
    // a locale whose translation has not reached it.
    const untranslated: Messages = {};
    expect(serverPluralize(untranslated, 'de-DE', 'security.openAlerts', 2)).toBe('2 open alerts');
    expect(serverPluralize(untranslated, 'de-DE', 'security.openAlerts', 1)).toBe('1 open alert');
    expect(pluralize(untranslated, 'de-DE', 'security.openAlerts', 2)).toBe('security.openAlerts');
  });
});

/**
 * The ratchet.
 *
 * The primitive above exists now, so a suffix ternary is a choice rather than a
 * gap in the toolkit — and the number can only come down. `toBeLessThanOrEqual`
 * with a bound that is re-tightened on each conversion, in the idiom of
 * tests/a-group-of-controls-needs-a-name.test.ts: a ratchet that is not
 * re-tightened is a ceiling.
 *
 * Deliberately NOT zero yet, and the honest reason is that the remainder is not
 * all the same work. The clean cases are one phrase with one count. The rest
 * compose a SENTENCE out of two or three counted fragments —
 *
 *   `“Plan this week” turns your ${n} zone${…} into ${m} short mission${…}, …`
 *
 * — and a sentence assembled from translated fragments is its own translation
 * defect: word order is not a property a language lets a caller choose. Those
 * need one key for the whole sentence with `{zones}` and `{missions}` holes fed
 * by `plural()`, which is a rewrite of the copy rather than a mechanical
 * substitution, and is filed as such rather than guessed at.
 */
describe('the suffix ternary only ever shrinks', () => {
  const SUFFIX_TERNARY = /===\s*1\s*\?\s*''\s*:\s*'s'|!==\s*1\s*\?\s*'s'\s*:\s*''/g;

  const sources = () =>
    execFileSync('git', ['ls-files',
      'app/*.ts', 'app/*.tsx', 'components/*.ts', 'components/*.tsx', 'lib/*.ts', 'lib/*.tsx',
    ], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

  it('finds the call sites at all (guards the guard)', () => {
    // A matcher that silently found nothing would make the bound meaningless.
    const files = sources();
    expect(files.length).toBeGreaterThan(300);
    expect(SUFFIX_TERNARY.test("`${n} item${n === 1 ? '' : 's'}`")).toBe(true);
    SUFFIX_TERNARY.lastIndex = 0;
    // The inverted spelling counts too — `n !== 1 ? 's' : ''` is the same defect.
    expect(SUFFIX_TERNARY.test("`${n} item${n !== 1 ? 's' : ''}`")).toBe(true);
    SUFFIX_TERNARY.lastIndex = 0;
  });

  it('counts no more than the recorded remainder', () => {
    let total = 0;
    const byFile: string[] = [];
    for (const file of sources()) {
      const found = readFileSync(`${process.cwd()}/${file}`, 'utf8').match(SUFFIX_TERNARY);
      if (found) { total += found.length; byFile.push(`${file} × ${found.length}`); }
    }
    // 235 across app/, components/ and lib/ before any conversion; 227 after the
    // first batch, which took inventory and security to zero and left declutter
    // with only its composite sentence. The bound is the measurement, not a
    // target — it comes down with each conversion and never goes up.
    expect(
      total,
      'a counted phrase gained an English suffix ternary. `usePlural()` and '
      + "`getPlurals()` resolve the locale's own CLDR forms — see "
      + 'lib/i18n/translate.ts for the three distinct ways a suffix is wrong:\n'
      + byFile.map((f) => `  ${f}`).join('\n'),
    ).toBeLessThanOrEqual(227);
  });

  it('the modules converted in the first batch stay converted', () => {
    // Named, so the ones just fixed cannot be undone while the aggregate bound
    // absorbs it from somewhere else.
    for (const file of [
      'components/modules/inventory-module.tsx',
      'components/modules/security-module.tsx',
    ]) {
      const source = readFileSync(`${process.cwd()}/${file}`, 'utf8');
      expect(source.match(SUFFIX_TERNARY), `${file} regressed to a suffix ternary`).toBeNull();
      expect(source, `${file} no longer pluralises through the catalogue`).toContain('usePlural');
    }
  });
});
