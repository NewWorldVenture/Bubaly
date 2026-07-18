import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/agents/page.tsx', 'utf8');

describe('dashboard agents read boundary', () => {
  it('fails visibly when required context or count reads cannot be read', () => {
    expect(page).toContain('type CountResult = { value: number; error: unknown | null };');
    expect(page).toContain('const readError = weekEvents.error ?? mealPlans.error ?? members.error ?? activityRows.error');
    expect(page).toContain('if (readError) {');
    expect(page).toContain('loadFamilyContext(supabase, familyId, now)');
    expect(page).toContain("console.error('[dashboard-agents] reasoning context read failed'");
    expect(page).toContain('Could not load Family Assistant context from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message=');
  });
});
