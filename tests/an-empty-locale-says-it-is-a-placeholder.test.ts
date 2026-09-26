// An empty locale says it is a placeholder.
//
// Bubaly offers eleven locales in the picker. FOUR of them — en-GB, es-MX, es-US
// and fr-CA — are three-byte files containing `{}`, against ~13,800 keys in each
// of the other seven.
//
// ── THE MEASUREMENT FIRST, BECAUSE IT DECIDES WHICH DEFECT THIS IS ───────────
//
// Nothing is broken at runtime, and that was checked rather than assumed.
// `getMessages()` builds `{ ...enUS }`, assigns the fallback chain over it
// nearest-last, then assigns the locale's own catalogue on top — so the map is
// COMPLETE before `translate` is ever called and its `messages[key] ?? key`
// branch is unreachable. Merged, en-GB comes out value-for-value identical to
// en-US and es-MX value-for-value identical to es-ES. No blank page, no raw key.
// `Intl` follows the locale CODE and not the catalogue, so a British reader does
// get `14 Jul 2026` and `£`; what they do not get is British words.
//
// So this is an honesty defect, not a broken feature — which is why the fix is
// not to stop offering the locales. It is that nothing in the code SAID any of
// this, and one thing said the opposite: lib/i18n/locales.ts asserted that "the
// regional choice carries real meaning: Latin America reads es-MX rather than
// Spain's es-ES", about a file containing nothing, while
// lib/i18n/messages/README.md three directories away said they were empty on
// purpose. The codebase told the story both ways and a reader had no way to know
// which was true.
//
// ── WHAT THIS FILE HOLDS ─────────────────────────────────────────────────────
//
// `PLACEHOLDER_LOCALES` in lib/i18n/messages.ts now names the four, and the
// first two cases check that declaration BOTH WAYS: a locale named there must
// really be empty, and a locale NOT named there must really carry every English
// key. Neither half is optional. Without the first, the list could name a
// catalogue that was quietly filled in and the docs would go stale again;
// without the second, a catalogue could be emptied — or shipped half-done — and
// still be advertised as a translation.
//
// The last case is the one the bug itself taught. Both messages.ts and README.md
// pointed at `tests/i18n-catalogue-parity.test.ts` as the thing enforcing the key
// contract. THAT FILE HAS NEVER EXISTED. A confident pointer at a test nobody
// wrote is indistinguishable from a test that passes, so every test file the
// i18n sources name is now required to be on disk.
//
// NOT DONE, DELIBERATELY: filling the four in. Machine-translating 13,800 keys
// into a catalogue nobody can check would be inventing coverage, which is worse
// than an honest placeholder and is refused elsewhere in this audit.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LOCALES, type LocaleCode } from '@/lib/i18n/locales';
import {
  getMessages,
  getRawMessages,
  PLACEHOLDER_LOCALES,
  SOURCE_MESSAGES,
  translate,
} from '@/lib/i18n/messages';

const ALL: LocaleCode[] = LOCALES.map((locale) => locale.code);
const COMPLETE = ALL.filter((code) => !PLACEHOLDER_LOCALES.includes(code));
const SOURCE_KEYS = Object.keys(SOURCE_MESSAGES);

