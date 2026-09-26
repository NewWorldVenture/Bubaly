import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * The meta-guard for audit C4-S5-02.
 *
 * `expect(src.indexOf(A)).toBeLessThan(src.indexOf(B))` reads as "A comes
 * before B" and is satisfied by A being ABSENT, because `indexOf` answers -1.
 * Eight guards in this suite were proved green against a product with the
 * statement they were named for deleted. `tests/helpers/source-order.ts`
 * exports `at()`, which asserts presence first; this test stops the bare form
 * from coming back.
 *
 * Its reach is one line: it sees an ordering assertion whose operand is written
 * inline. An index hoisted into a variable on an earlier line is not covered —
 * that is a limit of a text scan, stated rather than implied.
 */
const ORDERING = /\.(toBeLessThan|toBeGreaterThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual)\(/;

describe('ordering guards fail when the statement they name is absent', () => {
  it('no test asserts an order on a bare indexOf', () => {
    const offenders: string[] = [];
    for (const file of readdirSync('tests').filter((f) => f.endsWith('.test.ts'))) {
      // Blank the comments first, keeping line numbers: this file's own
      // docstring quotes the bad pattern, and a guard that matches its own
      // explanation is the defect one rung up.
      const lines = readFileSync(`tests/${file}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        // Whole-line comments, and `//` after whitespace — not every `//`: a
        // needle string like '// 2c. …' sat inside an at() call, and stripping
        // from it to the end of the line hid a slice(at(), at()) from this very
        // scan (found under C1-S9-75). Same rule as the write scanner's.
        .replace(/^[^\S\n]*\/\/.*$/gm, '')
        .replace(/(?<=[ \t])\/\/[^\n]*/g, '')
        .split('\n');
      lines.forEach((line, i) => {
        if (line.includes('.indexOf(') && ORDERING.test(line)) offenders.push(`tests/${file}:${i + 1}`);
      });
    }
    expect(offenders, 'use at() from tests/helpers/source-order.ts instead').toEqual([]);
  });

  it('at() itself refuses an absent needle', () => {
    expect(() => at('const a = 1;', 'never written')).toThrow();
    expect(at('alpha beta', 'beta')).toBeGreaterThan(at('alpha beta', 'alpha'));
    expect(at(['a', 'b'], 'b')).toBe(1);
  });

  it('between() refuses the empty slice that bounds-in-the-wrong-order produces', () => {
    expect(between('alpha beta gamma', 'alpha', 'gamma')).toBe('alpha beta ');
    // The sibling of the -1 sentinel: both bounds are searched from the START,
    // so asking for the text between a LATER needle and an EARLIER one yields
    // '' — on which every toContain fails and every not.toContain passes.
    expect(() => between('alpha beta gamma', 'gamma', 'alpha')).toThrow();
    expect(() => between('alpha beta', 'alpha', 'never written')).toThrow();
  });

  it('no test slices between two at() calls, which can silently be empty', () => {
    const offenders: string[] = [];
    for (const file of readdirSync('tests')) {
      if (!file.endsWith('.test.ts')) continue;
      const lines = readFileSync(`tests/${file}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        // Whole-line comments, and `//` after whitespace — not every `//`: a
        // needle string like '// 2c. …' sat inside an at() call, and stripping
        // from it to the end of the line hid a slice(at(), at()) from this very
        // scan (found under C1-S9-75). Same rule as the write scanner's.
        .replace(/^[^\S\n]*\/\/.*$/gm, '')
        .replace(/(?<=[ \t])\/\/[^\n]*/g, '')
        .split('\n');
      lines.forEach((line, i) => {
        // `.slice(at(x, a), at(x, b))` — use between() so the degenerate case
        // is a failure. An arithmetic bound (`at(x, a) - 60`) is deliberate and
        // is left alone.
        if (/\.slice\(\s*at\([^)]*\)\s*,\s*at\(/.test(line)) offenders.push(`tests/${file}:${i + 1}`);
      });
    }
    expect(offenders, 'use between() from tests/helpers/source-order.ts instead').toEqual([]);
  });
});
