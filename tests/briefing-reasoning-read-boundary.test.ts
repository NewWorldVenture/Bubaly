import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/briefing/page.tsx', 'utf8');

describe('briefing reasoning read boundary', () => {
  it('keeps required relationship guidance failures visible and retryable', () => {
    expect(page).toContain('try {');
    expect(page).toContain('loadFamilyContext(supabase, ctx.active.familyId)');
    expect(page).toContain("console.error('[dashboard/briefing] reasoning context read failed'");
    expect(page).toContain('Could not load relationship guidance for your daily briefing from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message="Could not load relationship guidance for your daily briefing from Supabase. Refresh and try again." />;');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
