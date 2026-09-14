// A ratchet, not a clean sweep — and the honest reason is the size.
//
// Bubaly ships eleven locales. 247 formatter sites across 145 files hardcode
// 'en-US', and there are TWENTY-FOUR independent money formatters, each with its own
// `new Intl.NumberFormat('en-US', { currency: 'USD' })`:
//
//   lib/utils/format.ts          fmtMoney(cents)
//   lib/wallet/ledger.ts         formatCents(cents, currency, locale)  — converted
//   lib/wallet/hub.ts            inline
//   lib/insurance/policies.ts    fmtMoney(dollars)              — takes DOLLARS, not cents
//   lib/ai/result-cards.ts, lib/finance/{hub,splits,timeline}.ts, lib/home/utilities.ts …
//
// Converting all of them is a project, not one change, and a half-conversion is worse
// than either finishing it or recording it precisely: it leaves two conventions and
// no way to tell which a given surface follows. So the shared mechanism landed first
// (lib/utils/format.ts createFormat, useFormat, getFormat — proved in
// tests/the-shared-formatter-follows-the-locale.test.ts), and this holds the
// remainder finite and visible while it is worked through.
//
// THE NUMBER MAY ONLY GO DOWN. If a change adds a hardcoded formatter this fails and
// names the file; if a change converts one, lower the number in the same commit.
//
// components/ IS AT ZERO and app/ IS AT ITS FLOOR OF 25 — every remaining site under app/
// is one of the exempt categories below. What is left that is real is lib/ (79 sites in 52
// files), and it has been classified rather than assumed — THE HONEST FLOOR IS 55, NOT 0, and a ratchet that demands zero where zero is
// wrong is a ratchet someone deletes. The four categories to leave alone:
//
//   16  timezone-and-parts ENGINES — pinned and asserted by the case below, because
//       localising one changes arithmetic rather than wording.
//   17  app/api/ai/* prompt construction — read by the MODEL, not a person. Verified by
//       reading chat/route.ts:110, which builds its fmtDate inside the prompt text.
//   13  lib/ai/* context and result builders — same.
//    9  Super Admin / operator pages — the platform's own books in its own currency.
//    1  lib/services/finances/index.ts formatDollars — NOT A DISPLAY FORMATTER either,
//       and this one reads like one. Its 27 callers are (a) lib/ai/tools/finances.ts
//       summarize/consequences strings, which the MODEL reads, and (b) activity-ledger
//       title/detail rows this module writes (index.ts:704, 723, 945, 1017, 1096, 1187).
//       A ledger row is a RECORD with many readers over time, written once; formatting
//       its numbers in the language of whoever happened to trigger the write makes the
//       record depend on the actor. Its English prose is the real defect there, and that
//       is a catalogue change, not a formatter change.
//    2  lib/onboarding/ics-time.ts — NOT A DISPLAY FORMATTER. Its two calls are a
//       mechanism: resolvedOptions().timeZone canonicalises an IANA zone, and the second
//       pins calendar 'gregory', numberingSystem 'latn' and hourCycle 'h23' to extract
//       numeric parts for an ICS payload. Localising it could change the numbering
//       system or calendar under a parser that reads those parts positionally. This is
//       the one a sweep to zero would have BROKEN.
//
// Of the 82 genuine defects, EIGHT ARE BLOCKED and not by effort: a family's language
// choice lives only in a cookie (LOCALE_COOKIE, lib/i18n/locales.ts:54) with no column
// on any member or profile table, so the five files that send emails, pushes and
// reminders cannot know the recipient's language. lib/i18n/server.ts:47 states that
// assumption outright — background jobs have "no user to have a language preference" —
// and the weekly digest email is the counterexample. Persisting it is a migration, which
// is the owner's. See audit/claude-1.md, Pass AG.
// Deciding which of the remaining fall in those categories is the conversion work.
// This test does not pretend to know; it only refuses to let the total grow.
//
// components/ is now at ZERO — every date, time and money value a component renders
// follows the reader. What is left is app/ (44) and lib/ (79), and a meaningful share of
// that is correct: the AI prompt builders, the crons and exports, the Super Admin pages,
// and lib/i18n's locale codes, which are data rather than a formatter.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** A hardcoded locale in a position where a formatter reads it. */
const FORMATTER_WITH_LOCALE =
  /(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*'en-US'|Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|Collator|PluralRules)\(\s*'en-US'/g;

/**
 * The ceiling, measured when the shared formatter was made locale-aware.
 *
 * Now 99: the Finances tranche converted five — lib/finance/hub.ts (usd,
 * fmtDueDate), lib/finance/splits.ts (usd) and lib/finance/timeline.ts (money,
 * pretty) — across twelve surfaces, proved in
 * tests/the-finance-surfaces-follow-the-reader.test.ts.
 *
 * It started at 104, and every step to that number was a way to get it wrong. A `git grep -c`
 * says 247, because git grep counts matching LINES and several of these hold two
 * formatters. Counting matches instead says 252 — but that reads COMMENTS, and one
 * of them is this pass's own explanation of the defect. Stripping comments gives
 * 251: 252 on HEAD before this pass, less the one lib/utils/format.ts closed.
 *
 * Getting those three numbers to disagree is how a ratchet starts life already
 * broken, which is why the derivation is written down rather than the result.
 */
const CEILING = 99;

/**
 * Comments stripped first, and this is not a detail.
 *
 * The header of lib/utils/format.ts quotes `new Intl.NumberFormat('en-US')` to
 * explain the defect it fixes. A scan that reads comments counted that quote as an
 * occurrence — so the module that CLOSED a site still showed one, and deleting the
 * explanation would have "converted" it. A ratchet that can be satisfied by removing
 * a comment measures nothing.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function scan(files: string[]) {
  const perFile: { file: string; count: number }[] = [];
  for (const file of files) {
    const hits = withoutComments(readFileSync(file, 'utf8')).match(FORMATTER_WITH_LOCALE);
    if (hits?.length) perFile.push({ file, count: hits.length });
  }
  return perFile;
}

const sourceFiles = () =>
  execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'components/**/*.ts' 'components/**/*.tsx' 'lib/**/*.ts' 'lib/**/*.tsx'",
    { encoding: 'utf8' }).split('\n').filter(Boolean);

