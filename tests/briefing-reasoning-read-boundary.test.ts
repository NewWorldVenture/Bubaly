import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/briefing/page.tsx', 'utf8');

describe('briefing reasoning read boundary', () => {
  it('keeps required relationship guidance failures visible and retryable', () => {
    // The `try {` this used to assert is gone: the page now runs both reads in
    // one `Promise.allSettled`, so the rejection is handled by branch rather
    // than by catch. The property that matters is unchanged and still asserted —
    // a failed relationship read surfaces its OWN message rather than being
    // swallowed or blurred into the operating-index one.
    expect(page).toContain('loadFamilyContext(supabase, ctx.active.familyId)');
    expect(page).toContain("if (reasoningResult.status === 'rejected')");
    expect(page).toContain("console.error('[dashboard/briefing] reasoning context read failed'");
    expect(page).toContain('Could not load relationship guidance for your daily briefing from Supabase. Refresh and try again.');
    expect(page).toContain('<ErrorState message="Could not load relationship guidance for your daily briefing from Supabase. Refresh and try again." />;');
    expect(page).not.toContain('loadFamilyContext(supabase, ctx.active.familyId).catch(() => null)');
  });
});
