import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/admin/marketing/visitor-intelligence/page.tsx', 'utf8');

describe('visitor intelligence read boundary', () => {
  it('does not convert analytics query failures into zero-valued metrics', () => {
    expect(page).toContain('const failedMetric = [');
    expect(page).toContain('if (failedMetric)');
    expect(page).toContain('Could not load visitor intelligence from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
