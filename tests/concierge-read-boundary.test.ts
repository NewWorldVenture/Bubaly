import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/concierge/page.tsx', 'utf8');

describe('Concierge reasoning read boundary', () => {
  it('keeps the primary concierge usable while surfacing shared reasoning failures', () => {
    expect(page).toContain('let reasoningError = false;');
    expect(page).toContain('loadFamilyContext(supabase, ctx.active.familyId)');
    expect(page).toContain("console.error('[dashboard/concierge] reasoning context read failed'");
    expectSays(page, 'concierge.relationshipInsightsAreTemporarilyUnavailable', 'Relationship insights are temporarily unavailable from Supabase. Refresh and try again.');
    expect(page).toContain('<ConciergeModule />');
  });
});
