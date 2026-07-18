import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'app/(app)/dashboard/reasoning/page.tsx'), 'utf8');

describe('family reasoning page read boundary', () => {
  it('surfaces degraded source reads instead of presenting an incomplete report as clear', () => {
    expect(page).toContain('const hasReadErrors = report.readErrors.length > 0;');
    expect(page).toContain('Some Family Reasoning data could not be loaded from Supabase. Results may be incomplete. Refresh and try again.');
    expect(page).toContain('report.allClear && !hasReadErrors');
  });
});
