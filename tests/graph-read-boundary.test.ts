import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/graph/page.tsx', 'utf8');

describe('Knowledge Graph reasoning read boundary', () => {
  it('shows and retries a failed shared context read without changing GraphModule behavior', () => {
    expect(page).toContain('let reasoning: Awaited<ReturnType<typeof loadFamilyContext>> | null = null;');
    expect(page).toContain('reasoning = await loadFamilyContext(supabase, ctx.active.familyId);');
    expect(page).toContain("console.error('[dashboard-graph] reasoning context read failed', error);");
    expect(page).toContain('role="alert"');
    expect(page).toContain('Could not load the graph summary from Supabase.');
    expect(page).toContain('href="/dashboard/graph"');
    expect(page).toContain('Retry graph summary');
    expect(page).toContain('<GraphModule />');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
