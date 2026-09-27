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
// is one of the exempt categories below. What is left that is real is lib/ (51 sites in 32
// files), and it has been classified rather than assumed — THE HONEST FLOOR IS 55, NOT 0, and a ratchet that demands zero where zero is
// wrong is a ratchet someone deletes. The four categories to leave alone:
//
//   21  timezone-and-parts ENGINES — pinned and asserted by the case below, because
//       localising one changes arithmetic rather than wording.
//   17  app/api/ai/* prompt construction — read by the MODEL, not a person. Verified by
//       reading chat/route.ts:110, which builds its fmtDate inside the prompt text.
//   13  lib/ai/* context and result builders — same.
//    9  Super Admin / operator pages — the platform's own books in its own currency.
//    1  lib/marketing/crm.ts formatCents — SUPER ADMIN. Its only three callers are
//       app/(app)/admin/marketing/{affiliates,pipeline,proposals}/page.tsx, which are the
//       platform's own books in its own currency.
//    1  lib/assistant/tools.ts — a TOOL RESULT read by the model, not a person. Its
//       sibling on the next line uses 'en-CA' as a YYYY-MM-DD formatter, which is a
//       mechanism, and its own `note` field addresses the model directly.
//    1  lib/meals/pantry-chef.ts — the header says "Vision prompt". Read by the model.
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
// follows the reader, and it SURVIVED the merge of 198 commits of main: the per-file
// delta below shows components/ still at 0 files and 0 sites. What is left is app/ (25)
// and lib/ (51), and a meaningful share of that is correct: the AI prompt builders, the
// crons and exports, the Super Admin pages, and lib/i18n's locale codes, which are data
// rather than a formatter.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** A hardcoded locale in a position where a formatter reads it. */
const FORMATTER_WITH_LOCALE =
  /(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*'en-US'|Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|Collator|PluralRules)\(\s*'en-US'/g;

/**
 * The ceiling, measured when the shared formatter was made locale-aware.
 *
 * NOW 76, AND THE SIX THAT ARRIVED WERE NOT WRITTEN HERE. This instrument was born on
 * this audit's branch and has never existed on origin/main, so its 70 was measured
 * against ONE tree. The merge then brought 198 commits of main under a ceiling that had
 * never been held over them. A number that moves at a merge is the case where "it
 * probably drifted" is most tempting and least defensible, so the six were measured
 * before they were judged: the CURRENT scan was run, unchanged, over three trees held
 * still in detached worktrees — 617355b2 (this branch's pre-merge tip), origin/main, and
 * HEAD. Holding the instrument fixed while the tree varies is the only way to tell a new
 * defect from a newly-measured one. It reproduces 70 on 617355b2 and 16 mechanism sites
 * exactly, which is what earns the delta any trust. origin/main alone scores 247 — the
 * number this file started at, because none of the conversion work below exists there.
 *
 * The delta is FOUR FILES, and three of them did not exist on this branch at all:
 *
 *   lib/display/ambient.ts          +2   main 4 → HEAD 2
 *   lib/meals/week.ts               +2   new on main (669c521d)
 *   lib/social/schedule-time.ts     +1   new on main (f6e17ef6)
 *   lib/social/scheduled-publish.ts +1   new on main (f6e17ef6)
 *
 * ALL SIX ARE MECHANISM. Not one is a user-facing display formatter, and the reason is
 * worth recording: main's authors had ALREADY reached for the locale parameter wherever
 * a person reads the output. Each of these modules contains BOTH halves, and the halves
 * are correctly split.
 *
 *   lib/display/ambient.ts — dayPart() wraps its format() in `Number(...)` and feeds
 *     dayPartForHour(), which does arithmetic on it; formatClock() reads formatToParts
 *     for hour/minute/second and pads them by hand. Both pin hourCycle 'h23'. A locale
 *     with Arabic-Indic digits makes `Number()` return NaN and the kitchen screen's clock
 *     reads "NaN:٠٥". The two sites main's file has that ARE display formatters —
 *     the forward-facing "now & next" label at its lines 195-196 — were converted by this
 *     branch and the merge KEPT the converted version: they take `locale` at HEAD:216-217.
 *     That is why the file reads 4 on main and 2 here. The ratchet did not lose a
 *     conversion in the merge; it gained two engines.
 *   lib/meals/week.ts — mealWeek() builds a `YYYY-MM-DD` day KEY from formatToParts,
 *     and calendarDate() parses it straight back with /^\d{4}-\d{2}-\d{2}$/ and a
 *     non-null assertion. Localise it and a non-Latin numbering system or a non-gregorian
 *     calendar fails that regex, calendarDate returns null, and the `!` throws. The
 *     display half of this very file, formatMealDay(dayKey, locale, options), already
 *     TAKES a locale, and both of its callers in components/modules/meals-module.tsx pass
 *     the reader's. The same file gets both answers right; only one half is countable.
 *   lib/social/schedule-time.ts — scheduleTimezone() is the exact ics-time.ts pattern
 *     named below: a constructor used as a validity probe whose only output is
 *     resolvedOptions().timeZone, a canonical IANA zone that is never shown as wording.
 *     Its display half, formatScheduledTime(value, zone, locale), takes a locale and both
 *     callers — app/(app)/dashboard/social/{posts/[id],calendar}/page.tsx — pass
 *     locale.code.
 *
 * AND THE SIXTH IS A SITE THE MECHANISM CASE BELOW CANNOT SEE, which is the one honest
 * wrinkle here. lib/social/scheduled-publish.ts:25 is
 * `try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(instant); }
 * catch { return scheduleFailure('invalid'); }` — the formatted string is DISCARDED. The
 * statement exists only so an invalid zone throws RangeError and the receipt is refused.
 * Nothing renders it. But the case below identifies a bare probe by the ABSENCE of
 * `.format` after the constructor, and this probe calls `.format` precisely to force the
 * throw, so it matches no signal and is counted by the ceiling while the pin cannot see
 * it. Hence +6 on the ceiling and only +5 on the pin. The gap is recorded rather than
 * closed: widening the signal list to catch it would also start catching real display
 * formatters, and a pin that drifts upward on false positives stops being a pin.
 *
 * Before that, 70, and THE FLOOR ROSE AGAIN — for the third time, and again by reading
 * callers. lib/autopilot/engine.ts and lib/intelligence/hard-signals.ts build money
 * PROSE and are driven by app/api/cron/{autopilot-scan,model-refresh}/route.ts,
 * which PERSIST what they write. A cron has no reader, so their three sites join
 * the eight already blocked on I18N-001 rather than the convertible set: eleven
 * blocked, not eight. What was genuinely reachable converted — lib/location/
 * overview.ts (the history day heading), lib/marketing/format.ts (the public family
 * count, where German SWAPS the grouping and decimal marks so "12,000" reads as
 * twelve) and lib/purchases/answer.ts (which already took a translator and had only
 * its amounts pinned).
 *
 * Before that, 74. The four relative-day labels — lib/chores/dashboard.ts dueLabel,
 * lib/messages/overview.ts shortTime, lib/moments/prep.ts momentWhen and
 * lib/memories/memories.ts relativeDay — each mixed a formatter THIS FILE COUNTS
 * with English literals it CANNOT see ("Overdue", "Yesterday", "starting now").
 * Converting only the half this ceiling measures would have left a German family
 * reading "Overdue" beside "Di., 14. Juli": a half-translated chip, which is worse
 * than a wholly English one because it looks like someone tried. Each now takes the
 * locale AND a translator. Two seven-entry English weekday arrays were deleted with
 * them. Proved in tests/the-day-labels-follow-the-reader.test.ts.
 *
 * A SECOND CLASS THIS CEILING CANNOT SEE, measured while working the eighth tranche:
 * FIFTY-ONE money values write the currency symbol as a LITERAL — `$${x.toFixed(2)}`
 * — which holds no locale for this scan to find and has no locale at all: `toFixed`
 * always emits a "." and never groups. Even at ceiling ZERO those fifty-one would
 * still render "2768.00" to a German reader with the symbol on the American side.
 * Held by tests/the-currency-symbol-is-not-a-literal.test.ts (I18N-003). This is the
 * second such class after the English-literal time labels; a ceiling on hardcoded
 * locales is necessary and not sufficient, twice over.
 *
 * Now 80, and the eight that fell name a CLASS rather than a coincidence: SIX modules
 * — career, moving, projects, vacations, weekend and twin — wrote the currency symbol
 * BY HAND and localised only the digits. A locale swap alone, which is what this
 * ceiling rewards, would have rendered "$2.768" in German: the American symbol
 * position with German separators. The ratchet would have counted every one of them
 * converted. See tests/the-hand-prefixed-dollar-sign.test.ts, which asserts the exact
 * string AND that the symbol does not lead where the locale puts it last.
 *
 * Before that, 88. The Family Wallet hub (fmtUsd, fmtCount, fmtTxnDate), the Home dashboard
 * (lib/home/home-data.ts) and Utility Tracking (lib/home/utilities.ts) follow the
 * reader — and home-data's carried a second defect behind the hardcoded locale: it
 * prefixed the "$" BY HAND and localised only the digits, so a European locale would
 * have rendered "$2.767,60", the American symbol position with German separators.
 * Proved in tests/the-wallet-and-home-follow-the-reader.test.ts.
 *
 * Before that, 93. The time-ago tranche converted six more — lib/activity/feed.ts,
 * lib/memories/memories.ts, lib/family/safety.ts (relTime + fmtDateTime),
 * lib/location/geo.ts, lib/location/overview.ts, lib/marketplace/discover.ts and
 * lib/display/ambient.ts all delegate to one shared `fmtTimeAgo`.
 *
 * AND IT FOUND A DEFECT CLASS THIS FILE CANNOT SEE AT ALL. Eleven surfaces had
 * their own "time ago" ladder built from ENGLISH LITERALS — `'just now'`,
 * `` `${m}m ago` `` — which hold no locale for this scan to find, and two ended in
 * `toLocaleDateString()` with NO argument, following the BROWSER's locale rather
 * than the family's Bubaly choice. Both were green here throughout. Measured and
 * held by tests/one-time-ago-and-it-follows-the-reader.test.ts, with
 * scripts/audit-time-ago-ladders.mjs as the instrument. A ceiling on hardcoded
 * locales is necessary and not sufficient; see I18N-002.
 *
 * Before that, 99: the Finances tranche converted five — lib/finance/hub.ts (usd,
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
const CEILING = 76;

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
  // NOW 21, and the five that joined came in with the merge rather than from a new
  // habit. They are named and derived in full in the CEILING note above; in short,
  // lib/display/ambient.ts (+2: dayPart's Number(format()) and formatClock's
  // formatToParts, both pinning hourCycle 'h23' for the Kitchen Display), lib/meals/week.ts
  // (+2: mealWeek's formatToParts day-key engine, whose output calendarDate re-parses with
  // /^\d{4}-\d{2}-\d{2}$/) and lib/social/schedule-time.ts (+1: scheduleTimezone's
  // resolvedOptions() zone canonicaliser, the ics-time.ts pattern again). Each was read
  // before it was counted, and each is a genuine engine — the display formatter that sits
  // BESIDE it in the same file already takes a locale in all three cases. Raising this
  // number on anything less than that reading would defeat the whole point of pinning it.
  //
  // So the count is PINNED rather than minimised. If it FALLS, someone has localised a
  // parser and this fails with the reason — which is the failure mode a ceiling alone
  // cannot see, because converting a parser makes the ceiling look better.
  it('keeps the timezone-and-parts engines on a pinned locale', () => {
    const MECHANISM_SITES = 21;
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

  /**
   * The scan reaches the real tree — asserted by NAME, not by magnitude.
   *
   * This used to be `toBeGreaterThan(50)`, and it failed the moment the file count
   * reached exactly 50: a control meant to prove the scanner is not blind was keyed
   * to a number that FALLS as the work succeeds, so finishing the job would have
   * looked identical to the scanner breaking. That is the fifth guard in this audit
   * to assert the solution instead of the property.
   *
   * The property is that the scan sees files it must always see. The twenty-one pinned
   * timezone-and-parts engines are exactly that: they are never going away, because
   * localising one would be a defect. So the control rides on them.
   */
  it('reaches the real tree, named rather than counted', () => {
    const seen = new Set(scan(sourceFiles()).map((f) => f.file));
    for (const file of ['lib/services/scope.ts', 'lib/schedule/zoned.ts', 'lib/time/zoned.ts']) {
      expect(seen, `${file} pins a locale on purpose and the scan must see it`).toContain(file);
    }
    expect(sourceFiles().length).toBeGreaterThan(500);
  });
});
