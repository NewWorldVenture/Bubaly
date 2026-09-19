import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

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
        .replace(/\/\/[^\n]*/g, '')
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
});