describe('hardcoded locales only go down', () => {
  it(`is at or below ${CEILING} formatter sites`, () => {
    const perFile = scan(sourceFiles());
    const total = perFile.reduce((sum, f) => sum + f.count, 0);
    expect(total, [
      `${total} hardcoded-locale formatter sites, ceiling ${CEILING}.`,
      total > CEILING
        ? 'A change ADDED one. Use useFormat() in a client component, await getFormat() '
          + 'in a server one, or createFormat(code) in a pure function — and if the reader '
          + 'genuinely has no language (a cron, an export, a model prompt), the bare exports '
          + 'from lib/utils/format.ts are the right answer and are named for it.'
        : `Converted ${CEILING - total}. Lower CEILING to ${total} in this commit.`,
      ...perFile.slice(0, 12).map((f) => `  ${f.file}  ×${f.count}`),
    ].join('\n')).toBeLessThanOrEqual(CEILING);
  });

  // Positive control. With the ceiling met rather than zero, a scan that had gone
  // blind would pass this file trivially — so plant one and require it to be seen.
  it('sees a hardcoded formatter', () => {
    const planted = [
      `new Intl.NumberFormat('en-US', { style: 'currency' })`,
      `d.toLocaleDateString('en-US', { month: 'short' })`,
      `new Intl.DateTimeFormat('en-US')`,
      `new Intl.RelativeTimeFormat('en-US')`,
    ];
    for (const line of planted) {
      expect(line.match(FORMATTER_WITH_LOCALE), line).toHaveLength(1);
    }
  });

  // Negative control: the pattern must not count a locale used as DATA. lib/i18n
  // holds 'en-US' as the default locale code in a dozen places and none is a
  // formatter; counting them would make the ceiling meaningless.
  it('does not count a locale code that is data', () => {
    const notFormatters = [
      `export const DEFAULT_LOCALE: LocaleCode = 'en-US';`,
      `{ code: 'en-US', language: 'en', region: 'US' }`,
      `if (locale.code === 'en-US') return fallback;`,
      `createFormat('en-US')`,
      `new Intl.NumberFormat(locale.code, { style: 'currency' })`,
    ];
    for (const line of notFormatters) {
      expect(line.match(FORMATTER_WITH_LOCALE), line).toBeNull();
    }
  });

  // ── The sites that must KEEP 'en-US' ──────────────────────────────────────────
  //
  // The ceiling above counts every hardcoded locale, which makes it look as though the
  // target is zero. It is not. This codebase deliberately uses
  // Intl.DateTimeFormat('en-US', { timeZone }) as a TIMEZONE-AND-PARTS ENGINE in eleven
  // modules, several with comments saying so:
  //
  //   lib/services/scope.ts       hourInTz parses the hour with parseInt — and already
  //                               carries a comment that 'en-US' renders midnight as
  //                               '24' in some ICU versions, which it normalises
  //   lib/schedule/zoned.ts       tzOffsetMs reads formatToParts for a DST-correct offset
  //   lib/time/zoned.ts           isValidTimezone uses the CONSTRUCTOR as a validity probe
  //   lib/onboarding/ics-time.ts  resolvedOptions().timeZone canonicalises a zone; the
  //                               second pins calendar/numberingSystem/hourCycle so an
  //                               ICS parser can read parts positionally
  //   lib/guardian/rules.ts       parses hour and minute out of a fixed-format string to
  //                               decide call routing
  //   … and confirmation-import, routines/schedule, onboarding-calendar, first-brief,
  //     first-brief-display, assistant/answers
  //
  // Localising any of those changes arithmetic, not wording: a different numbering
  // system or calendar, or a clock label where a number was expected. Quiet hours,
  // Guardian routing, trip import and onboarding all read these.
  //
  // So the count is PINNED rather than minimised. If it FALLS, someone has localised a
  // parser and this fails with the reason — which is the failure mode a ceiling alone
  // cannot see, because converting a parser makes the ceiling look better.
  it('keeps the timezone-and-parts engines on a pinned locale', () => {
    const MECHANISM_SITES = 16;
    const SIGNALS: [RegExp, string][] = [
      [/\.resolvedOptions\(\)/, 'resolvedOptions — canonicalising a zone'],
      [/formatToParts/, 'formatToParts — reading parts out'],
      [/hour12:\s*false|hourCycle:\s*'h23'/, 'a numeric clock, not a label'],
      [/calendar:\s*'gregory'|numberingSystem:\s*'latn'/, 'pinned for a parser'],
      [/parseInt|Number\.parseInt|Number\(/, 'output parsed back into a number'],
    ];
    let found = 0;
    for (const file of sourceFiles()) {
      if (/^lib\/(i18n|ai)\/|\/admin\/|api\/ai\/|api\/cron\//.test(file)) continue;
      const text = withoutComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(FORMATTER_WITH_LOCALE)) {
        const window = text.slice(Math.max(0, m.index! - 260), m.index! + 420);
        const bare = /Intl\.DateTimeFormat\(\s*'en-US'[^;]*\);/.test(text.slice(m.index!, m.index! + 160))
          && !/\.format/.test(text.slice(m.index!, m.index! + 200));
        if (bare || SIGNALS.some(([re]) => re.test(window))) found += 1;
      }
    }
    expect(found, found < MECHANISM_SITES
      ? 'a timezone/parts engine has been localised — read the note above before "fixing" '
        + 'this. These calls compute offsets, hours and ICS parts; the locale is load-bearing, '
        + 'and lib/services/scope.ts says so in its own comment.'
      : 'new mechanism sites are fine — raise MECHANISM_SITES to match, and say why in the note',
    ).toBe(MECHANISM_SITES);
  });

  it('found something at all, so it is checking the real tree', () => {
    expect(scan(sourceFiles()).length).toBeGreaterThan(50);
  });
});