describe('an empty locale says it is a placeholder', () => {
  // Non-vacuity for everything below: the catalogues are really loaded, and the
  // declaration really covers the locales this product offers.
  it('reads the real catalogues and the real picker', () => {
    expect(SOURCE_KEYS.length).toBeGreaterThan(10_000);
    expect(SOURCE_MESSAGES['nav.family']).toBe('Family');
    expect(ALL).toHaveLength(11);
    expect(PLACEHOLDER_LOCALES.length).toBeGreaterThan(0);
    for (const code of PLACEHOLDER_LOCALES) {
      expect(ALL, `${code} is declared a placeholder but is not a locale we ship`).toContain(code);
    }
  });

  it('declares every empty catalogue as a placeholder', () => {
    const empty = ALL.filter((code) => Object.keys(getRawMessages(code)).length === 0);
    expect(
      [...empty].sort(),
      'A catalogue is empty and PLACEHOLDER_LOCALES does not say so — or says so about '
        + 'one that has since been filled in. Update the declaration in lib/i18n/messages.ts, '
        + 'and the note in lib/i18n/messages/README.md that reads from it.',
    ).toEqual([...PLACEHOLDER_LOCALES].sort());
  });

  it('holds every locale it does NOT call a placeholder to the whole English key set', () => {
    for (const code of COMPLETE) {
      const own = getRawMessages(code);
      const missing = SOURCE_KEYS.filter((key) => !(key in own));
      expect(
        { locale: code, missing: missing.length, first: missing.slice(0, 5) },
        `${code} is advertised as a translation. Either translate the missing keys `
          + '(README.md, "Adding a key", step 2) or stop calling it complete.',
      ).toEqual({ locale: code, missing: 0, first: [] });
    }
  });

  // The two cases above are both "expect nothing missing", which is also what a
  // lookup that had gone blind returns. Plant a locale-shaped hole and require
  // the same comparison to see it.
  it('would notice a locale that went half-empty', () => {
    const pretendCatalogue = { ...SOURCE_MESSAGES } as Record<string, string>;
    delete pretendCatalogue[SOURCE_KEYS[0]];
    delete pretendCatalogue[SOURCE_KEYS[1]];
    const missing = SOURCE_KEYS.filter((key) => !(key in pretendCatalogue));
    expect(missing).toEqual([SOURCE_KEYS[0], SOURCE_KEYS[1]]);
    expect(Object.keys({}).length).toBe(0);
  });

  // Why the placeholders are allowed to keep their place in the picker: the
  // choice degrades to the base language's words, never to a raw key.
  it('serves a placeholder locale complete text through the chain, not keys', () => {
    for (const code of PLACEHOLDER_LOCALES) {
      const merged = getMessages(code);
      const unresolved = SOURCE_KEYS.filter((key) => typeof merged[key] !== 'string' || merged[key] === '');
      expect({ locale: code, unresolved: unresolved.length }).toEqual({ locale: code, unresolved: 0 });
      // `translate` has no catalogue behind it; a hole would surface as the key.
      expect(translate(merged, 'nav.family')).not.toBe('nav.family');
    }
  });

  // And the honest description of what that costs: the words are the base
  // language's, exactly. This is the sentence the picker cannot tell you.
  it('gives a placeholder reader the base language word for word', () => {
    const inherits: Record<string, LocaleCode> = {
      'en-GB': 'en-US',
      'es-MX': 'es-ES',
      'es-US': 'es-ES',
      'fr-CA': 'fr-FR',
    };
    for (const code of PLACEHOLDER_LOCALES) {
      const base = getMessages(inherits[code]);
      const merged = getMessages(code);
      const differing = SOURCE_KEYS.filter((key) => merged[key] !== base[key]);
      expect(
        { locale: code, differingFrom: inherits[code], count: differing.length },
        `${code} now differs from ${inherits[code]} — it is carrying real overrides, so it `
          + 'is no longer a placeholder. Remove it from PLACEHOLDER_LOCALES.',
      ).toEqual({ locale: code, differingFrom: inherits[code], count: 0 });
    }
  });

  // The comment that said the opposite. Pinned by its claim rather than by its
  // wording: the file may describe the region map however it likes, as long as
  // it does not promise vocabulary the catalogues do not have.
  it('no longer claims the regional choice carries vocabulary it does not', () => {
    const locales = readFileSync('lib/i18n/locales.ts', 'utf8');
    expect(locales).not.toContain('regional choice carries real meaning');
    expect(
      locales,
      'lib/i18n/locales.ts describes the region map; it must point at the declaration '
        + 'that says which of those catalogues are empty.',
    ).toContain('PLACEHOLDER_LOCALES');
  });

  // The defect that let all of this stand: a pointer at a test nobody wrote.
  it('names only test files that exist', () => {
    const sources = [
      'lib/i18n/messages.ts',
      'lib/i18n/messages/README.md',
      'lib/i18n/locales.ts',
      'lib/i18n/translate.ts',
    ];
    const named: { source: string; test: string }[] = [];
    for (const source of sources) {
      for (const match of readFileSync(source, 'utf8').matchAll(/tests\/[A-Za-z0-9._-]+\.test\.ts/g)) {
        named.push({ source, test: match[0] });
      }
    }
    // Non-vacuity: these files DO name tests, and the scan must be finding them.
    expect(named.length, 'no test references found — the scan went blind').toBeGreaterThanOrEqual(3);
    const dangling = named.filter(({ test }) => !existsSync(test));
    expect(
      dangling,
      'An i18n source points at a test file that does not exist. That is how '
        + '`tests/i18n-catalogue-parity.test.ts` was cited for years as enforcing a key '
        + 'contract nothing checked.',
    ).toEqual([]);
  });
});
