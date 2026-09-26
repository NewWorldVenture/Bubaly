import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A usage limit whose count could not be read must not read as "none used".
 *
 * Four AI routes metered paid model calls by counting today's audit rows —
 * the child and family Money Coach, the Money Mentor, the relationship helper —
 * and a public gift link capped pending pledges the same way:
 *
 *     const { count: usedToday } = await supabase.from(...).select('id', { count: 'exact', head: true })...;
 *     if ((usedToday ?? 0) >= dailyLimit) return 429;
 *
 * A failed count arrives as `{ count: null, error }`, `?? 0` turns it into
 * zero, and the limit is lifted for as long as the read keeps failing. Each now
 * reads the error and refuses. This guard fails any new limit written the old
 * way: a count destructured without its error and then compared with `?? 0`.
 */

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const METERED = [
  'app/api/ai/wallet/child/[childId]/route.ts',
  'app/api/ai/wallet/route.ts',
  'app/api/ai/invest/route.ts',
  'app/api/ai/relationship/route.ts',
  'app/gift/actions.ts',
];

describe('a limit whose count failed is not lifted', () => {
  it('no count is destructured without its error and then compared as `?? 0`', () => {
    const offenders: string[] = [];
    for (const file of [...sources('app'), ...sources('lib')]) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/const \{ count(?:: (\w+))? \} = await/g)) {
        const name = m[1] ?? 'count';
        if (new RegExp(`\\(${name} \\?\\? 0\\) >=`).test(source)) offenders.push(`${file} (${name})`);
      }
    }
    expect(offenders, 'a limit that a failed read lifts').toEqual([]);
  });

  for (const file of METERED) {
    it(`${file} refuses when its meter cannot be read`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/count(?:: \w+)?, error: (?:meterError|countError) \}/);
      expect(source).toMatch(/if \((?:meterError|countError) \|\| \w+ === null\)/);
    });
  }
});
