import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/outcomes/page.tsx', 'utf8');

describe('Outcomes reasoning read boundary', () => {
  it('surfaces shared context failures while preserving the outcome planner', () => {
    expect(page).toContain('let reasoningError = false;');
    expect(page).toContain('reasoning = await loadFamilyContext(supabase, familyId, now);');
    expect(page).toContain("console.error('[dashboard/outcomes] reasoning context read failed'");
    expect(page).toContain('Relationship insights are temporarily unavailable from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message="Relationship insights are temporarily unavailable from Supabase. Refresh and try again." />');
    expect(page).toContain('<OutcomesLauncher plans={plans} />');
    expect(page).not.toContain('loadFamilyContext(supabase, familyId, now).catch(() => null)');
  });
});
