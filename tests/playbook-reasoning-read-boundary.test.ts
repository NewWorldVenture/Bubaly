import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/playbook/page.tsx', 'utf8');

describe('playbook reasoning read boundary', () => {
  it('keeps the playbook available while surfacing shared reasoning failures', () => {
    expect(page).toContain('loadFamilyContext(supabase, ctx.active.familyId);');
    expect(page).toContain("console.error('[dashboard/playbook] reasoning context read failed'");
    expect(page).toContain("import { ErrorState } from '@/components/ui/states';");
    expect(page).toContain('{reasoningError && (');
    expect(page).toContain('Relationship insights are temporarily unavailable from Supabase. Refresh and try again.');
    expect(page).toContain('<PlaybookModule />');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
