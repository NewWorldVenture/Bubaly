import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

/**
 * Audit C1-S9-25 — two AI routes that answered a family's question at HTTP 200
 * from reads that had not happened.
 *
 * Reported by a parallel worker sweeping the API surface, then re-verified in
 * source before either was touched.
 */
const savings = readFileSync('app/api/ai/savings/route.ts', 'utf8');
const habits = readFileSync('app/api/ai/habits/route.ts', 'utf8');

describe('the savings route does not answer "On track" from a failed read (C1-S9-25)', () => {
  it('checks all four finance reads and refuses rather than reassures', () => {
    // Its own docstring says it "never fabricates numbers" — and it did: a
    // refused `transactions` read emptied the category map, produced no
    // overspending, and reached the deterministic "On track" fallback at 200.
    expect(savings).toContain('const readFailures = (');
    for (const label of ['transactions', 'budgets', 'bills', 'subscriptions']) {
      expect(savings, `${label} must be named in the failure list`).toContain(`['${label}',`);
    }
    expect(savings).toContain('{ status: 503 }');
    // The bail must precede the work it invalidates: the category map, the
    // model context, and the fallback.
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, 'const byCat'));
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, "title: 'On track'"));
  });

  it('bounds the transactions read for real, not with .limit()', () => {
    // `.limit(N)` is not a bound — PostgREST caps at db-max-rows regardless —
    // so an understated over-budget figure would still be stated as fact.
    const read = bodyOf(savings, 'const [txnsResult', ']);');
    expect(read).toContain('readAllAsQuery');
    expect(read).toContain('{ max: 20_000 }');
    expect(read).not.toMatch(/from\('transactions'\)[\s\S]{0,200}?\.limit\(/);
  });
});

describe('the habits route does not compute streaks from a prefix (C1-S9-25)', () => {
  it('checks both reads, including readAll\'s truncation signal', () => {
    // readAll sets `error` for a failed page AND for exceeding `max`, handing
    // back partial rows either way. Dropping it meant "current streak 0" to
    // someone who had not missed a day.
    expect(habits).toMatch(/const \{ rows: logs, error: logsError \}/);
    expect(habits).toMatch(/const \{ data: habits, error: habitsError \}/);
    expect(habits).toContain('if (habitsError || logsError)');
    expect(habits).toContain('{ status: 503 }');
    // Before the streak maths, not after it.
    expect(at(habits, 'if (habitsError || logsError)')).toBeLessThan(at(habits, 'const logsByHabit'));
  });

  it('keeps the real ceiling the earlier fix installed', () => {
    // The `.limit(5000)` that was never 5,000 must not come back.
    expect(habits).toContain('{ max: 5000 }');
    expect(habits).not.toMatch(/from\('habit_logs'\)[\s\S]{0,200}?\.limit\(/);
  });
});
