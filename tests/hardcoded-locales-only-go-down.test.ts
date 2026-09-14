// A ratchet, not a clean sweep — and the honest reason is the size.
//
// Bubaly ships eleven locales. 247 formatter sites across 145 files hardcode
// 'en-US', and there are TWENTY-FOUR independent money formatters, each with its own
// `new Intl.NumberFormat('en-US', { currency: 'USD' })`:
//
//   lib/utils/format.ts          fmtMoney(cents)
//   lib/wallet/ledger.ts         formatCents(cents, currency)   — threads currency, pins locale
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
// Not every one of these is a defect, which is why this is a ceiling and not zero:
//   * lib/i18n/* holds 'en-US' as the DEFAULT LOCALE CODE — data, not a formatter.
//   * Crons, CSV exports and the text of a prompt sent to a model have no reader
//     whose language is known; the source language is correct there.
//   * Super Admin pages render to whoever operates Bubaly, in the platform's own
//     currency — 16 of the 20 fmtMoney files are these.
// Deciding which of the 145 fall in those categories is the conversion work. This
// test does not pretend to know; it only refuses to let the total grow.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** A hardcoded locale in a position where a formatter reads it. */
const FORMATTER_WITH_LOCALE =
  /(?:toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*'en-US'|Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|Collator|PluralRules)\(\s*'en-US'/g;

/**
 * The ceiling, measured when the shared formatter was made locale-aware.
 *
 * 249, and every step to that number was a way to get it wrong. A `git grep -c`
 * says 247, because git grep counts matching LINES and several of these hold two
 * formatters. Counting matches instead says 252 — but that reads COMMENTS, and one
 * of them is this pass's own explanation of the defect. Stripping comments gives
 * 251: 252 on HEAD before this pass, less the one lib/utils/format.ts closed.
 *
 * Getting those three numbers to disagree is how a ratchet starts life already
 * broken, which is why the derivation is written down rather than the result.
 */
const CEILING = 249;

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

  it('found something at all, so it is checking the real tree', () => {
    expect(scan(sourceFiles()).length).toBeGreaterThan(50);
  });
});
