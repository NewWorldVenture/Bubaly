import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/readiness/page.tsx', 'utf8');

// PLA-0770: the headline readiness SCORE must fail closed. If any of its six
// source-of-truth reads errors, the page must render a retryable ErrorState —
// never compute a reassuring-but-wrong score from a partially-failed read
// (a dropped overdue-chores read would otherwise show "all caught up").
describe('readiness score read boundary', () => {
  it('collects the primary read errors and fails visibly', () => {
    expect(page).toContain('const primaryError = [');
    expect(page).toContain('choresOverdueRes.error');
    expect(page).toContain('remindersOverdueRes.error');
    expect(page).toContain('mealsRes.error');
    expect(page).toContain('eventsUpcomingRes.error');
    expect(page).toContain('activeMembersRes.error');
    // No grocery read to guard: the count was fetched, passed into
    // `computeReadiness` and never referenced by the formula, so it was a
    // Supabase query per render for nothing. Both the query and the input
    // field are gone.
    expect(page).not.toMatch(/grocery/i);
    expect(page).toContain('].find(Boolean);');
  });

  it('logs and returns an ErrorState on a primary read failure', () => {
    expect(page).toContain("console.error('[dashboard/readiness] readiness score read failed', primaryError);");
    expect(page).toContain('return <ErrorState message="Could not load your family readiness from Supabase. Refresh and try again." />;');
  });

  it('leaves the forward horizon block best-effort (documented cnt helper)', () => {
    // The enhancement/horizon counts intentionally degrade to 0 — not part of
    // the source-of-truth score — so the best-effort helper must remain.
    expect(page).toContain('const cnt = async (q:');
  });
});
