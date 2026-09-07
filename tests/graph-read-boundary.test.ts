import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/graph/page.tsx', 'utf8');
// The failure notice and its retry link are translated, so the page holds KEYS
// where it used to hold the English. Both are still asserted — the key, so the
// notice cannot quietly lose its words, and the catalogue value, so it cannot
// quietly become something else.
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

describe('Knowledge Graph reasoning read boundary', () => {
  it('shows and retries a failed shared context read without changing GraphModule behavior', () => {
    expect(page).toContain('let reasoning: Awaited<ReturnType<typeof loadFamilyContext>> | null = null;');
    expect(page).toContain('reasoning = await loadFamilyContext(supabase, ctx.active.familyId);');
    expect(page).toContain("console.error('[dashboard-graph] reasoning context read failed', error);");
    expect(page).toContain('role="alert"');
    expect(page).toContain("graph.couldNotLoadTheGraph");
    expect(messages['graph.couldNotLoadTheGraph']).toBe('Could not load the graph summary from Supabase.');
    expect(page).toContain('href="/dashboard/graph"');
    expect(page).toContain("graph.retryGraphSummary");
    expect(messages['graph.retryGraphSummary']).toBe('Retry graph summary');
    expect(page).toContain('<GraphModule />');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
