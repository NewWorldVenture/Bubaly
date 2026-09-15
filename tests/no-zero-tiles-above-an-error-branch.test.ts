import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A page that consults its read error LOWER DOWN than the numbers it derives
// from that same read still reports the failure as data.
//
// dashboard/journeys/page.tsx carried the comment "A failed telemetry read must
// not masquerade as 'no events' — that would tell the operator onboarding
// traffic is zero when the query actually errored", and then did exactly that:
// `error` was consulted inside the card at the bottom, while three headline
// StatTiles rendered totals computed from `(data ?? [])` ABOVE it. A failed read
// showed "0 journeys started, 0 completed, 0%" in large type with the
// explanation underneath. Zero traffic and a broken query looked identical, and
// the tiles are the part anyone reads. Audit C4-S4-05.
//
// The rule this encodes is positional, which is why a plain "does it mention
// error" check would have passed the defect: the refusal must come BEFORE the
// first figure derived from the read.

const SOURCE = readFileSync(resolve('app/(app)/dashboard/journeys/page.tsx'), 'utf8')
  // Comments stripped: this file explains the defect at length, and a matcher
  // that reads prose as code would pass on the explanation alone.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('journeys refuses before it renders a figure (C4-S4-05)', () => {
  it('branches on the read error before deriving any total', () => {
    const guard = SOURCE.indexOf('if (error)');
    const firstDerivation = SOURCE.indexOf('const events =');
    expect(guard, 'expected an early `if (error)` branch').toBeGreaterThan(-1);
    expect(firstDerivation, 'expected the derivation this guard protects').toBeGreaterThan(-1);
    expect(guard, 'the error branch must come BEFORE the first figure derived from the read')
      .toBeLessThan(firstDerivation);
  });

  it('the headline tiles are not reachable on a failed read', () => {
    const guard = SOURCE.indexOf('if (error)');
    const firstTile = SOURCE.indexOf('<StatTile');
    expect(firstTile, 'expected the StatTile row this rule is about').toBeGreaterThan(-1);
    // `indexOf` returns -1 when the guard is ABSENT, and -1 is less than any
    // index — so asserting only the ordering passes when the guard has been
    // deleted entirely. The first version of this test did exactly that and
    // stayed green while the defect was reintroduced. Assert existence first.
    expect(guard, 'the error branch must exist at all').toBeGreaterThan(-1);
    expect(guard, 'the error branch must come before the first headline tile').toBeLessThan(firstTile);
  });
});
