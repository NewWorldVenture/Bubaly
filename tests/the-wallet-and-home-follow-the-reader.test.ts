// The Family Wallet hub, the Home dashboard and Utility Tracking format for the
// reader — and one of them was wrong in a way a locale swap alone would not fix.
//
// `lib/home/home-data.ts usd` prefixed the "$" BY HAND and localised only the
// digits:
//
//   `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
//
// Handing that a European locale produces "$2.767,60" — the symbol in the
// American position with German separators, a currency notation nobody writes.
// `style: 'currency'` puts the symbol where the locale puts it. That is why this
// file asserts EXACT strings rather than `toContain`: the separator characters and
// the symbol's POSITION are the whole finding, and both are invisible to a
// substring check.
//
// `fmtCount` is the sharpest case in the suite. Its own comment said "locale
// separators" while the code pinned en-US, so a German reader saw "2,850" — and
// German writes "2.850" for the same number and "2,850" for two-point-eight-five.
// A wrong grouping separator there is not cosmetic; it reads as a different number.
import { describe, expect, it } from 'vitest';
import { fmtUsd, fmtDollars, fmtCount, fmtSignedUsd, fmtTxnDate } from '@/lib/wallet/hub';
import { usd as homeUsd } from '@/lib/home/home-data';
import { usd as utilityUsd } from '@/lib/home/utilities';

describe('lib/wallet/hub — the Family Wallet', () => {
  it('formats cents in the reader locale, in dollars', () => {
    expect(fmtUsd(824550)).toBe('$8,245.50');
    expect(fmtUsd(824550, 'de-DE')).toBe('8.245,50 $');
    expect(fmtUsd(824550, 'fr-FR')).toBe('8 245,50 $US');
  });

  it('carries the locale through the dollars and signed wrappers', () => {
    // Both delegate to fmtUsd; a wrapper that drops its locale argument is exactly
    // the half-conversion tsc cannot see, since the parameter is optional.
    expect(fmtDollars(8245.5, 'de-DE')).toBe('8.245,50 $');
    expect(fmtSignedUsd(824550, 'de-DE')).toBe('+8.245,50 $');
    expect(fmtSignedUsd(-824550, 'de-DE')).toBe('-8.245,50 $');
  });

  it('groups a count the way the reader groups numbers', () => {
    expect(fmtCount(2850)).toBe('2,850');
    // German swaps the two marks, so the en-US rendering is readable as 2.85.
    expect(fmtCount(2850, 'de-DE')).toBe('2.850');
    expect(fmtCount(2850, 'fr-FR')).toBe('2 850');
  });

  it('orders a transaction date the way the reader writes dates', () => {
    const de = fmtTxnDate('2026-07-14', 'de-DE');
    expect(de).toBe('14. Juli 2026');
    expect(de.indexOf('14')).toBeLessThan(de.indexOf('Juli'));
    expect(fmtTxnDate('2026-07-14')).toBe('Jul 14, 2026');
    expect(fmtTxnDate('not-a-date', 'de-DE')).toBe('');
  });
});

describe('lib/home — the Home dashboard and Utility Tracking', () => {
  // The hand-prefixed symbol. Asserting the exact string is the only thing that
  // would have caught "$2.767,60".
  it('puts the currency symbol where the locale puts it', () => {
    expect(homeUsd(2767.6)).toBe('$2,767.60');
    expect(homeUsd(2767.6, 'de-DE')).toBe('2.767,60 $');
    expect(homeUsd(2767.6, 'fr-FR')).toBe('2 767,60 $US');
    // The symbol must not lead in a locale that puts it last.
    expect(homeUsd(2767.6, 'de-DE').startsWith('$')).toBe(false);
  });

  it('still handles a null-ish amount in every locale', () => {
    expect(homeUsd(undefined as unknown as number)).toBe('$0.00');
    expect(homeUsd(undefined as unknown as number, 'de-DE')).toBe('0,00 $');
  });

  it('formats a utility bill in the reader locale', () => {
    expect(utilityUsd(12345)).toBe('$123.45');
    expect(utilityUsd(12345, 'de-DE')).toBe('123,45 $');
  });
});
