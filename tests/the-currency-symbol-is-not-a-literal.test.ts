// I18N-003 — fifty-one money values whose currency symbol is a LITERAL.
//
// THE DEFECT, and why the locale ratchet is blind to it.
// tests/hardcoded-locales-only-go-down.test.ts counts `'en-US'` in a formatter
// position. It cannot see this:
//
//   `$${(cents / 100).toFixed(2)}`
//
// And this is not a milder version of the same problem — it is a worse one.
// `toFixed` has NO locale at all: it always emits a "." decimal mark and never
// groups, so a German reader gets "2768.00" where their convention is "2.768,00",
// with the symbol stuck on the American side. Even at ceiling ZERO on the locale
// ratchet, fifty-one money values would still render this way.
//
// Nor would a locale swap fix it. The symbol is text, so the best a swap achieves
// is "$2.768,00": the American symbol position with German separators, which
// nobody writes. `new Intl.NumberFormat(locale, { style: 'currency', currency })`
// is the fix — it places the symbol where the locale places it.
//
// WHY THIS PINS RATHER THAN CONVERTS. Every one of the fifty-one needs one of two
// things first, and neither is a formatter change:
//
//   - a locale threaded from a caller that does not currently have one
//     (lib/autopilot/engine.ts takes a FamilySnapshot; lib/intelligence/
//     hard-signals.ts takes rows), or
//   - the ENGLISH PROSE around the amount moved to the catalogue, because
//     "Spent $120 of your $400 monthly Fun budget" is not fixed by localising
//     two numbers inside an English sentence.
//
// Converting without that lowers a number while changing nothing a family sees,
// which is the "optional parameter nobody passes" this audit has refused all
// along. So the count is held here, visible, and may only fall.
import { describe, expect, it } from 'vitest';
import { findHandWrittenCurrency } from '../scripts/audit-hand-written-currency.mjs';

const SITES = 51;

describe('a currency symbol written as a literal', () => {
  const found = findHandWrittenCurrency() as { file: string; line: number }[];

  it(`is held at ${SITES} sites and may only fall`, () => {
    const byFile = [...new Set(found.map((f) => f.file))].sort();
    expect(found.length, [
      `${found.length} hand-written currency symbols, held at ${SITES}.`,
      found.length > SITES
        ? 'A change ADDED one. Use new Intl.NumberFormat(locale, { style: "currency", currency }) '
          + '— it puts the symbol where the locale puts it. `$${x.toFixed(2)}` has no locale at all.'
        : `Converted ${SITES - found.length}. Lower SITES to ${found.length} in this commit.`,
      ...byFile.slice(0, 10).map((f) => `  ${f}`),
    ].join('\n')).toBeLessThanOrEqual(SITES);
  });

  // Positive control. The whole count comes from one scanner, so a blind one would
  // report zero and the ceiling above would pass triumphantly.
  it('sees the shape it is counting', () => {
    expect(found.length).toBeGreaterThan(0);
    const files = new Set(found.map((f) => f.file));
    // Three that are certain to hold it until someone converts them.
    for (const file of ['lib/stripe/service-fee.ts', 'components/modules/billing-module.tsx']) {
      expect(files, `${file} writes the symbol by hand`).toContain(file);
    }
  });

  // Negative control: the scanner must not count a plain template placeholder, a
  // percentage, or a raw count. `${x}` is not a currency symbol.
  it('does not count an ordinary template placeholder', () => {
    // These live in the tree and must NOT appear: a like count, a distance, a
    // percentage. If any shows up the IS_MONEY filter has stopped discriminating.
    const files = new Set(found.map((f) => f.file));
    for (const file of ['lib/blog/engagement.ts', 'lib/location/geo.ts']) {
      expect(files, `${file} formats a count or a distance, not money`).not.toContain(file);
    }
  });

  // The operator console and model-read text are exempt by the audit's own rule,
  // and the exemption is structural rather than a filename list.
  it('exempts the operator console and the text the model reads', () => {
    for (const { file } of found) {
      expect(file, 'admin surfaces are en-US by the audit rule').not.toMatch(/^app\/\(app\)\/admin\/|^components\/admin\//);
      expect(file, 'AI prompt and tool text is read by the model').not.toMatch(/^lib\/ai\/|^app\/api\/ai\//);
    }
  });
});
