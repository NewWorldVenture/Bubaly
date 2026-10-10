import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dollarsToCents } from '@/lib/marketplace/listings';

/**
 * A price typed with a decimal comma is the price that was typed.
 *
 * The marketplace's "Post in 60 seconds" box (components/marketplace/quick-post.tsx)
 * is a text field with `inputMode="decimal"`, and it saves through
 * `dollarsToCents`, which kept digits and `.` and threw everything else away.
 * German, Spanish, French, Italian, Dutch and Portuguese write — and their
 * decimal keypads type — a comma: "12,50" became 1250 dollars, so the item went
 * up at a hundred times its price, and "1.250" (one thousand two hundred fifty)
 * became 1.25. The box already shows its unit in the reader's notation; the
 * parse now reads the amount in it too.
 */
describe('a typed marketplace price', () => {
  it('reads a decimal comma as the decimal point', () => {
    expect(dollarsToCents('12,50', 'de-DE')).toBe(1250);
    expect(dollarsToCents('12,5', 'fr-FR')).toBe(1250);
    expect(dollarsToCents('0,99', 'it-IT')).toBe(99);
    expect(dollarsToCents('12,50 $', 'nl-NL')).toBe(1250);
  });

  it('reads a grouped thousand in the reader\'s notation', () => {
    expect(dollarsToCents('1.250', 'de-DE')).toBe(125_000);
    expect(dollarsToCents('1.250,75', 'es-ES')).toBe(125_075);
    expect(dollarsToCents('1 250,75', 'fr-FR')).toBe(125_075);
    expect(dollarsToCents('1.234.567', 'pt-PT')).toBe(123_456_700);
  });

  it('keeps reading en-US the way it always has', () => {
    expect(dollarsToCents('$12.50')).toBe(1250);
    expect(dollarsToCents('12.50', 'en-US')).toBe(1250);
    expect(dollarsToCents('1,250', 'en-US')).toBe(125_000);
    expect(dollarsToCents('1,250.75', 'en-US')).toBe(125_075);
    expect(dollarsToCents('1.250', 'en-US')).toBe(125);
    expect(dollarsToCents('8', 'en-US')).toBe(800);
    expect(dollarsToCents('', 'en-US')).toBe(0);
    expect(dollarsToCents('abc', 'de-DE')).toBe(0);
  });

  it('still reads the amounts the box fills in itself, in any locale', () => {
    // The AI draft and the "AI suggests" button write `String(cents / 100)`.
    for (const code of ['de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-PT', 'en-GB', 'en-US'] as const) {
      expect(dollarsToCents(String(1250 / 100), code), code).toBe(1250);
      expect(dollarsToCents(String(125_075 / 100), code), code).toBe(125_075);
      expect(dollarsToCents(String(4000 / 100), code), code).toBe(4000);
    }
  });

  it('is read in the poster\'s locale wherever the quick-post box saves or compares it', () => {
    const src = readFileSync('components/marketplace/quick-post.tsx', 'utf8');
    const calls = src.match(/dollarsToCents\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toBe('dollarsToCents(price, locale.code)');
  });
});
