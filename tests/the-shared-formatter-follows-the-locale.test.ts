// Every date, time and money value in the shared formatter rendered in US English,
// on a product shipping eleven locales.
//
//   format(d, 'EEE, MMM d')            "Tue, Jul 14"  to a German family
//   format(d, 'h:mm a')                12-hour AM/PM  to locales using a 24-hour clock
//   fmtRelative                        "Today, " in hardcoded English
//   new Intl.NumberFormat('en-US')     pinned at module scope, for all money
//
// lib/i18n/locales.ts says in its own header that the unit is a full locale because
// "a family in Mexico and a family in Spain both read Spanish but expect different
// dates, currency and vocabulary". Nothing consumed it for either.
//
// The subtle part is WHY this uses Intl rather than date-fns with a locale: a pattern
// like 'EEE, MMM d' hardcodes the ORDER as well as the names, so date-fns with a
// German locale yields German names in American order. The cases below assert the
// order, not just the words, because that is the half a locale-aware date-fns call
// would still get wrong.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFormat, KNOWN_DATE_PATTERNS,
  fmtDate, fmtTime, fmtMoney,
} from '@/lib/utils/format';
import { LOCALES } from '@/lib/i18n/locales';
import DE from '@/lib/i18n/messages/de-DE.json';

const AT = '2026-07-14T14:30:00Z';
const through = (messages: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce(
      (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key,
    );

describe('the shared formatter follows the locale', () => {
  // The en-US binding must not move: crons, exports and model prompts depend on it,
  // and 144 files still import it directly.
  describe('the en-US binding is unchanged', () => {
    it('formats a date and a time exactly as before', () => {
      expect(fmtDate('2026-07-14T14:30:00Z')).toContain('Jul');
      expect(fmtTime(new Date('2026-07-14T09:05:00'))).toBe('9:05 AM');
    });

    it('formats money exactly as before', () => {
      expect(fmtMoney(1250)).toBe('$12.50');
    });
  });

  describe('a date carries the locale’s names AND its order', () => {
    it('German puts the day before the month', () => {
      const de = createFormat('de-DE').fmtDate(AT);
      expect(de).toContain('Juli');
      // The order is the point. date-fns with a German locale would give "Juli 14".
      expect(de.indexOf('14')).toBeLessThan(de.indexOf('Juli'));
    });

    it('French is French, and is not English', () => {
      const fr = createFormat('fr-FR').fmtDate(AT);
      expect(fr).toMatch(/juil/);
      expect(fr).not.toContain('Jul ');
    });

    it('Spanish differs from English', () => {
      expect(createFormat('es-ES').fmtDate(AT)).not.toBe(createFormat('en-US').fmtDate(AT));
    });
  });

  describe('a time uses the locale’s clock', () => {
    it('German has no AM/PM', () => {
      const de = createFormat('de-DE').fmtTime(AT);
      expect(de).not.toMatch(/AM|PM/);
    });

    it('American does', () => {
      expect(createFormat('en-US').fmtTime(AT)).toMatch(/AM|PM/);
    });
  });

  describe('money keeps its currency and localises its separators', () => {
    // The currency belongs to the MONEY, not the reader's language: a US family's
    // wallet is in dollars whichever language they read. Showing a USD balance as
    // euros because the UI is French would misstate an amount, which is worse than
    // the defect being fixed.
    it('a German reader still sees dollars, written the German way', () => {
      const de = createFormat('de-DE').fmtMoney(1250);
      expect(de).toContain('12,50');
      expect(de).toContain('$');
      expect(de).not.toContain('12.50');
    });

    it('an explicit currency is honoured, not replaced', () => {
      expect(createFormat('de-DE').fmtMoney(1250, 'EUR')).toContain('€');
      expect(createFormat('en-US').fmtMoney(1250, 'EUR')).toContain('€');
    });

    it('groups thousands the locale’s way', () => {
      expect(createFormat('en-US').fmtNumber(1234567)).toBe('1,234,567');
      expect(createFormat('de-DE').fmtNumber(1234567)).toBe('1.234.567');
    });

    // The first version of this module normalised U+202F AND U+00A0 to an ordinary
    // space, across every helper. That is right for the AM/PM gap, whose character
    // changed with ICU 72, and WRONG here: these separators are non-breaking on
    // purpose, and French and Portuguese use them for thousands. Flattening them
    // gives an amount that can break across a line and grouping that is wrong for
    // the locale. Both the ratchet and the typechecker were green over it; only a
    // behavioural assertion on the rendered string found it.
    it('keeps the non-breaking separators the locale asks for', () => {
      expect(createFormat('de-DE').fmtMoney(1250)).toBe('12,50\u00a0$');
      expect(createFormat('fr-FR').fmtNumber(1234567)).toBe('1\u202f234\u202f567');
      expect(createFormat('pt-PT').fmtNumber(1234567)).toBe('1\u00a0234\u00a0567');
      // And the clock gap IS normalised, which is the one case that needed it.
      expect(createFormat('en-US').fmtTime('2026-07-14T09:05:00Z')).not.toContain('\u202f');
    });
  });

  // `fmtRelative` answers "Today" or "Tomorrow" by asking which LOCAL calendar day
  // a moment falls on, so a case that reads the wall clock and adds an hour asserts
  // a different thing between 23:00 and midnight than it does at any other hour.
  // It failed in CI at 23:04 — "Morgen, 0:05" where it wanted "Heute" — having
  // passed on every earlier head, which is what a one-hour window in a 24-hour day
  // looks like: right 23 runs out of 24. Reproduced here at 23:11 UTC, character
  // for character, before it was pinned.
  //
  // Pinned to LOCAL noon and not to a fixed UTC instant. vitest.config.ts sets
  // `TZ: process.env.TZ ?? 'UTC'`, so it honours a TZ already in the environment,
  // and one absolute instant is some other hour in every other zone — 12:00Z is
  // 23:00 in UTC+11, which puts the bug straight back for anyone running there.
  // `new Date(y, m, d, 12, ...)` is midday wherever the suite runs, so now+1h
  // cannot cross a day boundary anywhere.
  //
  // This removes a nondeterminism; it does not relax what is checked. Both
  // assertions below still fail if `fmtRelative` stops passing the label through
  // the catalogue — mutation-tested by dropping its `t ?` branch.
  describe('a relative label is translated', () => {
    const LOCAL_NOON = new Date(2026, 6, 14, 12, 0, 0);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(LOCAL_NOON);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('says Today in German when given the catalogue', () => {
      const de = createFormat('de-DE', through(DE as Record<string, string>));
      const label = de.fmtRelative(new Date(Date.now() + 60 * 60_000));
      expect(label).not.toContain('Today');
      expect(label).toBe(through(DE as Record<string, string>)('photosModule.todayAt', {
        time: de.fmtTime(new Date(Date.now() + 60 * 60_000)),
      }));
    });

    it('describes a further gap in the reader’s language', () => {
      const future = new Date(Date.now() + 5 * 24 * 3600_000);
      expect(createFormat('de-DE').fmtRelative(future)).toMatch(/Tag/);
      expect(createFormat('en-US').fmtRelative(future)).toMatch(/day/);
    });

    it('without a translator it stays English, which is what a cron wants', () => {
      expect(createFormat('en-US').fmtRelative(new Date())).toContain('Today');
    });
  });

  // The guard that keeps this from going stale. The pattern map is a closed
  // vocabulary, so a tenth pattern added next month would silently fall through to
  // date-fns and render un-localised. This reads every pattern the app actually
  // passes out of the source and requires each to be mapped.
  it('knows every date pattern the app passes it', () => {
    const files = execSync("git ls-files 'app/**/*.tsx' 'app/**/*.ts' 'components/**/*.tsx' 'lib/**/*.ts'",
      { encoding: 'utf8' }).split('\n').filter(Boolean);
    const passed = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/fmt(?:Date|DateTime)\([^,)]+,\s*(['"])(.+?)\1/g)) passed.add(m[2]);
    }
    expect(passed.size, 'the scan found no patterns at all, so it is not checking anything')
      .toBeGreaterThan(5);
    expect([...passed].filter((p) => !KNOWN_DATE_PATTERNS.includes(p)),
      'add these to PATTERNS in lib/utils/format.ts, or they render un-localised')
      .toEqual([]);
  });

  // Negative control: with every locale exercised above, "it differs" could still
  // pass on a formatter that varied by accident. Every locale must be constructible
  // and none may return an empty string for a valid date.
  it('every shipped locale formats a valid date', () => {
    for (const locale of LOCALES) {
      const f = createFormat(locale.code);
      expect(f.fmtDate(AT), locale.code).not.toBe('');
      expect(f.fmtTime(AT), locale.code).not.toBe('');
      expect(f.fmtMoney(1250), locale.code).toMatch(/12[.,]50/);
    }
  });

  // And the tolerant-parse contract the module was hardened for, per locale.
  it('never throws on a bad date, in any locale', () => {
    for (const locale of LOCALES) {
      const f = createFormat(locale.code);
      for (const bad of ['garbage', '2026-13-99T99:99:99Z', '0000-00-00']) {
        expect(f.fmtDate(bad), `${locale.code} / ${bad}`).toBe('');
        expect(f.fmtRelative(bad), `${locale.code} / ${bad}`).toBe('');
      }
    }
  });
});
