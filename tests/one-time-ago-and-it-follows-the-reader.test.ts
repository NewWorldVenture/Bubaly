// There is one "time ago", and it follows the reader.
//
// THE DEFECT THE LOCALE RATCHET COULD NOT SEE. tests/hardcoded-locales-only-go-down.test.ts
// counts `'en-US'` in a formatter position. It is blind to this:
//
//   if (mins < 60) return `${mins}m ago`;
//
// There is no locale in that line to find — the English IS the literal. Eleven
// surfaces had grown their own ladder under five different names (`relativeTime`
// three times, `relTime`, `timeAgo`, `ago`, plus two written inline) with three
// different wordings, and every one showed English to all eleven locales while the
// locale scan stayed green.
//
// A THIRD FLAVOUR, also invisible: two of them ended in `toLocaleDateString()` with
// no argument, which follows the BROWSER's locale rather than the family's Bubaly
// choice. A family who set Bubaly to Deutsch on an en-US laptop saw American dates
// there, and no scan for `'en-US'` could ever say so.
//
// So this file holds two things: that the shared `fmtTimeAgo` actually changes
// language, and that the private ladders only go down.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFormat } from '@/lib/utils/format';
import { findLadders } from '../scripts/audit-time-ago-ladders.mjs';

const NOW = new Date('2026-01-10T12:00:00Z');
const ago = (code: string, minutes: number, opts = {}) =>
  createFormat(code as never).fmtTimeAgo(new Date(NOW.getTime() - minutes * 60_000), { now: NOW, ...opts });

describe('the shared time-ago', () => {
  // en-US is byte-identical to the ladders this replaced, on purpose: the English
  // copy on ten surfaces is a shipped contract, and 'narrow' + numeric 'always'
  // reproduces it exactly. The one change is the sub-minute label.
  it('renders en-US exactly as the ladders it replaced did', () => {
    expect(ago('en-US', 30)).toBe('30m ago');
    expect(ago('en-US', 180)).toBe('3h ago');
    expect(ago('en-US', 60 * 48)).toBe('2d ago');
    expect(ago('en-US', 60 * 24 * 7)).toBe('1w ago');
  });

  it('says a real word for a sub-minute gap in every locale', () => {
    // "just now" was English for everybody. Intl's own word exists in all eleven —
    // and narrow/always would have said "in 0s", which is worse than either.
    const expected: Record<string, string> = {
      'en-US': 'now', 'en-GB': 'now', 'de-DE': 'jetzt', 'es-ES': 'ahora',
      'es-MX': 'ahora', 'es-US': 'ahora', 'fr-FR': 'maintenant', 'fr-CA': 'maintenant',
      'it-IT': 'ora', 'nl-NL': 'nu', 'pt-PT': 'agora',
    };
    for (const [code, word] of Object.entries(expected)) {
      expect(ago(code, 0.5), code).toBe(word);
    }
  });

  it('changes language at every rung, not just one', () => {
    expect(ago('de-DE', 30)).toBe('vor 30 m');
    expect(ago('de-DE', 180)).toBe('vor 3 Std.');
    expect(ago('de-DE', 60 * 48)).toBe('vor 2 Tagen');
    expect(ago('nl-NL', 180)).toBe('3 uur geleden');
    expect(ago('it-IT', 60 * 48)).toBe('2 gg fa');
    expect(ago('es-ES', 30)).toBe('hace 30 min');
  });

  // A phone's clock and Postgres disagree by seconds all the time. A marketplace row
  // reading "in 1 minute" is a bug report, so the future clamps to the sub-minute
  // label — which tests/marketplace-discover.test.ts had already pinned.
  it('clamps a future timestamp rather than counting forward', () => {
    expect(ago('en-US', -5)).toBe('now');
    expect(ago('de-DE', -60 * 48)).toBe('jetzt');
  });

  it('switches to an absolute date only when the caller asks, and in the reader locale', () => {
    // No threshold: carries on in weeks however old.
    expect(ago('en-US', 60 * 24 * 40)).toBe('5w ago');
    // The Memories attribution asks for a dated label after a week, with the year.
    const opts = { absoluteAfterDays: 7, absolutePattern: 'MMM d, yyyy' };
    expect(ago('en-US', 60 * 24 * 40, opts)).toBe('Dec 1, 2025');
    // 'MMM' is the SHORT month, so German abbreviates December and does not
    // abbreviate June — which is why a test that happens to pick June proves less
    // than it looks like it does.
    expect(ago('de-DE', 60 * 24 * 40, opts)).toBe('1. Dez. 2025');
    // Below the threshold the elapsed label still wins.
    expect(ago('en-US', 60 * 24 * 3, opts)).toBe('3d ago');
  });

  it('returns empty for nothing and for an unparseable value', () => {
    const f = createFormat('de-DE');
    expect(f.fmtTimeAgo(null)).toBe('');
    expect(f.fmtTimeAgo(undefined)).toBe('');
    expect(f.fmtTimeAgo('not-a-date')).toBe('');
  });

  it('is reachable from both halves of the boundary', () => {
    // useFormat() and getFormat() both return createFormat(...), so a helper added
    // to the Format type is available to a client and a server component alike.
    // Asserting the TYPE carries it is what keeps that true.
    const f = createFormat('fr-FR');
    expect(typeof f.fmtTimeAgo).toBe('function');
  });
});

