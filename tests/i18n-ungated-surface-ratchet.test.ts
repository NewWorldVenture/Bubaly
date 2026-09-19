import { describe, expect, it } from 'vitest';
import { scanPaths } from '../scripts/i18n-scan.mjs';

// `app/` + `components/` is deliberately NOT in GATED_SURFACES, and the reason
// in scripts/i18n-scan.mjs is a good one: it was gated once on the strength of a
// zero from a scanner that could not see copy in a data structure, and widening
// the scanner turned that zero into thousands. A surface gated while dirty
// teaches everyone to ignore the gate.
//
// But "it goes back in the list when it scans clean" has no force on its own.
// Between that decision and this file nothing stopped the number growing, and
// nothing would have reported it if it had.
//
// So: a ratchet rather than a gate. The surface does not have to be clean; it
// has to not get worse. This is the same shape as
// tests/silent-empty-read-ratchet.ts, for the same reason.
//
// ── On the number, and a wrong conclusion worth recording ────────────────────
//
// The comment beside GATED_SURFACES records 2,343. Today's scan says 2,812,
// which reads like 469 strings of drift. It is not. Measured with ONE scanner
// held fixed — today's — against both trees:
//
//     current scanner, tree at 0babad30 (when 2,343 was written)   2,903
//     current scanner, tree today                                  2,812
//
// The surface has improved by 91. The apparent increase was the scanner getting
// better at seeing strings — exactly the improvement that produced the 2,343 in
// the first place. Comparing two numbers from two different scanners says
// nothing about the code, and the obvious reading of it was backwards.
//
// Which is also the warning for whoever trips this test: a stricter scanner
// raises the count without a single new hardcoded string being written. That is
// a legitimate reason to raise CEILING, and it is the ONLY one. Say which in
// the commit.
// RAISED 2812 -> 2878 because the SCANNER got stricter, which this file's
// header names as the only legitimate reason, and requires saying which.
//
// Measured both ways against the SAME tree, exactly as the 2,343 correction
// above was:
//
//     old scanner, tree today   2,804
//     new scanner, tree today   2,878
//
// A delta of 74, entirely the scanner. Not one new hardcoded string was
// written. The old scanner also reads 2,804 against the 2,812 it was set at, so
// the surface has IMPROVED by 8 in the meantime.
//
// What the scanner learned to see: the toast API — `success(...)` and
// `toastError(...)`, the app's own user-facing notifications — in three shapes
// it had been blind to.
//
//   1. Strings containing PARENTHESES. `/\)\s*$/` in NOT_COPY exists to catch
//      TEXT_PATTERN slicing through an expression, and it is right there. A
//      QUOTED literal cannot be such a slice — the quotes bound it — so the
//      rule only ever hid real copy: "Photo is too large (max 25 MB)", "Item
//      name is too long (max 120 characters)", "Split must total 100%
//      (currently 40%)." Those rules now apply only to undelimited matches.
//   2. DOUBLE-QUOTED strings. The pattern matched `'...'` alone.
//   3. TEMPLATE LITERALS — which is how every interpolated message in this
//      codebase is written. They are tested with their `${...}` holes stripped
//      and reported whole, so `${item.name}: lent out` counts as copy while
//      `${a} ${b}` still does not.
//
// The shape of this is the same one the header already warns about: a surface
// measured by a scanner that could not see a whole CATEGORY of copy. It was
// data structures last time and the app's own toast calls this time.
const CEILING = 2878;

describe('the ungated i18n surface does not get worse', () => {
  const findings = scanPaths(['app', 'components']);
  const total = findings.reduce((n: number, r: { findings: unknown[] }) => n + r.findings.length, 0);

  it('scans the surface it claims to (non-vacuity)', () => {
    // A scanner that silently found nothing would satisfy the ceiling forever.
    expect(findings.length).toBeGreaterThan(400);
    expect(total).toBeGreaterThan(1000);
  });

  it(`has no more than ${CEILING} hardcoded strings in app/ + components/`, () => {
    expect(
      total,
      `Hardcoded strings on the ungated surface went UP (${total} > ${CEILING}).\n` +
      'If you added user-visible copy: lift it into lib/i18n/messages/en-US.json,\n' +
      'translate it in the base catalogues, and render it through t().\n' +
      'If you made the scanner stricter: that raises the count without any new\n' +
      'hardcoded string, and is the one legitimate reason to raise CEILING here.\n' +
      'Say which in the commit message — the two are indistinguishable from the\n' +
      'number alone, and reading one as the other gets the direction backwards.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('lowers the ceiling when the surface improves', () => {
    // A ratchet nobody tightens is a ceiling that drifts up to meet the code.
    // This fails once the gap is wide enough to be worth banking.
    expect(
      CEILING - total,
      `The surface is ${CEILING - total} strings better than the ceiling — lower CEILING to ${total}.`,
    ).toBeLessThan(150);
  });
});
