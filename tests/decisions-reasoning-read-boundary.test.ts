import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/decisions/page.tsx', 'utf8');

describe('decisions reasoning read boundary', () => {
  it('keeps the decision tool available while surfacing shared reasoning failures', () => {
    expect(page).toContain('loadFamilyContext(supabase, ctx.active.familyId);');
    expect(page).toContain("console.error('[dashboard/decisions] reasoning context read failed'");
    expect(page).toContain("import { ErrorState } from '@/components/ui/states';");
    expect(page).toContain('{reasoningError && (');
    expectSays(page, 'decisions.relationshipInsightsAreTemporarilyUnavailable', 'Relationship insights are temporarily unavailable from Supabase. Refresh and try again.');
    expect(page).toContain('<DecisionsModule />');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
