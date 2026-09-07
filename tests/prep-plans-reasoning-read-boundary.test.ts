import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/prep-plans/page.tsx', 'utf8');

describe('Prep Plans reasoning read boundary', () => {
  it('surfaces shared context failures while preserving the planning module', () => {
    expect(page).toContain('let reasoningError = false;');
    expect(page).toContain('reasoning = await loadFamilyContext(supabase, ctx.active.familyId);');
    expect(page).toContain("console.error('[dashboard/prep-plans] reasoning context read failed'");
    expectSays(page, 'prepPlans.relationshipInsightsAreTemporarilyUnavailable', 'Relationship insights are temporarily unavailable from Supabase. Refresh and try again.');
    expect(page).toContain("<ErrorState message={");
    expectSays(page, 'prepPlans.relationshipInsightsAreTemporarilyUnavailable', "Relationship insights are temporarily unavailable from Supabase. Refresh and try again.");
    expect(page).toContain('<PlanningModule />');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
