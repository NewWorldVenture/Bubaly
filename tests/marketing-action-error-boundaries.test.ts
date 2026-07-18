import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sources = [
  'app/(app)/admin/marketing/actions.ts',
  'app/(app)/admin/marketing/affiliates/actions.ts',
  'app/(app)/admin/marketing/surveys/actions.ts',
];

describe('privileged marketing action error boundaries', () => {
  it('routes every audited mutation cluster through the sanitized failure helper', () => {
    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('marketingActionFailure');
      expect(source, path).not.toContain('throw new Error(error?.message');
      expect(source, path).not.toMatch(/if \(error\) console\.error/);
    }
  });

  it('covers all marketing mutation branches, including affiliate payout and survey controls', () => {
    const counts = sources.map((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(/marketingActionFailure/g)].length;
    });

    // Includes the import plus each guarded failure branch.
    expect(counts).toEqual([45, 6, 4]);
    expect(readFileSync('lib/marketing/admin.ts', 'utf8')).toContain('describeActionError');
  });
});