// ── the ratchet on private ladders ────────────────────────────────────────────
//
// PINNED, not zero, and each number means something different:
//
//   english-only        MUST STAY 0. A ladder built from English literals shows a
//                       German family American words, and no locale scan sees it.
//   localised-private   Duplication rather than a wrong language. Four are worth
//                       folding into fmtTimeAgo; the fifth, lib/display/ambient.ts
//                       countdownLabel, is FORWARD-facing ("in 15 min", "Sat 3:00 PM")
//                       and cannot use a past-tense helper — it is correct as it is.
//   composite-duration  "2d 4h" (auction time left) and "7h 30m" (a night's sleep).
//                       Intl.RelativeTimeFormat describes ONE unit in one direction,
//                       so it cannot express these at all. A real gap, needing
//                       Intl.DurationFormat or a catalogue key; not a ladder.
//   browser-locale      `toLocaleDateString()` with no argument — `([], …)` counts too,
//                       being the same thing spelled so it looks deliberate. Follows the
//                       BROWSER, not the family's Bubaly choice, and the worst of the four
//                       to diagnose because it LOOKS locale-aware in the source. Eighteen
//                       were converted; the one left is an email, blocked on I18N-001.
describe('private time-ago ladders only go down', () => {
  const found = findLadders() as { file: string; line: number; kind: string }[];
  const of = (kind: string) => found.filter((f) => f.kind === kind);

  it('has no ladder built from English literals', () => {
    expect(of('ladder').map((f) => `${f.file}:${f.line}`), [
      'A hand-rolled "time ago" built from English literals. The locale ratchet cannot',
      'see this — there is no locale in `${m}m ago` to find. Use useFormat().fmtTimeAgo()',
      'in a client component, (await getFormat()).fmtTimeAgo() in a server one, or',
      'createFormat(code).fmtTimeAgo() in a pure helper.',
    ].join('\n')).toEqual([]);
  });

  // TWO LEFT, AND BOTH ARE CORRECT AS THEY ARE — which is why this asserts the files
  // rather than a count. `ladder-localised` never meant "shows the reader their
  // language": four of the six that used to be here took a LocaleCode and still said
  // "just now", "3 hours ago" and "Yesterday" in English, with the locale reaching only
  // the fallback date. Accepting a LocaleCode is not evidence of anything.
  //
  // These two are past-tense helpers' opposites: `countdownLabel` is FORWARD-facing
  // ("in 15 min", "Sat 3:00 PM" on the Kitchen Display) and `sinceLabel` says
  // "Since 3:04 PM" rather than an elapsed span. Neither can be expressed by
  // fmtTimeAgo, and both take the locale AND a translator for their words.
  it('has two private ladders left, and both are the ones that should be', () => {
    const files = of('ladder-localised').map((f) => f.file).sort();
    expect(files).toEqual(['lib/display/ambient.ts', 'lib/location/overview.ts']);
  });

  // Named by file, not counted, because the honest list is longer than the scan can
  // see: lib/sleep/coach.ts fmtHours renders "7h 30m" from MINUTES and so has no
  // millisecond divisor to anchor on. An independent pass over two-unit templates was
  // tried and reverted — it matched prose ("3 packed days in the last 4 weeks") and
  // single-unit labels across template boundaries. A count that cannot be defended is
  // worse than a name that can, so the miss is written into the scanner's header.
  it('holds the composite durations at three files, with one known miss recorded', () => {
    const files = [...new Set(of('composite-duration').map((f) => f.file))].sort();
    expect(files).toEqual([
      'lib/analytics/journey.ts',
      'lib/analytics/onboarding.ts',
      'lib/marketplace/auction.ts',
    ]);
    const scanner = readFileSync('scripts/audit-time-ago-ladders.mjs', 'utf8');
    expect(scanner, 'the known miss must stay named in the scanner').toContain('lib/sleep/coach.ts');
  });

  // I18N-002 CLOSED except for the one site that cannot be fixed without a migration.
  // Eighteen were converted; `lib/emails/chore-reminder.tsx` is an EMAIL, and a family's
  // language choice lives only in a cookie a cron cannot read (I18N-001). It is counted
  // here rather than exempted, so it stays visible as blocked work rather than
  // disappearing into a passing test.
  it('has one browser-locale date left, and it is the one blocked on I18N-001', () => {
    const left = of('browser-locale');
    expect(left.map((f) => f.file), 'toLocaleDateString()/toLocaleTimeString() with no locale '
      + 'follows the BROWSER, not the family\'s Bubaly choice — so a family reading Bubaly in '
      + 'German on an en-US laptop gets American dates. Use useFormat() in a client component '
      + 'or await getFormat() in a server one; the number may only fall.')
      .toEqual(['lib/emails/chore-reminder.tsx']);
  });

  // Positive control. All four classifications come from one instrument, so if it
  // went blind every count above would read zero and three of the four tests would
  // pass. Plant one of each and require them to be seen.
  it('the instrument sees each of the four shapes', () => {
    expect(found.length).toBeGreaterThan(0);
    for (const kind of ['ladder-localised', 'composite-duration', 'browser-locale']) {
      expect(of(kind).length, `${kind} must be detected somewhere`).toBeGreaterThan(0);
    }
  });
});
